#!/usr/bin/env bash
set -euo pipefail
STUDIO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Load .env file if present
if [[ -f "$STUDIO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$STUDIO_ROOT/.env"
  set +a
fi

cd "$STUDIO_ROOT/backend"
exec "$STUDIO_ROOT/backend/.venv/bin/uvicorn" app.main:app --host "${STUDIO_HOST:-0.0.0.0}" --port "${STUDIO_PORT:-8190}"
