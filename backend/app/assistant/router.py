from __future__ import annotations

import base64
import json
import random
import re
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.comfy.client import ComfyUIClient
from app.config import settings
from app.db import StudioDatabase
from app.runs.tracker import RunExecutionTracker
from app.templates.compiler import compile_workflow_to_api_prompt
from app.templates.inspector import TemplateCatalogInspector
from app.templates.parameters import extract_template_parameters

# Verified Ready templates and their human-friendly descriptions for the LLM router
READY_ROUTING_CATALOG: list[dict[str, str]] = [
    {
        "template_id": "image_qwen_image_edit_2509",
        "title": "Qwen Image Edit 2509 (Fast 4-Step Edit)",
        "when_to_use": (
            "Best for fast single-image instruction editing, object replacement, "
            "localized inpainting, restyling, lighting changes, or adding/modifying items."
        ),
    },
    {
        "template_id": "image_qwen_image_2_1_background_removal",
        "title": "Qwen Image 2.1: Subject Isolation & Background Removal",
        "when_to_use": (
            "Best for removing backgrounds, cutting out subjects, isolating a specific "
            "character or group of characters from a photo, or high-precision Qwen 2.1 single-image edits."
        ),
    },
    {
        "template_id": "image_qwen_image_2_1_image_edit",
        "title": "Qwen Image 2.1: Multi-Reference Image Edit",
        "when_to_use": (
            "Best when editing an image using a second reference image (e.g., costume swap, "
            "style transfer from a second image) or detailed Qwen 2.1 instruction editing."
        ),
    },
    {
        "template_id": "image_z_image_turbo",
        "title": "Z-Image-Turbo: Text to Image",
        "when_to_use": (
            "Best for generating a brand-new photorealistic or artistic image from scratch "
            "(when the canvas is empty or the user asks to generate a new image/texture)."
        ),
    },
    {
        "template_id": "image_krea2_turbo_t2i",
        "title": "Krea-2: Text to Image",
        "when_to_use": (
            "Best for stylized, cinematic, or surreal text-to-image generation from scratch."
        ),
    },
    {
        "template_id": "utility_interpolation_image_upscale",
        "title": "Image Upscale: Traditional Interpolation",
        "when_to_use": "Best when the user asks to upscale, enlarge, or increase image resolution.",
    },
    {
        "template_id": "video_wan2_2_14B_i2v",
        "title": "Wan 2.2 14B: Image to Video",
        "when_to_use": "Best when the user wants to animate the current photo into a video clip.",
    },
    {
        "template_id": "video_wan2_2_14B_t2v",
        "title": "Wan 2.2 14B: Text to Video",
        "when_to_use": "Best when generating a video clip from text without an input image.",
    },
    {
        "template_id": "video_wan2_2_14B_flf2v",
        "title": "Wan 2.2 14B: First-Last Frame to Video",
        "when_to_use": "Best when morphing or transitioning between a start image and an end image.",
    },
    {
        "template_id": "video_minimax_h3_i2v_continuation",
        "title": "MiniMax H3: Video Continuation",
        "when_to_use": "Best for extending or continuing an existing video clip from its last frame.",
    },
    {
        "template_id": "3d_hunyuan3d-v2.1",
        "title": "Hunyuan3D 2.1: Single View to 3D Model",
        "when_to_use": (
            "Best when the user asks to convert an isolated character, object, or photo into a 3D mesh (.glb)."
        ),
    },
]


class ChatMessageItem(BaseModel):
    role: str
    content: str


class AssistantChatRequest(BaseModel):
    message: str
    history: list[ChatMessageItem] = Field(default_factory=list)
    canvas_image_b64: str | None = None
    canvas_filename: str | None = None
    second_image_b64: str | None = None
    second_filename: str | None = None
    has_mask: bool = False
    mask_bbox_hint: str | None = None
    auto_pilot: bool = False


class AssistantExecuteRequest(BaseModel):
    template_id: str
    prompt: str = ""
    negative_prompt: str = ""
    canvas_image_b64: str | None = None
    canvas_filename: str | None = None
    second_image_b64: str | None = None
    second_filename: str | None = None
    denoise: float | None = None
    extra_fields: dict[str, Any] = Field(default_factory=dict)


