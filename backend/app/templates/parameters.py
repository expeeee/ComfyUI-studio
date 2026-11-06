from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.templates.compiler import compile_workflow_to_api_prompt, flatten_workflow

PROMPT_NODE_CLASSES = {
    "CLIPTextEncode",
    "CLIPTextEncodeSDXL",
    "CLIPTextEncodeFlux",
    "CLIPTextEncodeLumina2",
    "CLIPTextEncodeHunyuanDiT",
    "CLIPTextEncodePixArtAlpha",
    "CLIPTextEncodeSD3",
    "TextEncodeQwenImageEdit",
    "TextEncodeQwenImageEditPlus",
    "TextEncodeAceStepAudio",
    "T5TextEncode",
    "PrimitiveStringMultiline",
    "PrimitiveString",
}

MEDIA_INPUT_CLASSES = {
    "LoadImage": ("image", "image"),
    "LoadImageMask": ("image", "image"),
    "LoadAudio": ("audio", "audio"),
    "LoadVideo": ("file", "video"),
    "VHS_LoadVideo": ("video", "video"),
}

DIMENSION_INPUT_NAMES = {"width", "height", "batch_size", "length", "frame_rate", "fps", "resolution"}
SAMPLING_INPUT_NAMES = {
    "seed",
    "noise_seed",
    "steps",
    "cfg",
    "guidance",
    "sampler_name",
    "scheduler",
    "denoise",
    "shift",
    "strength_model",
    "strength_clip",
}
MODEL_SELECTOR_NAMES = {"ckpt_name", "unet_name", "clip_name", "vae_name", "lora_name", "control_net_name"}


@dataclass
class ExtractedParameter:
    key: str  # "{node_id}.{input_name}"
    node_id: str
    node_class: str
    node_title: str
    input_name: str
    label: str
    group: str  # "primary" or "details"
    category: str  # "prompt", "negative_prompt", "media", "dimensions", "sampling", "advanced", "model"
    param_type: str  # "string", "multiline", "int", "float", "boolean", "combo", "image", "audio", "video"
    default: Any
    required: bool = True
    min_val: float | int | None = None
    max_val: float | int | None = None
    step: float | int | None = None
    options: list[Any] = field(default_factory=list)
    tooltip: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "node_id": self.node_id,
            "node_class": self.node_class,
            "node_title": self.node_title,
            "input_name": self.input_name,
            "label": self.label,
            "group": self.group,
            "category": self.category,
            "param_type": self.param_type,
            "default": self.default,
            "required": self.required,
            "min": self.min_val,
            "max": self.max_val,
            "step": self.step,
            "options": self.options,
            "tooltip": self.tooltip,
        }


def _find_input_spec(node_schema: dict[str, Any] | None, input_name: str) -> Any | None:
    if not node_schema:
        return None
    inp_block = node_schema.get("input") or {}
    for sec in ("required", "optional"):
        sec_d = inp_block.get(sec) or {}
        if input_name in sec_d:
            return sec_d[input_name]
    return None


def _parse_spec_constraints(
    spec: Any | None, current_value: Any
) -> tuple[str, float | int | None, float | int | None, float | int | None, list[Any], str | None]:
    """Return (param_type, min_val, max_val, step, options, tooltip)."""
    if isinstance(spec, list) and len(spec) > 0:
        first = spec[0]
        opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
        tooltip = opts.get("tooltip")
        if isinstance(first, list):
            return ("combo", None, None, None, list(first), tooltip)
        if first == "COMBO":
            combo_opts = opts.get("options") if isinstance(opts.get("options"), list) else []
            return ("combo", None, None, None, combo_opts, tooltip)
        if first == "INT":
            return (
                "int",
                opts.get("min"),
                opts.get("max"),
                opts.get("step", 1),
                [],
                tooltip,
            )
        if first == "FLOAT":
            return (
                "float",
                opts.get("min"),
                opts.get("max"),
                opts.get("step", 0.01),
                [],
                tooltip,
            )
        if first == "BOOLEAN":
            return ("boolean", None, None, None, [], tooltip)
        if first == "STRING":
            is_multi = bool(opts.get("multiline")) or (
                isinstance(current_value, str) and len(current_value) > 50
            )
            return ("multiline" if is_multi else "string", None, None, None, [], tooltip)

    # Fallback inference from current_value
    if isinstance(current_value, bool):
        return ("boolean", None, None, None, [], None)
    if isinstance(current_value, int):
        return ("int", None, None, 1, [], None)
    if isinstance(current_value, float):
        return ("float", None, None, 0.01, [], None)
    if isinstance(current_value, str) and len(current_value) > 50:
        return ("multiline", None, None, None, [], None)
    return ("string", None, None, None, [], None)


