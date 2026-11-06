from __future__ import annotations

import json
import urllib.request

from app.templates.compiler import compile_workflow_to_api_prompt
from app.templates.inspector import TemplateCatalogInspector
from app.templates.parameters import extract_template_parameters


def _fetch_live_object_info() -> dict:
    with urllib.request.urlopen("http://127.0.0.1:8188/object_info", timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def test_catalog_inspector_discovers_all_templates_and_z_image_ready():
    obj_info = _fetch_live_object_info()
    inspector = TemplateCatalogInspector()
    templates = inspector.list_templates(available_nodes=set(obj_info.keys()))
    assert len(templates) >= 650

    z_img = inspector.get_template("image_z_image_turbo", available_nodes=set(obj_info.keys()))
    assert z_img.id == "image_z_image_turbo"
    assert z_img.has_subgraphs is True
    assert z_img.status == "ready"
    assert len(z_img.models) == 3
    assert all(m.installed for m in z_img.models)
    assert z_img.thumbnail_url == "/api/templates/image_z_image_turbo/thumbnail"


def test_compile_z_image_turbo_subgraph_to_api_prompt():
    obj_info = _fetch_live_object_info()
    inspector = TemplateCatalogInspector()
    wf, _ = inspector.load_workflow_json("image_z_image_turbo")

    api_prompt = compile_workflow_to_api_prompt(wf, obj_info)
    # Must contain top-level SaveImage (node "9") and expanded subgraph nodes ("57:27", "57:3", etc.)
    assert "9" in api_prompt
    assert api_prompt["9"]["class_type"] == "SaveImage"
    # SaveImage input 'images' must link to ["57:8", 0] (VAEDecode inside subgraph 57)
    assert api_prompt["9"]["inputs"]["images"] == ["57:8", 0]

    assert "57:27" in api_prompt
    assert api_prompt["57:27"]["class_type"] == "CLIPTextEncode"
    assert "Latina female" in api_prompt["57:27"]["inputs"]["text"]
    assert api_prompt["57:27"]["inputs"]["clip"] == ["57:30", 0]

    assert "57:3" in api_prompt
    assert api_prompt["57:3"]["class_type"] == "KSampler"
    assert api_prompt["57:3"]["inputs"]["steps"] == 8
    assert api_prompt["57:3"]["inputs"]["sampler_name"] == "res_multistep"


def test_extract_parameters_and_override_compilation():
    obj_info = _fetch_live_object_info()
    inspector = TemplateCatalogInspector()
    wf, _ = inspector.load_workflow_json("image_z_image_turbo")

    params = extract_template_parameters(wf, obj_info)
    by_key = {p.key: p for p in params}

    # Primary prompt must be extracted with default example prompt
    assert "57:27.text" in by_key
    prompt_param = by_key["57:27.text"]
    assert prompt_param.group == "primary"
    assert prompt_param.category == "prompt"
    assert "Latina female" in prompt_param.default

    # Details must include width, height, seed, steps
    assert "57:13.width" in by_key
    assert by_key["57:13.width"].group == "details"
    assert by_key["57:13.width"].default == 1024
    assert "57:3.steps" in by_key
    assert by_key["57:3.steps"].default == 8

    # Applying user overrides updates only targeted fields
    compiled = compile_workflow_to_api_prompt(
        wf,
        obj_info,
        field_overrides={
            "57:27.text": "A futuristic cyberpunk lighthouse in a storm",
            "57:13.width": 768,
            "57:3.steps": 6,
            "57:3.seed": 42,
        },
    )
    assert compiled["57:27"]["inputs"]["text"] == "A futuristic cyberpunk lighthouse in a storm"
    assert compiled["57:13"]["inputs"]["width"] == 768
    assert compiled["57:3"]["inputs"]["steps"] == 6
    assert compiled["57:3"]["inputs"]["seed"] == 42


def test_compile_across_all_local_open_source_templates():
    obj_info = _fetch_live_object_info()
    inspector = TemplateCatalogInspector()
    templates = inspector.list_templates(available_nodes=set(obj_info.keys()))
    local_Compatible = [t for t in templates if t.status in ("ready", "needs_models")]
    assert len(local_Compatible) >= 150

    compiled_ok = 0
    for t in local_Compatible:
        wf, _ = inspector.load_workflow_json(t.id)
        prompt = compile_workflow_to_api_prompt(wf, obj_info)
        params = extract_template_parameters(wf, obj_info)
        if prompt and len(prompt) > 0:
            compiled_ok += 1

    # Verify 100% of locally compatible templates compile into non-empty API prompts
    assert compiled_ok == len(local_Compatible)


def test_compile_wan2_2_14b_i2v_save_video_dynamic_combo():
    obj_info = _fetch_live_object_info()
    inspector = TemplateCatalogInspector()
    wf, _ = inspector.load_workflow_json("video_wan2_2_14B_i2v")

    api_prompt = compile_workflow_to_api_prompt(wf, obj_info)
    assert "108" in api_prompt
    save_video = api_prompt["108"]
    assert save_video["class_type"] == "SaveVideo"
    assert save_video["inputs"]["filename_prefix"] == "video/Wan2.2_i2v"
    assert save_video["inputs"]["format"] == "auto"
    assert save_video["inputs"]["format.codec"] == "auto"
    assert save_video["inputs"]["video"] == ["129:94", 0]


def test_compile_3d_templates_save_glb_and_save_3d_advanced():
    obj_info = _fetch_live_object_info()
    inspector = TemplateCatalogInspector()

    wf_h, _ = inspector.load_workflow_json("3d_hunyuan3d-v2.1")
    prompt_h = compile_workflow_to_api_prompt(wf_h, obj_info)
    assert prompt_h["10"]["class_type"] == "SaveGLB"
    assert prompt_h["10"]["inputs"]["filename_prefix"] == "3d/ComfyUI"
    assert prompt_h["10"]["inputs"]["mesh"] == ["19:9", 0]

    wf_t, _ = inspector.load_workflow_json("3d_pixal3d_trellis2_image_to_model")
    prompt_t = compile_workflow_to_api_prompt(wf_t, obj_info)
    assert prompt_t["322"]["class_type"] == "Save3DAdvanced"
    assert prompt_t["322"]["inputs"]["viewport_state"] == ""
    assert prompt_t["322"]["inputs"]["width"] == 1024
    assert prompt_t["322"]["inputs"]["height"] == 1024


def test_compile_video_upscale_and_v2v_templates():
    obj_info = _fetch_live_object_info()
    inspector = TemplateCatalogInspector()

    # SeedVR2 3B Int8 Video Upscaler (uses ResizeImageMaskNode dynamic combo + LoadVideo + SaveVideo)
    wf_seedvr, _ = inspector.load_workflow_json("utility_seedvr2_3b_int8_upscale_video")
    p_seedvr = compile_workflow_to_api_prompt(wf_seedvr, obj_info)
    params_seedvr = extract_template_parameters(wf_seedvr, obj_info)
    assert p_seedvr["73"]["class_type"] == "LoadVideo"
    assert p_seedvr["73"]["inputs"]["file"] == "grainy_perfume_shot_crf32.mp4"
    assert p_seedvr["66:57"]["class_type"] == "ResizeImageMaskNode"
    assert p_seedvr["66:57"]["inputs"]["resize_type"] == "scale by multiplier"
    assert p_seedvr["66:57"]["inputs"]["resize_type.multiplier"] == 2
    assert p_seedvr["76"]["class_type"] == "SaveVideo"
    assert p_seedvr["76"]["inputs"]["format"] == "auto"
    assert p_seedvr["76"]["inputs"]["format.codec"] == "auto"
    assert any(p.key == "73.file" and p.param_type == "video" for p in params_seedvr)

    # Real-ESRGAN Video Upscaler
    wf_gan, _ = inspector.load_workflow_json("utility-gan_upscaler")
    p_gan = compile_workflow_to_api_prompt(wf_gan, obj_info)
    assert p_gan["9"]["class_type"] == "LoadVideo"
    assert p_gan["12"]["class_type"] == "SaveVideo"
    assert p_gan["12"]["inputs"]["format"] == "auto"

    # FILM / RIFE Frame Interpolation
    wf_interp, _ = inspector.load_workflow_json("utility_video_frame_interpolation")
    p_interp = compile_workflow_to_api_prompt(wf_interp, obj_info)
    assert p_interp["4"]["class_type"] == "LoadVideo"
    assert p_interp["16:2"]["class_type"] == "FrameInterpolate"
    assert p_interp["7"]["class_type"] == "SaveVideo"
    assert p_interp["7"]["inputs"]["format"] == "auto"



