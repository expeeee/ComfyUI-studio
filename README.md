# ComfyUI Studio

A template-led web workspace and **ArtCraft Storyteller / OmniGen (`/v1/*`) bridge** for self-hosted **ComfyUI** (`0.44+`).

ComfyUI Studio turns ComfyUI's 650+ official workflow templates (including modern subgraph templates) into a guided 4-step studio for **Image, Video, 3D (GLB / OBJ / PLY / Splat), and Audio** generation — without modifying `/opt/comfyui/ComfyUI` or `/Beta/ComfyUI/models`.

---

## Key Features

- **Template Discovery & Readiness Inspection:** Automatically inspects all installed ComfyUI templates against your live ComfyUI `/object_info` node registry and `/Beta/ComfyUI/models` directory (`Ready`, `Needs Models`, `Needs Nodes`, `Paid API`), with **`★` Favorites** filtering.
- **Subgraph-Aware Workflow Compiler:** Expands ComfyUI 0.44+ `definitions.subgraphs` (such as `image_z_image_turbo`, `video_wan2_2_14B_i2v`, and `3d_hunyuan3d-v2.1`) into executable ComfyUI `/prompt` graphs with dynamic parameter overrides.
- **Safe Model Installer:** One-click background model downloader with disk-space preflight checks, HTTPS domain allowlisting (`huggingface.co`, `civitai.com`), and optional Hugging Face / CivitAI token support.
- **Rich Input & Media Controls:**
  - Drag & Drop, Clipboard Paste (`Ctrl+V`), File Picker, and URL / Google Photos link import (`POST /api/assets/from-url`).
  - **Long-Video Segmented Batch Mode:** Splits long videos (e.g., 60-minute videos) into configurable `ffmpeg` chunks, runs each segment sequentially through ComfyUI, and losslessly stitches the upscaled output back into a single `.mp4`.
- **Built-in Three.js 3D Viewer:** Interactive WebGL viewer (`GLTFLoader`, `OBJLoader`, `PLYLoader`, `OrbitControls`) with Auto-Rotate, Wireframe, and Reset View controls, plus direct file download.
- **ArtCraft Desktop Integration (`/v1/*` Adapter):** Built-in Storyteller & OmniGen API compatibility layer (`app/artcraft.py`) so the [ArtCraft](https://github.com/storytold/artcraft) desktop app can use all Ready and `★` Favorited local ComfyUI templates across Image, Video, 3D Mesh, 3D Splat, and Audio with zero manual `workflow_api.json` exports.

---

## Project Layout

```text
studio/
├── backend/
│   ├── app/
│   │   ├── artcraft.py        # ArtCraft Storyteller & OmniGen (/v1/*) adapter
│   │   ├── config.py          # Environment-configurable paths & settings
│   │   ├── db.py              # SQLite persistence (favorites, runs, downloads, media)
│   │   ├── main.py            # FastAPI application & REST endpoints (/api/*)
│   │   ├── comfy/client.py    # Async HTTP + WebSocket client for ComfyUI (:8188)
│   │   ├── downloads/         # Safe background model downloader & disk checks
│   │   ├── runs/tracker.py    # Live WebSocket run tracker & ffmpeg segmented batch mode
│   │   └── templates/         # Catalog inspector, subgraph compiler, parameter extractor
│   ├── tests/                 # Pytest unit & integration suite
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── App.tsx            # 4-Step Studio UI
│   │   ├── Model3DViewer.tsx  # Built-in Three.js 3D viewer (.glb/.gltf/.obj/.ply)
│   │   ├── api.ts             # Typed API client
│   │   └── styles.css
│   └── package.json
├── deploy/
│   └── comfyui-studio.service # systemd unit file
├── .env.example
├── .gitignore
└── start.sh
```

---

## Development & Build

### 1. Backend
```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e . pytest
.venv/bin/pytest -v
```

### 2. Frontend
```bash
cd frontend
npm install
npm run build
```

### 3. Run Manually
```bash
./start.sh
# Listening on http://0.0.0.0:8190
```

---

## Configuration

ComfyUI Studio supports configuration via environment variables, `.env` file, and dynamic runtime configuration in the Web UI:

### 1. Environment Variables & `.env`

Copy `.env.example` to `.env` in the `studio/` root to set overrides:

```bash
cp .env.example .env
```

| Variable | Default | Description |
| :--- | :--- | :--- |
| `STUDIO_HOST` | `0.0.0.0` | IP address or interface ComfyUI Studio listens on |
| `STUDIO_PORT` | `8190` | Port ComfyUI Studio listens on |
| `STUDIO_COMFYUI_URL` | `http://127.0.0.1:8188` | Default upstream ComfyUI HTTP server URL |
| `STUDIO_COMFYUI_WS_URL` | `ws://127.0.0.1:8188/ws` | Default ComfyUI WebSocket endpoint (auto-derived if omitted) |
| `STUDIO_MODELS_ROOT` | `/Beta/ComfyUI/models` | Base storage directory for model weights |
| `STUDIO_COMFYUI_ROOT` | `/opt/comfyui/ComfyUI` | Base directory of the ComfyUI installation |
| `STUDIO_COMFYUI_SITE_PACKAGES` | `/opt/comfyui/venv/lib/python3.12/site-packages` | Path to ComfyUI's python site-packages (for templates) |
| `STUDIO_DATA_DIR` | `studio/data` | SQLite DB, cached sample inputs, and video segment stitches |
| `STUDIO_FRONTEND_DIST_DIR` | `studio/frontend/dist` | Built Vite frontend distribution directory |
| `STUDIO_DEFAULT_SEGMENT_SECONDS` | `10` | Default segment duration for long-video batching |
| `STUDIO_CORS_ORIGINS` | `*` | Allowed CORS origins (comma-separated, e.g. `http://localhost:5173`) |
| `HF_TOKEN` | _None_ | Hugging Face user access token for gated models |
| `CIVITAI_TOKEN` | _None_ | CivitAI API token for authenticated model downloads |

### 2. Runtime Web UI Settings (`⚙ Studio Settings`)

Click the **`⚙ Studio Settings`** button in the top navigation bar to configure settings live in the browser without restarting the service:
- **ComfyUI Server URL:** Point Studio to any local, LAN, or remote ComfyUI instance on the fly (with a one-click **Reset Default** button).
- **Model Provider Tokens:** Securely save Hugging Face and CivitAI tokens directly to local SQLite.
- **Workflow Defaults:** Adjust default chunk seconds for long-video batching.
- **System & Environment Overview:** View active bind address, models root, data directory, and live ComfyUI version/status.

---

## Running as a `systemd` Service

Install and enable `deploy/comfyui-studio.service` so ComfyUI Studio starts automatically on boot alongside `comfyui.service`:

```bash
sudo cp deploy/comfyui-studio.service /etc/systemd/system/comfyui-studio.service
sudo systemctl daemon-reload
sudo systemctl enable --now comfyui-studio.service
sudo systemctl status comfyui-studio.service
```
