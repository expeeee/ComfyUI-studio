from __future__ import annotations

import asyncio
import mimetypes
from pathlib import Path
from typing import Any

import httpx

from fastapi import FastAPI, File, HTTPException, Query, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.artcraft import create_artcraft_router
from app.assistant.router import create_assistant_router
from app.comfy.client import ComfyUIClient
from app.config import settings
from app.db import StudioDatabase
from app.downloads.manager import ModelDownloadManager, get_disk_status
from app.runs.tracker import RunExecutionTracker
from app.templates.compiler import compile_workflow_to_api_prompt
from app.templates.inspector import TemplateCatalogInspector
from app.templates.parameters import extract_template_parameters
from app.video.ffmpeg_router import create_video_router

app = FastAPI(title="ComfyUI Studio API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

db = StudioDatabase()
custom_comfy_url = db.get_setting("comfyui_url")
comfy_client = ComfyUIClient(base_url=custom_comfy_url)
inspector = TemplateCatalogInspector()
download_manager = ModelDownloadManager(db=db)
run_tracker = RunExecutionTracker(db=db, comfy=comfy_client)


class InstallTemplateRequest(BaseModel):
    default_overrides: dict[str, Any] = Field(default_factory=dict)


class InstallModelsRequest(BaseModel):
    template_id: str
    model_keys: list[str] = Field(default_factory=list)


class CreateRunRequest(BaseModel):
    template_id: str
    fields: dict[str, Any] = Field(default_factory=dict)
    segment_seconds: float | None = None


class ToggleFavoriteRequest(BaseModel):
    favorite: bool | None = None


class ImportAssetUrlRequest(BaseModel):
    url: str
    filename: str | None = None


class UpdateSettingsRequest(BaseModel):
    hf_token: str | None = None
    civitai_token: str | None = None
    comfyui_url: str | None = None
    default_segment_seconds: int | None = None
    ai_engine_url: str | None = None
    ai_engine_model: str | None = None


@app.get("/api/health")
async def get_health() -> dict[str, Any]:
    disk = get_disk_status(settings.models_root)
    comfy_stats: dict[str, Any] = {}
    comfy_online = False
    try:
        comfy_stats = await comfy_client.get_system_stats()
        comfy_online = True
    except Exception as exc:
        comfy_stats = {"error": str(exc)}

    return {
        "status": "ok" if comfy_online else "degraded",
        "comfyui_online": comfy_online,
        "comfyui_url": comfy_client.base_url,
        "models_root": str(settings.models_root),
        "disk": disk,
        "comfyui_system": comfy_stats,
    }


@app.get("/api/templates")
async def list_templates(
    category: str | None = None,
    status: str | None = None,
    installed_only: bool = False,
    favorites_only: bool = False,
    q: str | None = None,
) -> dict[str, Any]:
    obj_info: dict[str, Any] = {}
    try:
        obj_info = await comfy_client.get_object_info()
    except Exception:
        pass
    available_nodes = set(obj_info.keys()) if obj_info else None
    installed_ids = db.list_installed_ids()
    favorite_ids = db.list_favorite_ids()

    all_items = inspector.list_templates(
        available_nodes=available_nodes,
        installed_ids=installed_ids,
        favorite_ids=favorite_ids,
    )

    counts = {
        "total": len(all_items),
        "ready": sum(1 for t in all_items if t.status == "ready"),
        "needs_models": sum(1 for t in all_items if t.status == "needs_models"),
        "needs_nodes": sum(1 for t in all_items if t.status == "needs_nodes"),
        "paid_api": sum(1 for t in all_items if t.status == "paid_api"),
        "installed": sum(1 for t in all_items if t.installed),
        "favorites": sum(1 for t in all_items if t.favorite),
    }
    categories = sorted({t.category for t in all_items})

    filtered = all_items
    if category and category.lower() != "all":
        filtered = [t for t in filtered if t.category.lower() == category.lower()]
    if status and status.lower() != "all":
        if status == "local":
            filtered = [t for t in filtered if t.status in ("ready", "needs_models")]
        else:
            filtered = [t for t in filtered if t.status == status]
    if installed_only:
        filtered = [t for t in filtered if t.installed]
    if favorites_only:
        filtered = [t for t in filtered if t.favorite]
    if q:
        ql = q.strip().lower()
        filtered = [
            t
            for t in filtered
            if ql in t.title.lower()
            or ql in t.id.lower()
            or ql in t.description.lower()
            or any(ql in tag.lower() for tag in t.tags)
            or any(ql in mf.lower() for mf in t.model_families)
        ]

    # Sort: favorites first, then installed, then ready, then needs_models, by usage descending
    status_rank = {"ready": 0, "needs_models": 1, "needs_nodes": 2, "paid_api": 3}
    filtered.sort(
        key=lambda t: (
            0 if t.favorite else 1,
            0 if t.installed else 1,
            status_rank.get(t.status, 9),
            -t.usage,
        )
    )

    return {
        "counts": counts,
        "categories": categories,
        "templates": [t.to_dict() for t in filtered],
    }


@app.post("/api/templates/{template_id}/favorite")
async def toggle_template_favorite(
    template_id: str, req: ToggleFavoriteRequest | None = None
) -> dict[str, Any]:
    fav_state = db.toggle_favorite(template_id, req.favorite if req else None)
    return {"template_id": template_id, "favorite": fav_state}


@app.get("/api/templates/{template_id}")
async def get_template_detail(template_id: str) -> dict[str, Any]:
    obj_info: dict[str, Any] = {}
    try:
        obj_info = await comfy_client.get_object_info()
    except Exception:
        pass
    available_nodes = set(obj_info.keys()) if obj_info else None
    installed_ids = db.list_installed_ids()
    favorite_ids = db.list_favorite_ids()

    try:
        summary = inspector.get_template(
            template_id,
            available_nodes=available_nodes,
            installed_ids=installed_ids,
            favorite_ids=favorite_ids,
        )
        workflow, _ = inspector.load_workflow_json(template_id)
    except (KeyError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if summary.io_inputs:
        await asyncio.to_thread(inspector.stage_sample_inputs, template_id, summary.io_inputs)

    installed_rec = db.get_installed_template(template_id)
    saved_overrides = (installed_rec or {}).get("default_overrides") or {}

    parameters = extract_template_parameters(workflow, obj_info)
    param_dicts = []
    for p in parameters:
        pd = p.to_dict()
        if p.key in saved_overrides:
            pd["default"] = saved_overrides[p.key]
        param_dicts.append(pd)

    compiled_preview = compile_workflow_to_api_prompt(
        workflow, obj_info, field_overrides=saved_overrides
    )

    return {
        "template": summary.to_dict(),
        "installed_record": installed_rec,
        "parameters": param_dicts,
        "primary_parameters": [p for p in param_dicts if p["group"] == "primary"],
        "detail_parameters": [p for p in param_dicts if p["group"] == "details"],
        "disk": get_disk_status(settings.models_root),
        "downloads": db.list_downloads(template_id=template_id),
        "compiled_prompt": compiled_preview,
        "editor_workflow": workflow,
    }


@app.get("/api/templates/{template_id}/thumbnail")
async def get_template_thumbnail(template_id: str) -> Response:
    thumb_path = inspector.find_thumbnail_file(template_id)
    if not thumb_path or not thumb_path.is_file():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    media_type, _ = mimetypes.guess_type(str(thumb_path))
    return FileResponse(thumb_path, media_type=media_type or "image/webp")


@app.get("/api/templates/{template_id}/assets/{filename}")
async def get_template_asset(template_id: str, filename: str) -> Response:
    safe_name = Path(filename).name
    asset_path = await asyncio.to_thread(inspector.resolve_asset_file, template_id, safe_name)
    if not asset_path or not asset_path.is_file():
        raise HTTPException(status_code=404, detail="Template asset not found")
    media_type, _ = mimetypes.guess_type(str(asset_path))
    return FileResponse(asset_path, media_type=media_type or "application/octet-stream")


@app.post("/api/templates/{template_id}/install")
async def install_template(
    template_id: str, req: InstallTemplateRequest | None = None
) -> dict[str, Any]:
    obj_info = await comfy_client.get_object_info()
    available_nodes = set(obj_info.keys())
    try:
        summary = inspector.get_template(
            template_id,
            available_nodes=available_nodes,
            installed_ids=db.list_installed_ids(),
        )
        workflow, sha = inspector.load_workflow_json(template_id)
    except (KeyError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    # Compile and verify executable graph
    overrides = req.default_overrides if req else {}
    compiled = compile_workflow_to_api_prompt(workflow, obj_info, field_overrides=overrides)
    if not compiled:
        raise HTTPException(
            status_code=400, detail="Template did not compile into any executable ComfyUI nodes"
        )

    # Stage sample input assets (io.inputs) into ComfyUI's input directory
    staged_inputs = inspector.stage_sample_inputs(template_id, summary.io_inputs)

    rec = db.mark_template_installed(
        template_id=template_id,
        title=summary.title,
        source_sha256=sha,
        staged_inputs=staged_inputs,
        default_overrides=overrides,
    )
    summary.installed = True
    return {
        "installed": True,
        "record": rec,
        "staged_inputs": staged_inputs,
        "template": summary.to_dict(),
    }


@app.post("/api/models/install")
async def install_models(req: InstallModelsRequest) -> dict[str, Any]:
    try:
        summary = inspector.get_template(req.template_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    target_keys = set(req.model_keys) if req.model_keys else {m.key for m in summary.models if not m.installed}
    started: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    for m in summary.models:
        if m.key not in target_keys and m.name not in target_keys:
            continue
        if not m.url:
            errors.append({"model": m.key, "error": "No verified download URL declared in template metadata"})
            continue
        try:
            job = download_manager.enqueue_download(
                template_id=req.template_id,
                model_key=m.key,
                filename=m.name,
                directory=m.directory,
                url=m.url,
            )
            started.append(job)
        except Exception as exc:
            errors.append({"model": m.key, "error": str(exc)})

    return {
        "template_id": req.template_id,
        "downloads": started,
        "errors": errors,
    }


@app.get("/api/downloads")
async def list_downloads(template_id: str | None = None) -> dict[str, Any]:
    return {"downloads": db.list_downloads(template_id=template_id)}


@app.get("/api/downloads/{download_id}")
async def get_download(download_id: str) -> dict[str, Any]:
    rec = db.get_download(download_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Download job not found")
    return rec


@app.post("/api/downloads/{download_id}/cancel")
async def cancel_download(download_id: str) -> dict[str, Any]:
    rec = download_manager.cancel_download(download_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Download job not found")
    return rec


@app.post("/api/assets")
@app.post("/api/assets/upload")
async def upload_asset(file: UploadFile = File(...)) -> dict[str, Any]:
    import urllib.parse

    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")
    safe_name = Path(file.filename).name
    content = await file.read()
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(content) > 500 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Uploaded file exceeds 500MB limit")

    res = await comfy_client.upload_image(
        filename=safe_name,
        content=content,
        content_type=file.content_type or "image/png",
    )
    actual_name = res.get("name", safe_name)
    sample_dir = settings.data_dir / "sample_inputs"
    sample_dir.mkdir(parents=True, exist_ok=True)
    (sample_dir / Path(actual_name).name).write_bytes(content)

    qs = urllib.parse.urlencode(
        {"filename": actual_name, "subfolder": res.get("subfolder", ""), "type": res.get("type", "input")}
    )
    return {
        "name": actual_name,
        "filename": actual_name,
        "subfolder": res.get("subfolder", ""),
        "type": res.get("type", "input"),
        "url": f"/api/view?{qs}",
    }


@app.post("/api/assets/from-url")
async def import_asset_from_url(req: ImportAssetUrlRequest) -> dict[str, Any]:
    import hashlib
    import re
    from urllib.parse import urlparse

    import httpx

    raw_url = req.url.strip()
    parsed = urlparse(raw_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Please enter a valid http:// or https:// URL")
    host = (parsed.hostname or "").lower()
    if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        raise HTTPException(status_code=400, detail="Localhost URLs are not allowed")

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        )
    }

    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers=headers) as client:
        try:
            resp = await client.get(raw_url)
            resp.raise_for_status()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {exc}") from exc

        content_type = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
        content = resp.content

        # Support Google Photos shared links (photos.app.goo.gl / photos.google.com) via og:image
        if content_type == "text/html":
            html_text = resp.text
            og_match = re.search(
                r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
                html_text,
                re.IGNORECASE,
            ) or re.search(
                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
                html_text,
                re.IGNORECASE,
            )
            if not og_match:
                raise HTTPException(
                    status_code=400,
                    detail="URL returned an HTML page without a direct media or og:image preview. Right-click the photo and select 'Copy image' or 'Copy image address'.",
                )
            media_url = og_match.group(1).replace("&amp;", "&")
            if "lh3.googleusercontent.com" in media_url and "=" in media_url:
                media_url = media_url.rsplit("=", 1)[0] + "=d"
            resp2 = await client.get(media_url)
            resp2.raise_for_status()
            content = resp2.content
            content_type = (
                (resp2.headers.get("content-type") or "image/jpeg").split(";")[0].strip().lower()
            )

    if not content:
        raise HTTPException(status_code=400, detail="Fetched URL returned empty content")
    if len(content) > 500 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Fetched media exceeds 500MB limit")

    ext_map = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "video/quicktime": ".mov",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
    }
    ext = ext_map.get(content_type) or Path(parsed.path).suffix.lower() or ".jpg"
    if not ext.startswith("."):
        ext = f".{ext}"

    if req.filename:
        safe_name = Path(req.filename).name
        if not Path(safe_name).suffix:
            safe_name = f"{safe_name}{ext}"
    else:
        url_basename = Path(parsed.path).name
        if url_basename and Path(url_basename).suffix.lower() in ext_map.values():
            safe_name = url_basename
        else:
            short_hash = hashlib.sha256(content[:65536]).hexdigest()[:10]
            safe_name = f"imported_{short_hash}{ext}"

    res = await comfy_client.upload_image(
        filename=safe_name,
        content=content,
        content_type=content_type or "image/jpeg",
    )
    actual_name = res.get("name", safe_name)
    sample_dir = settings.data_dir / "sample_inputs"
    sample_dir.mkdir(parents=True, exist_ok=True)
    (sample_dir / Path(actual_name).name).write_bytes(content)

    import urllib.parse

    qs = urllib.parse.urlencode(
        {"filename": actual_name, "subfolder": res.get("subfolder", ""), "type": res.get("type", "input")}
    )
    media_kind = "video" if ext in (".mp4", ".webm", ".mov", ".mkv") else "image"
    return {
        "name": actual_name,
        "filename": actual_name,
        "subfolder": res.get("subfolder", ""),
        "type": res.get("type", "input"),
        "media_kind": media_kind,
        "url": f"/api/view?{qs}",
    }


@app.post("/api/runs")
async def create_run(req: CreateRunRequest) -> dict[str, Any]:
    obj_info = await comfy_client.get_object_info()
    available_nodes = set(obj_info.keys())
    try:
        summary = inspector.get_template(
            req.template_id,
            available_nodes=available_nodes,
            installed_ids=db.list_installed_ids(),
        )
        workflow, sha = inspector.load_workflow_json(req.template_id)
    except (KeyError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if summary.missing_nodes:
        raise HTTPException(
            status_code=400,
            detail=f"Template requires missing custom nodes: {', '.join(summary.missing_nodes)}",
        )
    if summary.missing_models:
        raise HTTPException(
            status_code=400,
            detail=f"Missing required models: {', '.join(summary.missing_models)}. Please download missing models first.",
        )

    # Ensure sample inputs are staged and template is marked installed
    staged_inputs = inspector.stage_sample_inputs(req.template_id, summary.io_inputs)
    if not summary.installed:
        db.mark_template_installed(
            template_id=req.template_id,
            title=summary.title,
            source_sha256=sha,
            staged_inputs=staged_inputs,
        )

    if req.segment_seconds and req.segment_seconds > 0:
        parameters = extract_template_parameters(workflow, obj_info)
        video_param = next((p for p in parameters if p.param_type == "video"), None)
        if video_param:
            video_filename = str(req.fields.get(video_param.key) or video_param.default or "")
            if video_filename:
                return await run_tracker.start_segmented_video_run(
                    template_id=req.template_id,
                    template_title=summary.title,
                    workflow=workflow,
                    obj_info=obj_info,
                    fields=req.fields,
                    video_param_key=video_param.key,
                    video_filename=video_filename,
                    segment_seconds=float(req.segment_seconds),
                )

    api_prompt = compile_workflow_to_api_prompt(
        workflow, obj_info, field_overrides=req.fields
    )
    run_record = await run_tracker.start_run(
        template_id=req.template_id,
        template_title=summary.title,
        fields=req.fields,
        api_prompt=api_prompt,
    )
    return run_record


@app.get("/api/runs")
async def list_runs(template_id: str | None = None, limit: int = 50) -> dict[str, Any]:
    return {"runs": db.list_runs(template_id=template_id, limit=limit)}


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str) -> dict[str, Any]:
    rec = db.get_run(run_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Run not found")
    run_tracker.ensure_monitoring(rec)
    return rec


@app.post("/api/runs/{run_id}/cancel")
async def cancel_run(run_id: str) -> dict[str, Any]:
    rec = await run_tracker.cancel_run(run_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Run not found")
    return rec


@app.delete("/api/runs/{run_id}")
async def delete_run(run_id: str) -> dict[str, Any]:
    deleted = await run_tracker.delete_run(run_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"deleted": True, "run_id": run_id}


@app.get("/api/view")
async def proxy_comfy_view(
    filename: str = Query(...),
    subfolder: str = Query(""),
    type: str = Query("output"),
) -> Response:
    try:
        content, content_type = await comfy_client.fetch_view(
            filename=filename, subfolder=subfolder, folder_type=type
        )
        return Response(content=content, media_type=content_type)
    except Exception as exc:
        safe_name = Path(filename).name
        for fallback_dir in (
            settings.data_dir / "sample_inputs",
            settings.data_dir / "stitched_outputs",
        ):
            candidate = fallback_dir / safe_name
            if candidate.is_file():
                media_type, _ = mimetypes.guess_type(str(candidate))
                return FileResponse(candidate, media_type=media_type or "application/octet-stream")
        raise HTTPException(status_code=404, detail=f"Media not found: {exc}") from exc


@app.get("/api/settings")
async def get_settings() -> dict[str, Any]:
    hf = db.get_setting("hf_token") or settings.hf_token or ""
    civ = db.get_setting("civitai_token") or settings.civitai_token or ""
    custom_comfy_url = db.get_setting("comfyui_url")
    effective_comfy_url = comfy_client.base_url
    default_seg_sec = int(db.get_setting("default_segment_seconds") or settings.default_segment_seconds)
    custom_ai_url = db.get_setting("ai_engine_url")
    effective_ai_url = custom_ai_url or settings.ai_engine_url
    effective_ai_model = db.get_setting("ai_engine_model") or settings.ai_engine_model
    return {
        "studio_host": settings.host,
        "studio_port": settings.port,
        "comfyui_url": effective_comfy_url,
        "default_comfyui_url": settings.comfyui_base_url,
        "is_custom_comfyui_url": bool(custom_comfy_url),
        "default_segment_seconds": default_seg_sec,
        "ai_engine_url": effective_ai_url,
        "default_ai_engine_url": settings.ai_engine_url,
        "is_custom_ai_engine_url": bool(custom_ai_url),
        "ai_engine_model": effective_ai_model,
        "default_ai_engine_model": settings.ai_engine_model,
        "models_root": str(settings.models_root),
        "data_dir": str(settings.data_dir),
        "has_hf_token": bool(hf),
        "hf_token_masked": f"{hf[:4]}...{hf[-4:]}" if len(hf) > 8 else ("***" if hf else ""),
        "has_civitai_token": bool(civ),
        "civitai_token_masked": f"{civ[:4]}...{civ[-4:]}" if len(civ) > 8 else ("***" if civ else ""),
    }


@app.post("/api/settings")
async def update_settings(req: UpdateSettingsRequest) -> dict[str, Any]:
    if req.hf_token is not None:
        db.set_setting("hf_token", req.hf_token.strip())
    if req.civitai_token is not None:
        db.set_setting("civitai_token", req.civitai_token.strip())
    if req.comfyui_url is not None:
        cleaned_url = req.comfyui_url.strip().rstrip("/")
        if cleaned_url and cleaned_url != settings.comfyui_base_url.rstrip("/"):
            db.set_setting("comfyui_url", cleaned_url)
            comfy_client.set_base_url(cleaned_url)
        else:
            db.delete_setting("comfyui_url")
            comfy_client.set_base_url(settings.comfyui_base_url)
    if req.default_segment_seconds is not None:
        if req.default_segment_seconds > 0:
            db.set_setting("default_segment_seconds", str(req.default_segment_seconds))
    if req.ai_engine_url is not None:
        cleaned_ai = req.ai_engine_url.strip().rstrip("/")
        if cleaned_ai and cleaned_ai != settings.ai_engine_url.rstrip("/"):
            db.set_setting("ai_engine_url", cleaned_ai)
        else:
            db.delete_setting("ai_engine_url")
    if req.ai_engine_model is not None:
        cleaned_m = req.ai_engine_model.strip()
        if cleaned_m and cleaned_m != settings.ai_engine_model:
            db.set_setting("ai_engine_model", cleaned_m)
        else:
            db.delete_setting("ai_engine_model")
    return await get_settings()


@app.get("/api/assistant/status")
async def get_assistant_status() -> dict[str, Any]:
    url = (db.get_setting("ai_engine_url") or settings.ai_engine_url).rstrip("/")
    model = db.get_setting("ai_engine_model") or settings.ai_engine_model
    online = False
    available_models: list[str] = []
    error = None
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(f"{url}/models")
            if resp.status_code == 200:
                online = True
                data = resp.json()
                items = data.get("data") or []
                available_models = [
                    m["id"] for m in items if isinstance(m, dict) and "id" in m
                ]
    except Exception as exc:
        error = str(exc)
    return {
        "online": online,
        "url": url,
        "active_model": model,
        "available_models": available_models,
        "error": error,
    }


# Mount AI Copilot & 3D Pipeline router (/api/assistant/*)
app.include_router(
    create_assistant_router(
        db=db,
        comfy_client=comfy_client,
        inspector=inspector,
        run_tracker=run_tracker,
    )
)

# Mount FFmpeg Video Studio router (/api/video/*)
app.include_router(create_video_router(comfy_client=comfy_client))

# Mount ArtCraft Storyteller & OmniGen /v1/* adapter routes
app.include_router(
    create_artcraft_router(
        db=db,
        comfy_client=comfy_client,
        inspector=inspector,
        run_tracker=run_tracker,
    )
)

# Mount built frontend if dist exists
frontend_dist = settings.frontend_dist_dir
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True), name="frontend")
