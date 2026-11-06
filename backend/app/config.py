from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from dotenv import load_dotenv

STUDIO_ROOT = Path(__file__).resolve().parents[2]

# Automatically load .env if present
if (STUDIO_ROOT / ".env").is_file():
    load_dotenv(STUDIO_ROOT / ".env")
else:
    load_dotenv()


def derive_ws_url(http_url: str) -> str:
    url = http_url.rstrip("/")
    if url.startswith("https://"):
        return "wss://" + url[8:] + "/ws"
    elif url.startswith("http://"):
        return "ws://" + url[7:] + "/ws"
    return f"ws://{url}/ws"


@dataclass
class Settings:
    host: str = os.environ.get("STUDIO_HOST", "0.0.0.0")
    port: int = int(os.environ.get("STUDIO_PORT", "8190"))

    comfyui_base_url: str = os.environ.get("STUDIO_COMFYUI_URL", "http://127.0.0.1:8188")
    comfyui_ws_url: str = os.environ.get("STUDIO_COMFYUI_WS_URL") or derive_ws_url(
        os.environ.get("STUDIO_COMFYUI_URL", "http://127.0.0.1:8188")
    )

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

    default_segment_seconds: int = int(os.environ.get("STUDIO_DEFAULT_SEGMENT_SECONDS", "10"))
    cors_origins: list[str] = field(
        default_factory=lambda: [
            o.strip()
            for o in os.environ.get("STUDIO_CORS_ORIGINS", "*").split(",")
            if o.strip()
        ]
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