class Studio3DPipelineRequest(BaseModel):
    """Orchestrates Character/Group Isolation -> 3D Mesh + UV Texture/Color + 2D Render."""

    canvas_image_b64: str | None = None
    canvas_filename: str | None = None
    texture_image_b64: str | None = None
    texture_filename: str | None = None
    stage: str = "3d_and_render"  # "isolate_only" | "3d_and_render"
    isolation_target: str = "main_character"  # "main_character" | "group" | "masked" | "custom"
    isolation_prompt: str = ""
    figurine_prepass: bool = False
    apply_texture: bool = True
    render_mode: str = "texture"  # "texture" | "solid" | "normal" | "auto"
    background_color: str = "#111827"
    resolution: int = 4096
    octree_resolution: int = 256
    steps: int = 30


def _decode_base64_image(data_url_or_b64: str) -> tuple[bytes, str]:
    """Return raw image bytes and file extension from a data URL or base64 string."""
    raw = data_url_or_b64.strip()
    ext = "png"
    if raw.startswith("data:"):
        header, _, payload = raw.partition(",")
        if "jpeg" in header or "jpg" in header:
            ext = "jpg"
        elif "webp" in header:
            ext = "webp"
        raw = payload
    return base64.b64decode(raw), ext


async def _ensure_uploaded_image(
    comfy: ComfyUIClient,
    image_b64: str | None,
    existing_filename: str | None,
    prefix: str = "studio_canvas",
) -> str | None:
    """Upload a base64 image to ComfyUI's input directory or return existing filename."""
    if image_b64:
        img_bytes, ext = _decode_base64_image(image_b64)
        fname = f"{prefix}_{uuid.uuid4().hex[:8]}.{ext}"
        mime = "image/jpeg" if ext == "jpg" else f"image/{ext}"
        res = await comfy.upload_image(
            filename=fname,
            content=img_bytes,
            content_type=mime,
            overwrite=True,
        )
        return res.get("name") or fname
    if existing_filename:
        return existing_filename
    return None


