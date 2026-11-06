from __future__ import annotations

import time
import uuid
from typing import Any

import httpx

from app.config import Settings, derive_ws_url, settings


class ComfyUIClient:
    def __init__(self, cfg: Settings = settings, base_url: str | None = None) -> None:
        self.cfg = cfg
        self.base_url = (base_url or cfg.comfyui_base_url).rstrip("/")
        self._object_info_cache: dict[str, Any] | None = None
        self._object_info_ts: float = 0.0

    @property
    def ws_url(self) -> str:
        return derive_ws_url(self.base_url)

    def set_base_url(self, url: str) -> None:
        self.base_url = url.rstrip("/")
        self._object_info_cache = None
        self._object_info_ts = 0.0

    async def get_system_stats(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self.base_url}/system_stats")
            resp.raise_for_status()
            return resp.json()

    async def get_object_info(self, refresh: bool = False) -> dict[str, Any]:
        now = time.time()
        if not refresh and self._object_info_cache is not None and (now - self._object_info_ts) < 60.0:
            return self._object_info_cache
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(f"{self.base_url}/object_info")
            resp.raise_for_status()
            data = resp.json()
            self._object_info_cache = data
            self._object_info_ts = now
            return data

    async def get_models_in_folder(self, folder: str) -> list[str]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self.base_url}/models/{folder}")
            if resp.status_code == 404:
                return []
            resp.raise_for_status()
            return resp.json()

    async def upload_image(
        self, filename: str, content: bytes, content_type: str = "image/png", overwrite: bool = True
    ) -> dict[str, Any]:
        files = {"image": (filename, content, content_type)}
        data = {"overwrite": "true" if overwrite else "false", "type": "input"}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{self.base_url}/upload/image", files=files, data=data)
            resp.raise_for_status()
            return resp.json()

    async def submit_prompt(
        self, prompt: dict[str, Any], client_id: str | None = None
    ) -> dict[str, Any]:
        cid = client_id or f"studio-{uuid.uuid4().hex[:12]}"
        payload = {"prompt": prompt, "client_id": cid}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{self.base_url}/prompt", json=payload)
            if resp.status_code >= 400:
                try:
                    err_body = resp.json()
                except Exception:
                    err_body = {"error": resp.text}
                raise ValueError(f"ComfyUI rejected prompt: {err_body}")
            result = resp.json()
            result["client_id"] = cid
            return result

    async def get_queue(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self.base_url}/queue")
            resp.raise_for_status()
            return resp.json()

    async def get_history(self, prompt_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self.base_url}/history/{prompt_id}")
            resp.raise_for_status()
            return resp.json()

    async def interrupt_or_delete_from_queue(self, prompt_id: str) -> dict[str, Any]:
        queue = await self.get_queue()
        running = queue.get("queue_running") or []
        pending = queue.get("queue_pending") or []

        is_running = any(len(item) > 1 and item[1] == prompt_id for item in running)
        is_pending = any(len(item) > 1 and item[1] == prompt_id for item in pending)

        async with httpx.AsyncClient(timeout=10.0) as client:
            if is_pending:
                await client.post(f"{self.base_url}/queue", json={"delete": [prompt_id]})
                return {"action": "deleted_from_queue", "prompt_id": prompt_id}
            if is_running:
                await client.post(f"{self.base_url}/interrupt", json={"prompt_id": prompt_id})
                return {"action": "interrupted", "prompt_id": prompt_id}
        return {"action": "not_active", "prompt_id": prompt_id}

    async def fetch_view(
        self, filename: str, subfolder: str = "", folder_type: str = "output"
    ) -> tuple[bytes, str]:
        params = {"filename": filename, "subfolder": subfolder, "type": folder_type}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(f"{self.base_url}/view", params=params)
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "application/octet-stream")
            return resp.content, content_type
