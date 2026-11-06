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

## Running as a `systemd` Service

Install and enable `deploy/comfyui-studio.service` so ComfyUI Studio starts automatically on boot alongside `comfyui.service`:

```bash
sudo cp deploy/comfyui-studio.service /etc/systemd/system/comfyui-studio.service
sudo systemctl daemon-reload
sudo systemctl enable --now comfyui-studio.service
sudo systemctl status comfyui-studio.service
```
