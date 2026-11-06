#!/usr/bin/env bash
set -euo pipefail
STUDIO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$STUDIO_ROOT/backend"
exec "$STUDIO_ROOT/backend/.venv/bin/uvicorn" app.main:app --host "${STUDIO_HOST:-0.0.0.0}" --port "${STUDIO_PORT:-8190}"
