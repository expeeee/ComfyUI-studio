from __future__ import annotations

import asyncio
import datetime as dt
import random
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile

from app.comfy.client import ComfyUIClient
from app.config import settings
from app.db import StudioDatabase
from app.runs.tracker import RunExecutionTracker
from app.templates.compiler import compile_workflow_to_api_prompt
from app.templates.inspector import TemplateCatalogInspector, TemplateSummary
from app.templates.parameters import extract_template_parameters


def _iso_from_ts(ts: float | None = None) -> str:
    val = ts if ts is not None else dt.datetime.now(dt.timezone.utc).timestamp()
    return (
        dt.datetime.fromtimestamp(val, tz=dt.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _aspect_and_res_to_size(aspect: str | None, resolution: str | None) -> tuple[int, int]:
    base = 1024 if resolution in ("ten_eighty_p", "two_k", "four_k", "high", "large") else 1024
    if aspect in ("wide_sixteen_by_nine", "sixteen_by_nine", "16:9"):
        return base, (int(base * 9 / 16) // 16) * 16
    if aspect in ("tall_nine_by_sixteen", "nine_by_sixteen", "9:16"):
        return (int(base * 9 / 16) // 16) * 16, base
    if aspect in ("four_by_three", "4:3"):
        return base, (int(base * 3 / 4) // 16) * 16
    if aspect in ("three_by_four", "3:4"):
        return (int(base * 3 / 4) // 16) * 16, base
    return base, base


def _ext_to_media_type(filename: str, media_kind: str) -> tuple[str, str]:
    ext = Path(filename).suffix.lower().lstrip(".")
    if media_kind == "video" or ext in ("mp4", "webm", "mov"):
        return "video", ext if ext in ("mp4", "webm", "mov") else "mp4"
    if media_kind == "audio" or ext in ("mp3", "wav", "ogg", "flac", "m4a"):
        return "audio", ext if ext in ("mp3", "wav", "ogg", "flac", "m4a") else "mp3"
    if media_kind == "3d" or ext in ("glb", "gltf", "obj", "fbx", "ply", "spz"):
        if ext in ("ply", "spz"):
            return "splat", ext
        return "mesh", ext if ext in ("glb", "gltf", "obj", "fbx") else "glb"
    return "image", "jpg" if ext == "jpeg" else (ext if ext in ("png", "jpg", "webp", "gif") else "png")


def _session_user_payload() -> dict[str, Any]:
    core_info = {
        "user_token": "u_local_comfyui_studio",
        "username": "local_comfyui",
        "display_name": "Local ComfyUI Studio",
        "gravatar_hash": "00000000000000000000000000000000",
        "default_avatar": {"image_index": 0, "color_index": 0},
    }
    return {
        "core_info": core_info,
        "user_token": "u_local_comfyui_studio",
        "username": "local_comfyui",
        "display_name": "Local ComfyUI Studio",
        "email_gravatar_hash": "00000000000000000000000000000000",
        "onboarding": {
            "email_not_set": False,
            "email_not_confirmed": False,
            "password_not_set": False,
            "username_not_customized": False,
        },
        "can_access_studio": True,
        "maybe_feature_flags": [],
        "fakeyou_plan": "pro",
        "storyteller_stream_plan": "pro",
        "can_use_tts": True,
        "can_use_w2l": True,
        "can_delete_own_tts_results": True,
        "can_delete_own_w2l_results": True,
        "can_delete_own_account": False,
        "can_upload_tts_models": False,
        "can_upload_w2l_templates": False,
        "can_delete_own_tts_models": False,
        "can_delete_own_w2l_templates": False,
        "can_approve_w2l_templates": False,
        "can_edit_other_users_profiles": False,
        "can_edit_other_users_tts_models": False,
        "can_edit_other_users_w2l_templates": False,
        "can_delete_other_users_tts_models": False,
        "can_delete_other_users_tts_results": False,
        "can_delete_other_users_w2l_templates": False,
        "can_delete_other_users_w2l_results": False,
        "can_ban_users": False,
        "can_delete_users": False,
    }


def create_artcraft_router(
    db: StudioDatabase,
    comfy_client: ComfyUIClient,
    inspector: TemplateCatalogInspector,
    run_tracker: RunExecutionTracker,
) -> APIRouter:
    router = APIRouter(tags=["artcraft-compat"])

    def _public_base(request: Request) -> str:
        host = request.headers.get("host") or f"127.0.0.1:{settings.port}"
        scheme = request.url.scheme or "http"
        return f"{scheme}://{host}"

    def _build_media_file_info(rec: dict[str, Any], base_url: str) -> dict[str, Any]:
        qs = urllib.parse.urlencode(
            {
                "filename": rec["filename"],
                "subfolder": rec.get("subfolder") or "",
                "type": rec.get("folder_type") or "output",
            }
        )
        cdn_url = f"{base_url}/api/view?{qs}"
        iso_ts = _iso_from_ts(rec.get("created_at"))
        mclass = rec.get("media_class") or "image"
        mtype = rec.get("media_type") or "png"

        video_previews = None
        if mclass == "video":
            video_previews = {
                "still": cdn_url,
                "animated": cdn_url,
                "still_thumbnail_template": cdn_url,
                "animated_thumbnail_template": cdn_url,
            }

        return {
            "token": rec["token"],
            "media_class": mclass,
            "media_type": mtype,
            "maybe_engine_category": "object" if mclass in ("mesh", "splat") else None,
            "maybe_animation_type": None,
            "maybe_batch_token": None,
            "maybe_scene_source_media_file_token": None,
            "media_links": {
                "cdn_url": cdn_url,
                "maybe_thumbnail_template": cdn_url if mclass == "image" else None,
                "maybe_video_previews": video_previews,
            },
            "cover_image": {
                "maybe_links": None,
                "default_cover": {"image_index": 0, "color_index": 0},
            },
            "maybe_model_weight_info": None,
            "maybe_creator_user": {
                "user_token": "u_local_comfyui_studio",
                "username": "local_comfyui",
                "display_name": "Local ComfyUI Studio",
                "gravatar_hash": "00000000000000000000000000000000",
                "default_avatar": {"image_index": 0, "color_index": 0},
            },
            "creator_set_visibility": "private",
            "is_user_upload": bool(rec.get("is_user_upload")),
            "is_intermediate_system_file": False,
            "maybe_title": rec.get("title") or rec["filename"],
            "maybe_text_transcript": None,
            "maybe_style_name": None,
            "used_face_detailer": False,
            "used_upscaler": False,
            "maybe_prompt_token": None,
            "maybe_original_filename": rec["filename"],
            "maybe_duration_millis": None,
            "is_emulated_media_file": False,
            "is_featured": False,
            "stats": {"positive_rating_count": 0, "bookmark_count": 0},
            "created_at": iso_ts,
            "updated_at": iso_ts,
            "maybe_moderator_fields": None,
        }

    async def _list_candidate_templates() -> tuple[list[TemplateSummary], dict[str, Any]]:
        obj_info: dict[str, Any] = {}
        try:
            obj_info = await comfy_client.get_object_info()
        except Exception:
            pass
        available_nodes = set(obj_info.keys()) if obj_info else None
        all_templates = inspector.list_templates(
            available_nodes=available_nodes,
            installed_ids=db.list_installed_ids(),
            favorite_ids=db.list_favorite_ids(),
        )
        # Surface Ready and Favorited local templates, sorted with Favorites first
        candidates = [
            t
            for t in all_templates
            if t.open_source and (t.status == "ready" or t.favorite or t.installed)
        ]
        candidates.sort(
            key=lambda t: (
                0 if t.favorite else 1,
                0 if t.status == "ready" else 1,
                0 if t.installed else 1,
                -t.usage,
            )
        )
        return candidates, obj_info

    @router.get("/health")
    async def bridge_health() -> dict[str, Any]:
        return {
            "success": True,
            "comfy": settings.comfyui_base_url,
            "workflow_loaded": True,
            "studio_bridge": True,
        }

    # --- Session, Login & Credits ---
    @router.get("/v1/session")
    @router.post("/v1/session")
    async def v1_session(response: Response) -> dict[str, Any]:
        signed = "local-comfyui-session"
        response.set_cookie(
            key="session",
            value=signed,
            path="/",
            httponly=True,
            samesite="lax",
        )
        return {
            "success": True,
            "logged_in": True,
            "user": _session_user_payload(),
        }

    @router.post("/v1/login")
    @router.post("/v1/create_account")
    async def v1_login(response: Response) -> dict[str, Any]:
        signed = "local-comfyui-session"
        response.set_cookie(
            key="session",
            value=signed,
            path="/",
            httponly=True,
            samesite="lax",
        )
        return {"success": True, "signed_session": signed}

    @router.post("/v1/login_challenges/create")
    async def v1_login_challenge_create() -> dict[str, Any]:
        exp = dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=15)
        token_43 = (uuid.uuid4().hex + uuid.uuid4().hex)[:43]
        approval_43 = (uuid.uuid4().hex + uuid.uuid4().hex)[:43]
        return {
            "success": True,
            "device_token": token_43,
            "verification_url": f"http://localhost:4200/login/desktop#approval_token={approval_43}",
            "confirmation_code": "LOCAL-AI",
            "expires_at": exp.isoformat().replace("+00:00", "Z"),
            "poll_interval_seconds": 1,
        }

    @router.post("/v1/login_challenges/poll")
    async def v1_login_challenge_poll(response: Response) -> dict[str, Any]:
        signed = "local-comfyui-session"
        response.set_cookie(
            key="session",
            value=signed,
            path="/",
            httponly=True,
            samesite="lax",
        )
        return {
            "success": True,
            "status": "redeemed",
            "maybe_failure_type": None,
            "maybe_signed_session": signed,
        }

    @router.get("/v1/credits")
    @router.get("/v1/billing/credits")
    @router.get("/v1/credits/namespace/{namespace}")
    async def v1_credits(namespace: str = "artcraft") -> dict[str, Any]:
        return {
            "success": True,
            "free_credits": 999999,
            "monthly_credits": 0,
            "banked_credits": 0,
            "sum_total_credits": 999999,
        }

    @router.get("/v1/subscription")
    @router.get("/v1/billing/subscription")
    @router.get("/v1/subscriptions/namespace/{namespace}")
    async def v1_subscription(namespace: str = "artcraft") -> dict[str, Any]:
        return {
            "success": True,
            "active_subscription": None,
            "subscription": None,
            "plan": "local",
        }

    @router.post("/v1/analytics/{rest:path}")
    async def v1_analytics(rest: str) -> dict[str, Any]:
        return {"success": True}

    # --- OmniGen Model Listings ---
    @router.get("/v1/omni_gen/models/image")
    async def v1_omni_models_image() -> dict[str, Any]:
        candidates, obj_info = await _list_candidate_templates()
        image_templates = [t for t in candidates if t.media_type == "image"]
        if not image_templates:
            image_templates = [inspector.get_template("image_z_image_turbo")]

        models: list[dict[str, Any]] = []
        provider_models: list[dict[str, Any]] = []

        for t in image_templates[:40]:
            try:
                wf, _ = inspector.load_workflow_json(t.id)
                params = extract_template_parameters(wf, obj_info)
            except Exception:
                params = []
            img_inputs = [p for p in params if p.param_type == "image"]
            prefix = "★ " if t.favorite else ("✓ " if t.status == "ready" else "")
            entry = {
                "model": t.id,
                "model_creator": "artcraft",
                "full_name": f"{prefix}{t.title} [ComfyUI]",
                "text_prompt_supported": True,
                "text_prompt_max_length": 4000,
                "negative_text_prompt_supported": True,
                "negative_text_prompt_max_length": 2000,
                "image_refs_supported": len(img_inputs) > 0,
                "image_refs_max": max(1, len(img_inputs)) if img_inputs else 0,
                "aspect_ratio_options": [
                    "square",
                    "wide_sixteen_by_nine",
                    "tall_nine_by_sixteen",
                    "four_by_three",
                    "three_by_four",
                ],
                "aspect_ratio_default": "square",
                "resolution_options": ["seven_twenty_p", "ten_eighty_p"],
                "resolution_default": "ten_eighty_p",
                "quality_options": ["standard"],
                "default_quality": "standard",
                "batch_size_min": 1,
                "batch_size_max": 1,
                "batch_size_options": [1],
                "batch_size_default": 1,
                "is_disabled": False,
            }
            models.append(entry)
            provider_models.append({"model": t.id})

        return {
            "success": True,
            "models": models,
            "providers": [{"provider": "artcraft", "models": provider_models}],
        }

    @router.get("/v1/omni_gen/models/video")
    async def v1_omni_models_video() -> dict[str, Any]:
        candidates, obj_info = await _list_candidate_templates()
        video_templates = [t for t in candidates if t.media_type == "video"]
        if not video_templates:
            for fallback_id in ("video_wan2_2_14B_i2v", "utility-gan_upscaler"):
                try:
                    video_templates.append(inspector.get_template(fallback_id))
                except Exception:
                    pass

        models: list[dict[str, Any]] = []
        provider_models: list[dict[str, Any]] = []

        for t in video_templates[:40]:
            try:
                wf, _ = inspector.load_workflow_json(t.id)
                params = extract_template_parameters(wf, obj_info)
            except Exception:
                params = []
            img_inputs = [p for p in params if p.param_type == "image"]
            vid_inputs = [p for p in params if p.param_type == "video"]
            prefix = "★ " if t.favorite else ("✓ " if t.status == "ready" else "")
            entry = {
                "model": t.id,
                "model_creator": "artcraft",
                "full_name": f"{prefix}{t.title} [ComfyUI]",
                "extra_info": t.description,
                "extra_info_short": "Local ComfyUI",
                "text_to_video_supported": len(img_inputs) == 0 and len(vid_inputs) == 0,
                "text_prompt_supported": True,
                "text_prompt_max_length": 4000,
                "negative_text_prompt_supported": True,
                "negative_text_prompt_max_length": 2000,
                "starting_keyframe_supported": len(img_inputs) > 0,
                "starting_keyframe_required": False,
                "ending_keyframe_supported": len(img_inputs) > 1,
                "image_references_supported": len(img_inputs) > 0,
                "image_references_max": len(img_inputs),
                "video_references_supported": len(vid_inputs) > 0,
                "video_references_max": len(vid_inputs),
                "aspect_ratio_options": [
                    "wide_sixteen_by_nine",
                    "tall_nine_by_sixteen",
                    "square",
                ],
                "aspect_ratio_default": "wide_sixteen_by_nine",
                "resolution_options": ["seven_twenty_p", "ten_eighty_p"],
                "resolution_default": "seven_twenty_p",
                "quality_options": ["standard"],
                "default_quality": "standard",
                "duration_seconds_options": [5],
                "duration_seconds_default": 5,
                "batch_size_min": 1,
                "batch_size_max": 1,
                "batch_size_options": [1],
                "batch_size_default": 1,
                "is_disabled": False,
            }
            models.append(entry)
            provider_models.append({"model": t.id})

        return {
            "success": True,
            "models": models,
            "providers": [{"provider": "artcraft", "models": provider_models}],
        }

    @router.get("/v1/omni_gen/models/mesh")
    async def v1_omni_models_mesh() -> dict[str, Any]:
        candidates, _ = await _list_candidate_templates()
        mesh_templates = [
            t
            for t in candidates
            if t.media_type == "3d" and "splat" not in t.id.lower()
        ]
        if not mesh_templates:
            try:
                mesh_templates.append(inspector.get_template("3d_hunyuan3d-v2.1"))
            except Exception:
                pass

        models: list[dict[str, Any]] = []
        provider_models: list[dict[str, Any]] = []
        for t in mesh_templates[:20]:
            prefix = "★ " if t.favorite else ("✓ " if t.status == "ready" else "")
            models.append(
                {
                    "model": t.id,
                    "model_creator": "tencent",
                    "full_name": f"{prefix}{t.title} [ComfyUI]",
                    "extra_info": t.description,
                    "extra_info_short": "Local ComfyUI 3D",
                    "text_prompt_supported": False,
                    "image_input_supported": True,
                    "sketch_input_supported": False,
                    "multi_view_supported": "multiview" in t.id.lower(),
                    "mesh_input_supported": False,
                    "pbr_supported": True,
                    "is_disabled": False,
                }
            )
            provider_models.append({"model": t.id})

        return {
            "success": True,
            "models": models,
            "providers": [{"provider": "artcraft", "models": provider_models}],
        }

    @router.get("/v1/omni_gen/models/splat")
    async def v1_omni_models_splat() -> dict[str, Any]:
        candidates, _ = await _list_candidate_templates()
        splat_templates = [
            t for t in candidates if t.media_type == "3d" and "splat" in t.id.lower()
        ]
        models: list[dict[str, Any]] = []
        provider_models: list[dict[str, Any]] = []
        for t in splat_templates[:15]:
            prefix = "★ " if t.favorite else ("✓ " if t.status == "ready" else "")
            models.append(
                {
                    "model": t.id,
                    "model_creator": "tripo",
                    "full_name": f"{prefix}{t.title} [ComfyUI]",
                    "text_prompt_supported": False,
                    "image_refs_supported": True,
                    "image_refs_max": 1,
                    "is_disabled": False,
                }
            )
            provider_models.append({"model": t.id})
        return {
            "success": True,
            "models": models,
            "providers": [{"provider": "artcraft", "models": provider_models}],
        }

    @router.get("/v1/omni_gen/models/audio")
    async def v1_omni_models_audio() -> dict[str, Any]:
        candidates, _ = await _list_candidate_templates()
        audio_templates = [t for t in candidates if t.media_type == "audio"]
        models: list[dict[str, Any]] = []
        for t in audio_templates[:20]:
            prefix = "★ " if t.favorite else ("✓ " if t.status == "ready" else "")
            models.append(
                {
                    "model": t.id,
                    "model_creator": "artcraft",
                    "full_name": f"{prefix}{t.title} [ComfyUI]",
                    "text_prompt_supported": True,
                    "is_disabled": False,
                }
            )
        return {"success": True, "models": models}

    # --- OmniGen Cost Estimation ---
    @router.post("/v1/omni_gen/cost/{modality}")
    async def v1_omni_cost(modality: str) -> dict[str, Any]:
        return {
            "success": True,
            "cost_in_credits": 0,
            "cost_in_usd_cents": 0,
            "is_free": True,
            "is_unlimited": True,
            "is_rate_limited": False,
            "has_watermark": False,
            "failures_are_refunded": True,
        }

    # --- Media File Uploads from ArtCraft Canvas / References ---
    @router.post("/v1/media_files/upload")
    @router.post("/v1/media_files/upload/{subpath:path}")
    async def v1_upload_media_file(
        request: Request,
        subpath: str = "",
        file: UploadFile | None = File(default=None),
    ) -> dict[str, Any]:
        media_token = f"m_{uuid.uuid4().hex[:24]}"
        if file and file.filename:
            safe_name = f"artcraft_{media_token}_{Path(file.filename).name}"
            content = await file.read()
            if content:
                res = await comfy_client.upload_image(
                    filename=safe_name,
                    content=content,
                    content_type=file.content_type or "image/png",
                )
                saved_name = res.get("name", safe_name)
                mclass, mtype = _ext_to_media_type(saved_name, "image")
                db.save_artcraft_media(
                    token=media_token,
                    filename=saved_name,
                    subfolder=res.get("subfolder", ""),
                    folder_type=res.get("type", "input"),
                    media_class=mclass,
                    media_type=mtype,
                    title=file.filename,
                    is_user_upload=True,
                )
        return {"success": True, "media_file_token": media_token}

    # --- OmniGen Generation Execution ---
    async def _resolve_template_id(requested_model: str | None, modality: str) -> str:
        if requested_model:
            try:
                inspector.get_template(requested_model)
                return requested_model
            except KeyError:
                pass
        # Map ArtCraft built-in canonical model names or empty model to best local template
        candidates, _ = await _list_candidate_templates()
        target_media = "3d" if modality in ("mesh", "splat") else modality
        matching = [t for t in candidates if t.media_type == target_media and t.status == "ready"]
        if matching:
            return matching[0].id
        fallbacks = {
            "image": "image_z_image_turbo",
            "video": "video_wan2_2_14B_i2v",
            "mesh": "3d_hunyuan3d-v2.1",
            "splat": "3d_triposplat_image_to_gaussian_splat",
            "audio": "audio_ace_step_1_t2a_song",
        }
        return fallbacks.get(modality, "image_z_image_turbo")

    @router.post("/v1/omni_gen/generate/{modality}")
    async def v1_omni_generate(modality: str, request: Request) -> dict[str, Any]:
        body: dict[str, Any] = await request.json()
        requested_model = body.get("model")
        template_id = await _resolve_template_id(requested_model, modality)

        obj_info = await comfy_client.get_object_info()
        summary = inspector.get_template(
            template_id,
            available_nodes=set(obj_info.keys()),
            installed_ids=db.list_installed_ids(),
            favorite_ids=db.list_favorite_ids(),
        )
        workflow, sha = inspector.load_workflow_json(template_id)

        if summary.io_inputs:
            await asyncio.to_thread(inspector.stage_sample_inputs, template_id, summary.io_inputs)

        parameters = extract_template_parameters(workflow, obj_info)
        overrides: dict[str, Any] = {}

        # 1. Map positive and negative prompts
        prompt_text = body.get("prompt")
        neg_text = body.get("negative_prompt")
        multiline_params = [p for p in parameters if p.param_type == "multiline"]
        pos_params = [p for p in multiline_params if "negative" not in p.label.lower()]
        neg_params = [p for p in multiline_params if "negative" in p.label.lower()]

        if prompt_text and pos_params:
            overrides[pos_params[0].key] = prompt_text
        if neg_text and neg_params:
            overrides[neg_params[0].key] = neg_text

        # 2. Map resolution & aspect ratio
        if body.get("aspect_ratio") or body.get("resolution"):
            w, h = _aspect_and_res_to_size(body.get("aspect_ratio"), body.get("resolution"))
            for p in parameters:
                if p.input_name == "width":
                    overrides[p.key] = w
                elif p.input_name == "height":
                    overrides[p.key] = h

        # 3. Randomize seed unless provided
        seed_val = body.get("seed") or random.randint(1, 999_999_999_999)
        for p in parameters:
            if p.input_name in ("seed", "noise_seed"):
                overrides[p.key] = int(seed_val)

        # 4. Map uploaded reference images / keyframes / videos from ArtCraft
        img_tokens: list[str] = []
        for field_name in (
            "image_media_tokens",
            "reference_image_media_tokens",
        ):
            val = body.get(field_name)
            if isinstance(val, list):
                img_tokens.extend(str(x) for x in val if x)
        for single_field in (
            "start_frame_image_media_token",
            "front_image_media_token",
            "image_media_token",
        ):
            val = body.get(single_field)
            if isinstance(val, str) and val:
                img_tokens.insert(0, val)

        image_params = [p for p in parameters if p.param_type == "image"]
        for idx, tok in enumerate(img_tokens):
            if idx >= len(image_params):
                break
            media_rec = db.get_artcraft_media(tok)
            if media_rec and media_rec.get("filename"):
                overrides[image_params[idx].key] = media_rec["filename"]

        vid_tokens = body.get("reference_video_media_tokens") or []
        video_params = [p for p in parameters if p.param_type == "video"]
        if isinstance(vid_tokens, list):
            for idx, tok in enumerate(vid_tokens):
                if idx >= len(video_params):
                    break
                media_rec = db.get_artcraft_media(str(tok))
                if media_rec and media_rec.get("filename"):
                    overrides[video_params[idx].key] = media_rec["filename"]

        api_prompt = compile_workflow_to_api_prompt(
            workflow, obj_info, field_overrides=overrides
        )
        run_record = await run_tracker.start_run(
            template_id=template_id,
            template_title=summary.title,
            fields=overrides,
            api_prompt=api_prompt,
        )
        job_token = run_record["id"]
        return {
            "success": True,
            "inference_job_token": job_token,
            "all_job_tokens": [job_token],
        }

    # --- Session Jobs Polling & Media Files ---
    def _ensure_run_media_registered(run_rec: dict[str, Any]) -> dict[str, Any] | None:
        outputs = run_rec.get("outputs") or []
        if not outputs:
            return None
        first = outputs[0]
        media_token = f"m_{run_rec['id'].replace('run-', '')}"
        existing = db.get_artcraft_media(media_token)
        if existing:
            return existing
        mclass, mtype = _ext_to_media_type(
            first.get("filename", "output.png"),
            first.get("media_kind", "image"),
        )
        prompt_title = next(
            (str(v) for v in (run_rec.get("fields") or {}).values() if isinstance(v, str) and len(v) > 3),
            run_rec.get("template_title") or "ComfyUI Generation",
        )
        return db.save_artcraft_media(
            token=media_token,
            filename=first.get("filename", ""),
            subfolder=first.get("subfolder", ""),
            folder_type=first.get("type", "output"),
            media_class=mclass,
            media_type=mtype,
            title=prompt_title[:200],
            model_id=run_rec.get("template_id") or "",
            run_id=run_rec["id"],
            is_user_upload=False,
            created_at=run_rec.get("completed_at") or run_rec.get("created_at"),
        )

    @router.get("/v1/jobs/session")
    @router.post("/v1/jobs/session")
    async def v1_jobs_session(request: Request) -> dict[str, Any]:
        base_url = _public_base(request)
        runs = db.list_runs(limit=50)
        jobs: list[dict[str, Any]] = []

        for r in runs:
            run_tracker.ensure_monitoring(r)
            st = r["status"]
            if st == "completed":
                art_status = "complete_success"
                pct = 100
            elif st in ("failed", "cancelled"):
                art_status = "failed" if st == "failed" else "dead"
                pct = 100
            elif st == "running":
                art_status = "started"
                total = int(r.get("progress_total") or 0)
                step = int(r.get("progress_step") or 0)
                pct = min(99, max(5, round((step / total) * 100))) if total > 0 else 25
            else:
                art_status = "pending"
                pct = 2

            tid = r.get("template_id") or ""
            if tid.startswith("video_") or "video" in tid:
                inf_cat = "video_generation"
            elif tid.startswith("3d_"):
                inf_cat = "splat_generation" if "splat" in tid else "object_generation"
            elif tid.startswith("audio_"):
                inf_cat = "audio_generation"
            else:
                inf_cat = "image_generation"

            maybe_result = None
            if st == "completed":
                media_rec = _ensure_run_media_registered(r)
                if media_rec:
                    m_info = _build_media_file_info(media_rec, base_url)
                    maybe_result = {
                        "entity_type": "media_file",
                        "entity_token": media_rec["token"],
                        "maybe_batch_token": None,
                        "maybe_public_bucket_media_path": None,
                        "media_links": m_info["media_links"],
                        "maybe_successfully_completed_at": _iso_from_ts(
                            r.get("completed_at") or r.get("created_at")
                        ),
                    }

            created_iso = _iso_from_ts(r.get("created_at"))
            updated_iso = _iso_from_ts(r.get("completed_at") or r.get("created_at"))

            jobs.append(
                {
                    "job_token": r["id"],
                    "request": {
                        "inference_category": inf_cat,
                        "maybe_prompt_token": None,
                        "maybe_model_type": tid,
                        "maybe_model_token": None,
                        "maybe_model_title": r.get("template_title"),
                        "maybe_raw_inference_text": None,
                        "maybe_style_name": None,
                        "maybe_live_portrait_details": None,
                        "maybe_lipsync_details": None,
                    },
                    "status": {
                        "status": art_status,
                        "maybe_extra_status_description": r.get("current_node"),
                        "maybe_assigned_worker": "local-comfyui",
                        "maybe_assigned_cluster": "local",
                        "maybe_first_started_at": created_iso,
                        "maybe_current_execution_duration_seconds": 1,
                        "attempt_count": 1,
                        "requires_keepalive": False,
                        "maybe_failure_category": None,
                        "maybe_failure_category_updated": "unknown"
                        if art_status in ("failed", "dead")
                        else None,
                        "maybe_failure_message": r.get("error"),
                        "progress_percentage": pct,
                    },
                    "maybe_result": maybe_result,
                    "created_at": created_iso,
                    "updated_at": updated_iso,
                }
            )

        return {"success": True, "jobs": jobs}

    @router.get("/v1/media_files/file/{media_token}")
    async def v1_get_media_file(media_token: str, request: Request) -> dict[str, Any]:
        base_url = _public_base(request)
        rec = db.get_artcraft_media(media_token)
        if not rec:
            # Check if it corresponds to a completed run
            for r in db.list_runs(limit=100):
                if f"m_{r['id'].replace('run-', '')}" == media_token:
                    rec = _ensure_run_media_registered(r)
                    break
        if not rec:
            raise HTTPException(status_code=404, detail="Media file not found")
        return {
            "success": True,
            "media_file": _build_media_file_info(rec, base_url),
        }

    @router.delete("/v1/media_files/file/{media_token}")
    async def v1_delete_media_file(media_token: str) -> dict[str, Any]:
        rec = db.get_artcraft_media(media_token)
        if rec and rec.get("run_id"):
            await run_tracker.delete_run(rec["run_id"])
        return {"success": True}

    @router.get("/v1/media_files/list/user/{user_token}")
    async def v1_list_user_media_files(user_token: str, request: Request) -> dict[str, Any]:
        base_url = _public_base(request)
        for r in db.list_runs(limit=50):
            if r.get("status") == "completed":
                _ensure_run_media_registered(r)
        records = db.list_artcraft_media(limit=100)
        results = [_build_media_file_info(rec, base_url) for rec in records if not rec.get("is_user_upload")]
        return {
            "success": True,
            "results": results,
            "pagination": {"current": 1, "total_page_count": 1},
        }

    return router
