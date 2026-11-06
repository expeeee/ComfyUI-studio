from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

STUDIO_ROOT = Path(__file__).resolve().parents[2]


@dataclass
class Settings:
    comfyui_base_url: str = os.environ.get("STUDIO_COMFYUI_URL", "http://127.0.0.1:8188")
    comfyui_ws_url: str = os.environ.get("STUDIO_COMFYUI_WS_URL", "ws://127.0.0.1:8188/ws")
    comfyui_site_packages: Path = Path(
        os.environ.get(
            "STUDIO_COMFYUI_SITE_PACKAGES",
            "/opt/comfyui/venv/lib/python3.12/site-packages",
        )
    )
    comfyui_root: Path = Path(os.environ.get("STUDIO_COMFYUI_ROOT", "/opt/comfyui/ComfyUI"))
    models_root: Path = Path(os.environ.get("STUDIO_MODELS_ROOT", "/Beta/ComfyUI/models"))
    data_dir: Path = Path(os.environ.get("STUDIO_DATA_DIR", str(STUDIO_ROOT / "data")))
    frontend_dist_dir: Path = Path(
        os.environ.get("STUDIO_FRONTEND_DIST_DIR", str(STUDIO_ROOT / "frontend" / "dist"))
    )
    hf_token: str | None = os.environ.get("HF_TOKEN")
    civitai_token: str | None = os.environ.get("CIVITAI_TOKEN")

    @property
    def db_path(self) -> Path:
        return self.data_dir / "studio.db"

    @property
    def templates_json_dir(self) -> Path:
        return self.comfyui_site_packages / "comfyui_workflow_templates_json" / "templates"

    @property
    def templates_core_dir(self) -> Path:
        return self.comfyui_site_packages / "comfyui_workflow_templates_core"

    @property
    def comfyui_input_dir(self) -> Path:
        return self.comfyui_root / "input"


settings = Settings()