def map_intent_to_template_fields(
    template_id: str,
    prompt: str,
    image_filename: str | None = None,
    second_image_filename: str | None = None,
    negative_prompt: str = "",
    denoise: float | None = None,
    workflow: dict[str, Any] | None = None,
    obj_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Map universal (prompt, image_filename, second_image_filename) to template-specific node keys."""
    fields: dict[str, Any] = {}

    if template_id == "image_qwen_image_edit_2509":
        if prompt:
            fields["433:111.prompt"] = prompt
        if image_filename:
            fields["78.image"] = image_filename
        if denoise is not None:
            fields["433:3.denoise"] = float(denoise)
    elif template_id == "image_qwen_image_2_1_background_removal":
        fields["459:474.prompt"] = prompt or "Remove the background, and output a PNG image"
        if image_filename:
            fields["470.image"] = image_filename
        if negative_prompt:
            fields["459:474.negative_prompt"] = negative_prompt
        if denoise is not None:
            fields["459:458.denoise"] = float(denoise)
    elif template_id == "image_qwen_image_2_1_image_edit":
        effective_prompt = prompt or "Enhance and refine the image while preserving the subject"
        fields["459:484.on_false"] = effective_prompt
        fields["459:500.prompt"] = effective_prompt
        if image_filename:
            fields["470.image"] = image_filename
            fields["475.image"] = second_image_filename or image_filename
    elif template_id == "image_z_image_turbo":
        if prompt:
            fields["57:27.text"] = prompt
    elif template_id == "image_krea2_turbo_t2i":
        if prompt:
            fields["30:19.value"] = prompt
    elif template_id == "video_wan2_2_14B_i2v":
        if prompt:
            fields["129:93.text"] = prompt
        if image_filename:
            fields["97.image"] = image_filename
        if negative_prompt:
            fields["129:89.text"] = negative_prompt
    elif template_id == "video_wan2_2_14B_t2v":
        if prompt:
            fields["128:89.text"] = prompt
        if negative_prompt:
            fields["128:72.text"] = negative_prompt
    elif template_id == "video_wan2_2_14B_flf2v":
        if prompt:
            fields["90.text"] = prompt
        if image_filename:
            fields["80.image"] = image_filename
        if second_image_filename or image_filename:
            fields["89.image"] = second_image_filename or image_filename
        if negative_prompt:
            fields["78.text"] = negative_prompt
    elif template_id in ("video_minimax_h3_i2v", "video_minimax_h3_i2v_continuation"):
        if prompt:
            fields["105:104.prompt"] = prompt
        if image_filename:
            fields["114.image"] = image_filename
    elif template_id in ("3d_hunyuan3d-v2.1", "utility_interpolation_image_upscale"):
        if image_filename:
            fields["2.image"] = image_filename

    # Generic fallback for any other template in the catalog
    if not fields and workflow is not None:
        params = extract_template_parameters(workflow, obj_info or {})
        img_assigned = False
        prompt_assigned = False
        for p in params:
            k_lower = p.key.lower()
            lbl_lower = p.label.lower()
            if (
                image_filename
                and not img_assigned
                and (k_lower.endswith(".image") or "load image" in lbl_lower)
            ):
                fields[p.key] = image_filename
                img_assigned = True
            elif (
                prompt
                and not prompt_assigned
                and "negative" not in lbl_lower
                and (
                    k_lower.endswith(".prompt")
                    or k_lower.endswith(".text")
                    or "prompt" in lbl_lower
                )
            ):
                fields[p.key] = prompt
                prompt_assigned = True

    return fields


def deterministic_route(
    user_message: str,
    has_image: bool,
    has_mask: bool,
    has_second_image: bool = False,
) -> dict[str, Any]:
    """Fast deterministic router fallback and baseline decision maker."""
    msg = user_message.strip()
    low = msg.lower()

    # Check if purely conversational question
    if low.startswith(("what is", "how do i", "explain", "can you tell me", "who ")) and not any(
        w in low
        for w in (
            "make",
            "change",
            "remove",
            "generate",
            "create",
            "isolate",
            "turn",
            "convert",
            "animate",
            "upscale",
            "replace",
            "edit",
            "add",
        )
    ):
        return {
            "action": "chat",
            "template_id": None,
            "prompt": "",
            "post_process": "none",
            "reply": (
                "I'm your ComfyUI Creative Copilot! Load an image onto the canvas or ask me to "
                "generate a photo, edit an area with the inpaint brush, isolate a character/group, "
                "build a textured 3D model, or animate a scene."
            ),
        }

    # 1. 3D Model / Mesh intent
    if any(w in low for w in ("3d", "mesh", "glb", "figurine", "statue")):
        return {
            "action": "execute",
            "template_id": "3d_hunyuan3d-v2.1",
            "prompt": msg,
            "post_process": "3d_pipeline",
            "reply": (
                "Routing to **Hunyuan3D 2.1 + ComfyUI 3D Texture & Render Pipeline** to generate "
                "a 3D mesh (.glb) and 2D studio render from your subject."
            ),
        }

    # 2. Character / Group Isolation or Background Removal
    if any(
        w in low
        for w in (
            "remove bg",
            "remove background",
            "remove the background",
            "cut out",
            "cutout",
            "transparent",
            "isolate",
        )
    ):
        if "group" in low or "characters" in low or "people" in low:
            crafted = (
                f"{msg}. Isolate the central group of characters cleanly, remove all background "
                "clutter and bystanders, and place them on a clean solid studio background."
            )
        elif "character" in low or "person" in low or "subject" in low:
            crafted = (
                f"{msg}. Isolate only the target character in the foreground, remove all background "
                "objects, and output a clean studio cutout PNG."
            )
        else:
            crafted = "Remove the background, and output a PNG image"
        return {
            "action": "execute",
            "template_id": "image_qwen_image_2_1_background_removal",
            "prompt": crafted,
            "post_process": "feathered_mask_composite" if has_mask else "replace_canvas",
            "reply": (
                "Routing to **Qwen Image 2.1: Subject Isolation & Background Removal** "
                f"(`image_qwen_image_2_1_background_removal`) with prompt: *\"{crafted}\"*."
            ),
        }

    # 3. Video / Animation intent
    if any(w in low for w in ("animate", "video", "motion", "cinematic movement", "camera pan")):
        if has_image and has_second_image:
            return {
                "action": "execute",
                "template_id": "video_wan2_2_14B_flf2v",
                "prompt": msg,
                "post_process": "video_output",
                "reply": "Routing to **Wan 2.2 14B First-Last Frame to Video** (`video_wan2_2_14B_flf2v`).",
            }
        if has_image:
            return {
                "action": "execute",
                "template_id": "video_wan2_2_14B_i2v",
                "prompt": msg,
                "post_process": "video_output",
                "reply": "Routing to **Wan 2.2 14B Image to Video** (`video_wan2_2_14B_i2v`) to animate your canvas.",
            }
        return {
            "action": "execute",
            "template_id": "video_wan2_2_14B_t2v",
            "prompt": msg,
            "post_process": "video_output",
            "reply": "Routing to **Wan 2.2 14B Text to Video** (`video_wan2_2_14B_t2v`).",
        }

    # 4. Upscale intent
    if any(w in low for w in ("upscale", "2x", "4x", "higher resolution", "enlarge")):
        return {
            "action": "execute",
            "template_id": "utility_interpolation_image_upscale",
            "prompt": msg,
            "post_process": "replace_canvas",
            "reply": "Routing to **Image Upscale** (`utility_interpolation_image_upscale`).",
        }

    # 5. Image loaded on canvas -> Instruction Edit or Localized Inpainting
    if has_image and not any(
        w in low for w in ("from scratch", "new image", "blank canvas", "generate a new")
    ):
        if has_second_image:
            return {
                "action": "execute",
                "template_id": "image_qwen_image_2_1_image_edit",
                "prompt": msg,
                "post_process": "feathered_mask_composite" if has_mask else "replace_canvas",
                "reply": (
                    "Routing to **Qwen Image 2.1: Multi-Reference Image Edit** "
                    "(`image_qwen_image_2_1_image_edit`)."
                ),
            }
        # Prefer Qwen Image 2.1 single-image edit (via background_removal graph) or Qwen Edit 2509
        chosen_tid = (
            "image_qwen_image_2_1_background_removal"
            if any(w in low for w in ("qwen 2.1", "high quality", "detailed", "background", "color"))
            else "image_qwen_image_edit_2509"
        )
        mask_note = (
            " with **Feathered Mask Alpha-Compositing** (only your painted mask region will change)"
            if has_mask
            else ""
        )
        return {
            "action": "execute",
            "template_id": chosen_tid,
            "prompt": msg,
            "post_process": "feathered_mask_composite" if has_mask else "replace_canvas",
            "reply": (
                f"Routing to **{chosen_tid}**{mask_note} with instruction: *\"{msg}\"*."
            ),
        }

    # 6. Default: Text-to-Image generation
    chosen_t2i = (
        "image_krea2_turbo_t2i"
        if any(w in low for w in ("krea", "surreal", "artistic", "illustration", "darkbrush"))
        else "image_z_image_turbo"
    )
    return {
        "action": "execute",
        "template_id": chosen_t2i,
        "prompt": msg,
        "post_process": "replace_canvas",
        "reply": f"Routing to **{chosen_t2i}** to generate a new image on your canvas.",
    }


async def query_lemonade_router(
    ai_url: str,
    ai_model: str,
    req: AssistantChatRequest,
    baseline: dict[str, Any],
) -> dict[str, Any]:
    """Ask Lemonade (Qwen3.8-27B) to refine the routing decision and prompt in <2s."""
    catalog_text = "\n".join(
        f"- {item['template_id']}: {item['title']} — {item['when_to_use']}"
        for item in READY_ROUTING_CATALOG
    )
    canvas_state = (
        "Image loaded WITH a user-painted Inpaint Mask"
        if (req.canvas_image_b64 or req.canvas_filename) and req.has_mask
        else "Image loaded on canvas (no mask)"
        if (req.canvas_image_b64 or req.canvas_filename)
        else "Blank/empty canvas (no image loaded yet)"
    )
    if req.mask_bbox_hint:
        canvas_state += f" (Mask region: {req.mask_bbox_hint})"

    system_prompt = (
        "You are the AI Creative Copilot inside ComfyUI Studio. "
        "Your job is to inspect the user's request and current canvas state, pick the single best "
        "Ready ComfyUI template_id from the catalog below, write an enhanced diffusion/editing prompt, "
        "and return ONLY valid JSON.\n\n"
        f"CURRENT CANVAS STATE: {canvas_state}\n\n"
        f"AVAILABLE READY TEMPLATES:\n{catalog_text}\n\n"
        "Respond with a JSON object matching this exact schema:\n"
        "{\n"
        '  "action": "execute" | "chat",\n'
        '  "template_id": "<one of the template_ids above, or null if action is chat>",\n'
        '  "prompt": "<the exact instruction or generation prompt to send to ComfyUI>",\n'
        '  "post_process": "replace_canvas" | "feathered_mask_composite" | "3d_pipeline" | "video_output" | "none",\n'
        '  "reply": "<concise 1-2 sentence friendly explanation of what you are doing>"\n'
        "}\n"
        "Rules:\n"
        "1. If an image is loaded and the user wants to edit, modify, recolor, or replace something, "
        "choose 'image_qwen_image_edit_2509' or 'image_qwen_image_2_1_background_removal'.\n"
        "2. If a mask is painted on the canvas, set post_process to 'feathered_mask_composite'.\n"
        "3. If the user wants to isolate a character/group or remove the background, choose "
        "'image_qwen_image_2_1_background_removal' and write a clear prompt describing who to isolate.\n"
        "4. If the user wants a 3D model/mesh/render, choose '3d_hunyuan3d-v2.1' and post_process '3d_pipeline'."
    )

    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for h in req.history[-4:]:
        messages.append({"role": h.role, "content": h.content})
    messages.append({"role": "user", "content": req.message})

    payload = {
        "model": ai_model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 350,
        "chat_template_kwargs": {"enable_thinking": False},
    }

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(f"{ai_url.rstrip('/')}/chat/completions", json=payload)
            resp.raise_for_status()
            data = resp.json()
            choice = (data.get("choices") or [{}])[0].get("message") or {}
            content = (choice.get("content") or "").strip()
            if not content:
                return baseline

            # Extract JSON block if wrapped in markdown fences
            fence_match = re.search(r"\{[\s\S]*\}", content)
            if fence_match:
                parsed = json.loads(fence_match.group(0))
                valid_ids = {c["template_id"] for c in READY_ROUTING_CATALOG}
                tid = parsed.get("template_id")
                if parsed.get("action") == "chat":
                    return {
                        "action": "chat",
                        "template_id": None,
                        "prompt": "",
                        "post_process": "none",
                        "reply": parsed.get("reply") or content,
                    }
                if tid in valid_ids:
                    return {
                        "action": "execute",
                        "template_id": tid,
                        "prompt": parsed.get("prompt") or baseline["prompt"] or req.message,
                        "post_process": (
                            "feathered_mask_composite"
                            if req.has_mask and tid.startswith("image_qwen")
                            else (parsed.get("post_process") or baseline["post_process"])
                        ),
                        "reply": parsed.get("reply") or baseline["reply"],
                    }
    except Exception:
        pass

    return baseline


def build_textured_3d_api_prompt(
    subject_image_filename: str,
    texture_image_filename: str | None = None,
    apply_texture: bool = True,
    render_mode: str = "texture",
    background_color: str = "#111827",
    resolution: int = 4096,
    octree_resolution: int = 256,
    steps: int = 30,
    seed: int | None = None,
) -> dict[str, Any]:
    """
    Build a ComfyUI API graph using installed Hunyuan3D 2.1 + native GPU 3D nodes:
    - Generates 3D mesh from `subject_image_filename`
    - Smooths normals (`MeshSmoothNormals`)
    - Optionally UVs (`UnwrapMesh`) and applies a color/texture map (`ApplyTextureToMesh`)
    - Saves the `.glb` (`SaveGLB`) AND renders a 1024x1024 2D beauty shot (`RenderMesh` -> `SaveImage`)
    """
    actual_seed = seed if seed is not None else random.randint(1, 999999999999999)
    tex_file = texture_image_filename or subject_image_filename

    graph: dict[str, Any] = {
        "1": {
            "class_type": "ImageOnlyCheckpointLoader",
            "inputs": {"ckpt_name": "hunyuan_3d_v2.1.safetensors"},
        },
        "2": {
            "class_type": "LoadImage",
            "inputs": {"image": subject_image_filename},
        },
        "3": {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {"shift": 1.0, "sampling": "flow", "model": ["1", 0]},
        },
        "4": {
            "class_type": "CLIPVisionEncode",
            "inputs": {"crop": "center", "clip_vision": ["1", 1], "image": ["2", 0]},
        },
        "5": {
            "class_type": "Hunyuan3Dv2Conditioning",
            "inputs": {"clip_vision_output": ["4", 0]},
        },
        "6": {
            "class_type": "EmptyLatentHunyuan3Dv2",
            "inputs": {"resolution": int(resolution), "batch_size": 1},
        },
        "7": {
            "class_type": "KSampler",
            "inputs": {
                "seed": actual_seed,
                "steps": int(steps),
                "cfg": 5.0,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
                "model": ["3", 0],
                "positive": ["5", 0],
                "negative": ["5", 1],
                "latent_image": ["6", 0],
            },
        },
        "8": {
            "class_type": "VAEDecodeHunyuan3D",
            "inputs": {
                "num_chunks": 8000,
                "octree_resolution": int(octree_resolution),
                "samples": ["7", 0],
                "vae": ["1", 2],
            },
        },
        "9": {
            "class_type": "VoxelToMesh",
            "inputs": {
                "algorithm": "surface net",
                "threshold": 0.6,
                "voxel": ["8", 0],
            },
        },
        "10": {
            "class_type": "MeshSmoothNormals",
            "inputs": {
                "mesh": ["9", 0],
                "crease_angle": 160.0,
            },
        },
    }

    final_mesh_node = "10"

    if apply_texture:
        graph["11"] = {
            "class_type": "LoadImage",
            "inputs": {"image": tex_file},
        }
        graph["12"] = {
            "class_type": "UnwrapMesh",
            "inputs": {
                "mesh": ["10", 0],
                "segmenter": "pec",
                "resolution": 1024,
                "padding": 2,
                "weld_distance": 0.001,
            },
        }
        graph["13"] = {
            "class_type": "ApplyTextureToMesh",
            "inputs": {
                "mesh": ["12", 0],
                "base_color": ["11", 0],
            },
        }
        final_mesh_node = "13"

    graph["14"] = {
        "class_type": "SaveGLB",
        "inputs": {
            "filename_prefix": "3d/Studio_3D",
            "mesh": [final_mesh_node, 0],
        },
    }
    effective_render_mode = (
        render_mode if render_mode in ("auto", "texture", "vertex colors", "solid", "normal", "depth") else "auto"
    )
    if not apply_texture and effective_render_mode == "texture":
        effective_render_mode = "solid"

    graph["15"] = {
        "class_type": "RenderMesh",
        "inputs": {
            "mesh": [final_mesh_node, 0],
            "mode": effective_render_mode,
            "width": 1024,
            "height": 1024,
            "background": background_color or "#111827",
        },
    }
    graph["16"] = {
        "class_type": "SaveImage",
        "inputs": {
            "filename_prefix": "Studio_3D_Render",
            "images": ["15", 0],
        },
    }
    return graph


def create_assistant_router(
    db: StudioDatabase,
    comfy_client: ComfyUIClient,
    inspector: TemplateCatalogInspector,
    run_tracker: RunExecutionTracker,
) -> APIRouter:
    router = APIRouter(prefix="/api/assistant", tags=["assistant"])

    async def _execute_template_plan(
        template_id: str,
        prompt: str,
        canvas_image_b64: str | None = None,
        canvas_filename: str | None = None,
        second_image_b64: str | None = None,
        second_filename: str | None = None,
        negative_prompt: str = "",
        denoise: float | None = None,
        extra_fields: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        uploaded_primary = await _ensure_uploaded_image(
            comfy_client, canvas_image_b64, canvas_filename, prefix="studio_canvas"
        )
        uploaded_secondary = await _ensure_uploaded_image(
            comfy_client, second_image_b64, second_filename, prefix="studio_ref"
        )

        obj_info: dict[str, Any] = {}
        try:
            obj_info = await comfy_client.get_object_info()
        except Exception:
            pass
        available_nodes = set(obj_info.keys()) if obj_info else None

        try:
            summary = inspector.get_template(
                template_id,
                available_nodes=available_nodes,
                installed_ids=db.list_installed_ids(),
            )
            workflow, _ = inspector.load_workflow_json(template_id)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail=f"Template not found: {template_id}") from exc

        if summary.io_inputs:
            inspector.stage_sample_inputs(template_id, summary.io_inputs)

        mapped_fields = map_intent_to_template_fields(
            template_id=template_id,
            prompt=prompt,
            image_filename=uploaded_primary,
            second_image_filename=uploaded_secondary,
            negative_prompt=negative_prompt,
            denoise=denoise,
            workflow=workflow,
            obj_info=obj_info,
        )
        if extra_fields:
            mapped_fields.update(extra_fields)

        api_prompt = compile_workflow_to_api_prompt(
            workflow, obj_info, field_overrides=mapped_fields
        )
        if not api_prompt:
            raise HTTPException(
                status_code=400,
                detail=f"Template '{template_id}' did not compile into executable ComfyUI nodes",
            )

        run_rec = await run_tracker.start_run(
            template_id=template_id,
            template_title=summary.title,
            fields=mapped_fields,
            api_prompt=api_prompt,
        )
        return {
            "run": run_rec,
            "uploaded_filename": uploaded_primary,
            "fields": mapped_fields,
        }

    @router.get("/catalog")
    async def get_routing_catalog() -> dict[str, Any]:
        return {"catalog": READY_ROUTING_CATALOG}

    @router.post("/chat")
    async def assistant_chat(req: AssistantChatRequest) -> dict[str, Any]:
        ai_url = db.get_setting("ai_engine_url") or settings.ai_engine_url
        ai_model = db.get_setting("ai_engine_model") or settings.ai_engine_model

        has_image = bool(req.canvas_image_b64 or req.canvas_filename)
        has_second = bool(req.second_image_b64 or req.second_filename)

        baseline = deterministic_route(
            user_message=req.message,
            has_image=has_image,
            has_mask=req.has_mask,
            has_second_image=has_second,
        )
        decision = await query_lemonade_router(
            ai_url=ai_url,
            ai_model=ai_model,
            req=req,
            baseline=baseline,
        )

        run_result = None
        if req.auto_pilot and decision.get("action") == "execute" and decision.get("template_id"):
            try:
                if decision.get("post_process") == "3d_pipeline" and has_image:
                    uploaded_primary = await _ensure_uploaded_image(
                        comfy_client,
                        req.canvas_image_b64,
                        req.canvas_filename,
                        prefix="studio_3d_subj",
                    )
                    if uploaded_primary:
                        api_prompt = build_textured_3d_api_prompt(
                            subject_image_filename=uploaded_primary,
                            texture_image_filename=uploaded_primary,
                            apply_texture=True,
                            render_mode="texture",
                        )
                        run_rec = await run_tracker.start_run(
                            template_id="3d_hunyuan3d-v2.1",
                            template_title="3D Textured Mesh & Render (Hunyuan3D 2.1)",
                            fields={"subject_image": uploaded_primary, "apply_texture": True},
                            api_prompt=api_prompt,
                        )
                        run_result = {"run": run_rec, "uploaded_filename": uploaded_primary}
                else:
                    run_result = await _execute_template_plan(
                        template_id=decision["template_id"],
                        prompt=decision.get("prompt") or req.message,
                        canvas_image_b64=req.canvas_image_b64,
                        canvas_filename=req.canvas_filename,
                        second_image_b64=req.second_image_b64,
                        second_filename=req.second_filename,
                    )
            except Exception as exc:
                decision["execution_error"] = str(exc)

        return {
            "reply": decision.get("reply") or baseline["reply"],
            "plan": {
                "action": decision.get("action", "execute"),
                "template_id": decision.get("template_id"),
                "prompt": decision.get("prompt") or req.message,
                "post_process": decision.get("post_process", "replace_canvas"),
            },
            "auto_executed": bool(run_result),
            "run": run_result["run"] if run_result else None,
            "uploaded_filename": run_result.get("uploaded_filename") if run_result else None,
            "ai_engine_model": ai_model,
        }

    @router.post("/execute")
    async def assistant_execute(req: AssistantExecuteRequest) -> dict[str, Any]:
        res = await _execute_template_plan(
            template_id=req.template_id,
            prompt=req.prompt,
            canvas_image_b64=req.canvas_image_b64,
            canvas_filename=req.canvas_filename,
            second_image_b64=req.second_image_b64,
            second_filename=req.second_filename,
            negative_prompt=req.negative_prompt,
            denoise=req.denoise,
            extra_fields=req.extra_fields,
        )
        return res

    @router.post("/3d-pipeline")
    async def execute_3d_pipeline(req: Studio3DPipelineRequest) -> dict[str, Any]:
        uploaded_subj = await _ensure_uploaded_image(
            comfy_client, req.canvas_image_b64, req.canvas_filename, prefix="studio_3d_subj"
        )
        if not uploaded_subj:
            raise HTTPException(
                status_code=400,
                detail="Please load or provide an image on the canvas first.",
            )

        # Stage 1: Isolate character or group & remove background via Qwen Image 2.1
        if req.stage == "isolate_only":
            if req.isolation_prompt.strip():
                iso_prompt = req.isolation_prompt.strip()
            elif req.isolation_target == "group":
                iso_prompt = (
                    "Isolate the central group of characters together, remove all background "
                    "clutter and bystanders, and place them on a clean solid white studio background"
                )
            elif req.isolation_target == "masked":
                iso_prompt = (
                    "Remove the background around the main subject, and output a clean studio PNG image"
                )
            else:
                iso_prompt = (
                    "Isolate the main character in the foreground, remove the background and all "
                    "other objects, and output a clean studio PNG image"
                )
            if req.figurine_prepass:
                iso_prompt += (
                    ", rendered as a clean, evenly lit 3D collectible figurine with clear surface details"
                )

            res = await _execute_template_plan(
                template_id="image_qwen_image_2_1_background_removal",
                prompt=iso_prompt,
                canvas_filename=uploaded_subj,
            )
            return {
                "stage": "isolate_only",
                "prompt": iso_prompt,
                "run": res["run"],
                "uploaded_filename": uploaded_subj,
            }

        # Stage 2: 3D Mesh + UV Unwrap + Texture/Color Application + 2D Render
        uploaded_tex = await _ensure_uploaded_image(
            comfy_client, req.texture_image_b64, req.texture_filename, prefix="studio_3d_tex"
        )
        api_prompt = build_textured_3d_api_prompt(
            subject_image_filename=uploaded_subj,
            texture_image_filename=uploaded_tex or uploaded_subj,
            apply_texture=req.apply_texture,
            render_mode=req.render_mode,
            background_color=req.background_color,
            resolution=req.resolution,
            octree_resolution=req.octree_resolution,
            steps=req.steps,
        )
        title = (
            "Hunyuan3D 2.1: Textured 3D Mesh + 2D Studio Render"
            if req.apply_texture
            else "Hunyuan3D 2.1: 3D Clay Mesh + 2D Studio Render"
        )
        run_rec = await run_tracker.start_run(
            template_id="3d_hunyuan3d-v2.1",
            template_title=title,
            fields={
                "2.image": uploaded_subj,
                "apply_texture": req.apply_texture,
                "render_mode": req.render_mode,
                "resolution": req.resolution,
            },
            api_prompt=api_prompt,
        )
        return {
            "stage": "3d_and_render",
            "run": run_rec,
            "uploaded_filename": uploaded_subj,
            "texture_filename": uploaded_tex or uploaded_subj,
        }

    return router