def _is_negative_conditioning(
    node_id: str, node_title: str, custom_label: str | None, api_prompt: dict[str, Any]
) -> bool:
    title_lower = (custom_label or node_title or "").lower()
    if "negative" in title_lower or "neg" == title_lower.strip():
        return True
    if "positive" in title_lower:
        return False
    # Check if this node's output feeds a 'negative' input on any downstream node
    feeds_negative = False
    feeds_positive = False
    for other in api_prompt.values():
        for inp_name, inp_val in (other.get("inputs") or {}).items():
            if isinstance(inp_val, list) and len(inp_val) == 2 and str(inp_val[0]) == str(node_id):
                if "negative" in inp_name.lower():
                    feeds_negative = True
                elif "positive" in inp_name.lower() or "conditioning" in inp_name.lower():
                    feeds_positive = True
    return feeds_negative and not feeds_positive


def extract_template_parameters(
    workflow: dict[str, Any],
    object_info: dict[str, Any] | None = None,
) -> list[ExtractedParameter]:
    """
    Automatically extract user-editable parameters from a template workflow, grouped into:
    - 'primary': Positive/Negative Prompts + Input Media (LoadImage/LoadVideo/LoadAudio)
    - 'details': Dimensions (width/height/batch_size), Sampling (seed/steps/cfg/sampler/scheduler/denoise),
                 and template-exposed proxyWidgets.
    """
    obj_info = object_info or {}
    ctx = flatten_workflow(workflow, obj_info)
    api_prompt = compile_workflow_to_api_prompt(workflow, obj_info)

    exposed_labels: dict[tuple[str, str], str] = {}
    exposed_order: list[tuple[str, str]] = []
    for nid, inp_name, lbl in ctx.exposed_controls:
        pair = (nid, inp_name)
        if pair not in exposed_order:
            exposed_order.append(pair)
        if lbl and pair not in exposed_labels:
            exposed_labels[pair] = lbl

    extracted: dict[str, ExtractedParameter] = {}

    def _add_param(
        nid: str,
        inp_name: str,
        group: str,
        category: str,
        custom_label: str | None = None,
        override_type: str | None = None,
    ) -> None:
        key = f"{nid}.{inp_name}"
        if key in extracted:
            return
        if (nid, inp_name) in ctx.input_links:
            # Connected to another node's output; not a scalar/widget parameter
            return
        node_entry = api_prompt.get(nid)
        if not node_entry:
            return
        inputs = node_entry.get("inputs") or {}
        if inp_name not in inputs:
            return
        val = inputs[inp_name]
        if isinstance(val, list):
            return

        class_type = node_entry["class_type"]
        node_title = (node_entry.get("_meta") or {}).get("title") or class_type
        schema = obj_info.get(class_type)
        spec = _find_input_spec(schema, inp_name)
        ptype, min_v, max_v, step_v, options, tooltip = _parse_spec_constraints(spec, val)
        if override_type:
            ptype = override_type

        label = (
            custom_label
            or exposed_labels.get((nid, inp_name))
            or _humanize_label(inp_name, node_title, category)
        )

        extracted[key] = ExtractedParameter(
            key=key,
            node_id=nid,
            node_class=class_type,
            node_title=node_title,
            input_name=inp_name,
            label=label,
            group=group,
            category=category,
            param_type=ptype,
            default=val,
            min_val=min_v,
            max_val=max_v,
            step=step_v,
            options=options,
            tooltip=tooltip,
        )

    # 1. Inspect all nodes for Primary Media Inputs (LoadImage, LoadVideo, LoadAudio)
    for nid, node_entry in api_prompt.items():
        ctype = node_entry["class_type"]
        if ctype in MEDIA_INPUT_CLASSES:
            inp_name, media_kind = MEDIA_INPUT_CLASSES[ctype]
            node_title = (node_entry.get("_meta") or {}).get("title") or ctype
            _add_param(
                nid,
                inp_name,
                group="primary",
                category="media",
                custom_label=f"Input {media_kind.capitalize()} ({node_title})",
                override_type=media_kind,
            )

    # 2. Inspect Prompt Nodes (CLIPTextEncode*, TextEncode*, or exposed prompt strings)
    for nid, node_entry in api_prompt.items():
        ctype = node_entry["class_type"]
        node_title = (node_entry.get("_meta") or {}).get("title") or ctype
        inputs = node_entry.get("inputs") or {}
        if ctype in PROMPT_NODE_CLASSES:
            for prompt_field in ("text", "prompt", "clip_l", "t5xxl", "string", "value"):
                if prompt_field in inputs and not isinstance(inputs[prompt_field], list):
                    custom_lbl = exposed_labels.get((nid, prompt_field))
                    is_neg = _is_negative_conditioning(nid, node_title, custom_lbl, api_prompt)
                    # Skip blank negative prompts unless explicitly exposed or non-empty
                    val_str = str(inputs[prompt_field] or "")
                    if is_neg:
                        lbl = custom_lbl or "Negative Prompt"
                        _add_param(
                            nid,
                            prompt_field,
                            group="primary" if val_str.strip() else "details",
                            category="negative_prompt",
                            custom_label=lbl,
                            override_type="multiline",
                        )
                    else:
                        lbl = custom_lbl or "Prompt"
                        _add_param(
                            nid,
                            prompt_field,
                            group="primary",
                            category="prompt",
                            custom_label=lbl,
                            override_type="multiline",
                        )

    # 3. Also check exposed_controls for any subgraph prompt fields on custom/unknown text nodes
    for nid, inp_name in exposed_order:
        lbl = exposed_labels.get((nid, inp_name)) or inp_name
        if inp_name in ("prompt", "text", "positive_prompt") or "prompt" in lbl.lower():
            is_neg = "negative" in lbl.lower() or "negative" in inp_name.lower()
            _add_param(
                nid,
                inp_name,
                group="details" if is_neg else "primary",
                category="negative_prompt" if is_neg else "prompt",
                custom_label="Negative Prompt" if is_neg else "Prompt",
                override_type="multiline",
            )

    # 4. Inspect Dimensions & Sampling Details across all nodes
    for nid, node_entry in api_prompt.items():
        inputs = node_entry.get("inputs") or {}
        for inp_name in inputs:
            if inp_name in DIMENSION_INPUT_NAMES:
                _add_param(nid, inp_name, group="details", category="dimensions")
            elif inp_name in SAMPLING_INPUT_NAMES:
                _add_param(nid, inp_name, group="details", category="sampling")

    # 5. Add any remaining subgraph exposed_controls into Details
    for nid, inp_name in exposed_order:
        if inp_name in MODEL_SELECTOR_NAMES:
            _add_param(nid, inp_name, group="details", category="model")
        else:
            _add_param(nid, inp_name, group="details", category="advanced")

    # Order cleanly: primary prompts first, then primary media, then dimensions, sampling, advanced, model
    category_priority = {
        "prompt": 0,
        "media": 1,
        "negative_prompt": 2,
        "dimensions": 3,
        "sampling": 4,
        "advanced": 5,
        "model": 6,
    }
    return sorted(
        extracted.values(),
        key=lambda p: (0 if p.group == "primary" else 1, category_priority.get(p.category, 9)),
    )


def _humanize_label(inp_name: str, node_title: str, category: str) -> str:
    friendly = {
        "width": "Width",
        "height": "Height",
        "batch_size": "Batch Size",
        "seed": "Seed",
        "noise_seed": "Noise Seed",
        "steps": "Steps",
        "cfg": "CFG Scale",
        "guidance": "Guidance",
        "sampler_name": "Sampler",
        "scheduler": "Scheduler",
        "denoise": "Denoise Strength",
        "unet_name": "Diffusion Model",
        "ckpt_name": "Checkpoint",
        "clip_name": "Text Encoder / CLIP",
        "vae_name": "VAE",
        "lora_name": "LoRA",
    }
    if inp_name in friendly:
        return friendly[inp_name]
    clean = inp_name.replace("_", " ").strip().title()
    if category in ("advanced", "model") and node_title:
        return f"{clean} ({node_title})"
    return clean
