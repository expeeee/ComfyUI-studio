from __future__ import annotations

import asyncio
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import Settings, settings
from app.db import StudioDatabase

ALLOWED_MODEL_DIRECTORIES = {
    "checkpoints",
    "configs",
    "loras",
    "vae",
    "text_encoders",
    "diffusion_models",
    "clip",
    "clip_vision",
    "style_models",
    "embeddings",
    "diffusers",
    "vae_approx",
    "controlnet",
    "gligen",
    "upscale_models",
    "latent_upscale_models",
    "hypernetworks",
    "photomaker",
    "classifiers",
    "model_patches",
    "audio_encoders",
    "background_removal",
    "frame_interpolation",
    "geometry_estimation",
    "optical_flow",
    "detection",
    "unet",
}

ALLOWED_MODEL_HOSTS = {
    "huggingface.co",
    "hf.co",
    "civitai.com",
    "github.com",
    "objects.githubusercontent.com",
    "modelscope.cn",
}


def validate_download_target(
    url: str, directory: str, filename: str, models_root: Path
) -> Path:
    """Validate URL scheme/host and ensure target path stays strictly inside models_root."""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(f"Only HTTPS model URLs are permitted (got '{parsed.scheme}')")
    host = (parsed.hostname or "").lower()
    if not any(host == allowed or host.endswith(f".{allowed}") for allowed in ALLOWED_MODEL_HOSTS):
        raise ValueError(f"Host '{host}' is not in the allowed model provider list")

    if directory not in ALLOWED_MODEL_DIRECTORIES:
        raise ValueError(f"Model directory '{directory}' is not an allowed ComfyUI model folder")

    safe_name = Path(filename).name
    if not safe_name or safe_name != filename or ".." in filename or "/" in filename or "\\" in filename:
        raise ValueError(f"Unsafe model filename: '{filename}'")

    resolved_root = models_root.resolve()
    target_dir = (resolved_root / directory).resolve()
    if not str(target_dir).startswith(str(resolved_root)):
        raise ValueError("Target directory escapes models_root")

    target_file = target_dir / safe_name
    return target_file


def get_disk_status(models_root: Path) -> dict[str, int]:
    check_path = models_root if models_root.exists() else models_root.parent
    usage = shutil.disk_usage(check_path)
    return {
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
    }


class ModelDownloadManager:
    def __init__(self, db: StudioDatabase, cfg: Settings = settings) -> None:
        self.db = db
        self.cfg = cfg
        self._active_tasks: dict[str, asyncio.Task[None]] = {}
        self._cancel_flags: set[str] = set()

    def build_auth_headers(self, url: str) -> dict[str, str]:
        headers: dict[str, str] = {"User-Agent": "ComfyUI-Studio/0.1"}
        host = (urlparse(url).hostname or "").lower()
        hf_token = self.db.get_setting("hf_token") or self.cfg.hf_token
        civitai_token = self.db.get_setting("civitai_token") or self.cfg.civitai_token
        if ("huggingface.co" in host or "hf.co" in host) and hf_token:
            headers["Authorization"] = f"Bearer {hf_token}"
        elif "civitai.com" in host and civitai_token:
            headers["Authorization"] = f"Bearer {civitai_token}"
        return headers

    def enqueue_download(
        self,
        template_id: str,
        model_key: str,
        filename: str,
        directory: str,
        url: str,
    ) -> dict[str, Any]:
        target_path = validate_download_target(url, directory, filename, self.cfg.models_root)
        # If already installed and non-empty, return installed immediately
        if target_path.is_file() and target_path.stat().st_size > 0:
            st = target_path.stat()
            dl_id = f"dl-{uuid.uuid4().hex[:12]}"
            return self.db.upsert_download(
                {
                    "id": dl_id,
                    "template_id": template_id,
                    "model_key": model_key,
                    "filename": filename,
                    "directory": directory,
                    "url": url,
                    "target_path": str(target_path),
                    "status": "installed",
                    "bytes_downloaded": st.st_size,
                    "total_bytes": st.st_size,
                    "speed_bps": 0.0,
                }
            )

        # Check if there is already an active download for this target_path
        for existing in self.db.list_downloads(template_id=template_id):
            if (
                existing["target_path"] == str(target_path)
                and existing["status"] in ("queued", "downloading")
                and existing["id"] in self._active_tasks
            ):
                return existing

        dl_id = f"dl-{uuid.uuid4().hex[:12]}"
        record = self.db.upsert_download(
            {
                "id": dl_id,
                "template_id": template_id,
                "model_key": model_key,
                "filename": filename,
                "directory": directory,
                "url": url,
                "target_path": str(target_path),
                "status": "queued",
                "bytes_downloaded": 0,
                "total_bytes": None,
                "speed_bps": 0.0,
            }
        )
        task = asyncio.create_task(self._run_download(dl_id))
        self._active_tasks[dl_id] = task
        return record

    def cancel_download(self, download_id: str) -> dict[str, Any] | None:
        self._cancel_flags.add(download_id)
        task = self._active_tasks.get(download_id)
        if task and not task.done():
            task.cancel()
        rec = self.db.get_download(download_id)
        if rec and rec["status"] in ("queued", "downloading"):
            rec["status"] = "cancelled"
            rec["speed_bps"] = 0.0
            return self.db.upsert_download(rec)
        return rec

    async def _run_download(self, download_id: str) -> None:
        rec = self.db.get_download(download_id)
        if not rec:
            return
        target_path = Path(rec["target_path"])
        target_path.parent.mkdir(parents=True, exist_ok=True)
        partial_path = target_path.with_name(f"{target_path.name}.partial")

        resume_bytes = partial_path.stat().st_size if partial_path.is_file() else 0
        headers = self.build_auth_headers(rec["url"])
        if resume_bytes > 0:
            headers["Range"] = f"bytes={resume_bytes}-"

        rec["status"] = "downloading"
        rec["bytes_downloaded"] = resume_bytes
        self.db.upsert_download(rec)

        try:
            timeout = httpx.Timeout(connect=20.0, read=60.0, write=20.0, pool=20.0)
            async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
                async with client.stream("GET", rec["url"], headers=headers) as resp:
                    if resp.status_code in (401, 403):
                        raise PermissionError(
                            f"Access denied ({resp.status_code}). This model may require a Hugging Face token in Studio Settings."
                        )
                    resp.raise_for_status()

                    is_partial_resp = resp.status_code == 206
                    if not is_partial_resp:
                        resume_bytes = 0

                    content_len = resp.headers.get("Content-Length")
                    total_bytes = (
                        int(content_len) + resume_bytes if content_len and content_len.isdigit() else None
                    )
                    if total_bytes:
                        free_bytes = get_disk_status(self.cfg.models_root)["free_bytes"]
                        needed = total_bytes - resume_bytes
                        if needed > free_bytes - (512 * 1024 * 1024):
                            raise OSError(
                                f"Insufficient disk space on {self.cfg.models_root} (need {needed} bytes, free {free_bytes} bytes)"
                            )

                    mode = "ab" if is_partial_resp and resume_bytes > 0 else "wb"
                    downloaded = resume_bytes
                    last_flush = time.time()
                    bytes_since_last = 0

                    with open(partial_path, mode) as f:
                        async for chunk in resp.aiter_bytes(chunk_size=1024 * 256):
                            if download_id in self._cancel_flags:
                                raise asyncio.CancelledError()
                            f.write(chunk)
                            downloaded += len(chunk)
                            bytes_since_last += len(chunk)
                            now = time.time()
                            elapsed = now - last_flush
                            if elapsed >= 0.5:
                                speed = bytes_since_last / elapsed
                                rec.update(
                                    {
                                        "status": "downloading",
                                        "bytes_downloaded": downloaded,
                                        "total_bytes": total_bytes,
                                        "speed_bps": speed,
                                    }
                                )
                                self.db.upsert_download(rec)
                                last_flush = now
                                bytes_since_last = 0

                        f.flush()
                        os.fsync(f.fileno())

                    if total_bytes and downloaded < total_bytes:
                        raise IOError(
                            f"Incomplete download: received {downloaded} of {total_bytes} bytes"
                        )

                    os.replace(partial_path, target_path)
                    rec.update(
                        {
                            "status": "installed",
                            "bytes_downloaded": downloaded,
                            "total_bytes": total_bytes or downloaded,
                            "speed_bps": 0.0,
                            "error": None,
                        }
                    )
                    self.db.upsert_download(rec)

        except asyncio.CancelledError:
            rec.update({"status": "cancelled", "speed_bps": 0.0})
            self.db.upsert_download(rec)
        except Exception as exc:
            rec.update(
                {
                    "status": "failed",
                    "speed_bps": 0.0,
                    "error": str(exc),
                }
            )
            self.db.upsert_download(rec)
        finally:
            self._active_tasks.pop(download_id, None)
            self._cancel_flags.discard(download_id)
