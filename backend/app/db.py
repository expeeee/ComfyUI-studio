from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from app.config import settings

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS installed_templates (
    template_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    staged_inputs_json TEXT NOT NULL DEFAULT '[]',
    default_overrides_json TEXT NOT NULL DEFAULT '{}',
    installed_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    model_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    directory TEXT NOT NULL,
    url TEXT NOT NULL,
    target_path TEXT NOT NULL,
    status TEXT NOT NULL,
    bytes_downloaded INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER,
    speed_bps REAL NOT NULL DEFAULT 0,
    error TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    template_title TEXT NOT NULL,
    prompt_id TEXT,
    status TEXT NOT NULL,
    progress_step INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    current_node TEXT,
    fields_json TEXT NOT NULL DEFAULT '{}',
    api_prompt_json TEXT NOT NULL DEFAULT '{}',
    outputs_json TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at REAL NOT NULL,
    completed_at REAL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
    template_id TEXT PRIMARY KEY,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS artcraft_media (
    token TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    subfolder TEXT NOT NULL DEFAULT '',
    folder_type TEXT NOT NULL DEFAULT 'output',
    media_class TEXT NOT NULL DEFAULT 'image',
    media_type TEXT NOT NULL DEFAULT 'png',
    title TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    run_id TEXT,
    is_user_upload INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
"""


class StudioDatabase:
    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or settings.db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(SCHEMA_SQL)
            conn.commit()

    # --- Installed Templates ---
    def mark_template_installed(
        self,
        template_id: str,
        title: str,
        source_sha256: str,
        staged_inputs: list[str] | None = None,
        default_overrides: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO installed_templates
                    (template_id, title, source_sha256, staged_inputs_json, default_overrides_json, installed_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(template_id) DO UPDATE SET
                    title = excluded.title,
                    source_sha256 = excluded.source_sha256,
                    staged_inputs_json = excluded.staged_inputs_json,
                    default_overrides_json = excluded.default_overrides_json,
                    installed_at = excluded.installed_at
                """,
                (
                    template_id,
                    title,
                    source_sha256,
                    json.dumps(staged_inputs or []),
                    json.dumps(default_overrides or {}),
                    now,
                ),
            )
            conn.commit()
        return self.get_installed_template(template_id) or {}

    def get_installed_template(self, template_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM installed_templates WHERE template_id = ?", (template_id,)
            ).fetchone()
            if not row:
                return None
            return {
                "template_id": row["template_id"],
                "title": row["title"],
                "source_sha256": row["source_sha256"],
                "staged_inputs": json.loads(row["staged_inputs_json"]),
                "default_overrides": json.loads(row["default_overrides_json"]),
                "installed_at": row["installed_at"],
            }

    def list_installed_ids(self) -> set[str]:
        with self._connect() as conn:
            rows = conn.execute("SELECT template_id FROM installed_templates").fetchall()
            return {r["template_id"] for r in rows}

    # --- Favorites ---
    def toggle_favorite(self, template_id: str, favorite: bool | None = None) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM favorites WHERE template_id = ?", (template_id,)
            ).fetchone()
            currently_fav = row is not None
            target_state = (not currently_fav) if favorite is None else bool(favorite)
            if target_state and not currently_fav:
                conn.execute(
                    "INSERT INTO favorites (template_id, created_at) VALUES (?, ?)",
                    (template_id, time.time()),
                )
            elif not target_state and currently_fav:
                conn.execute("DELETE FROM favorites WHERE template_id = ?", (template_id,))
            conn.commit()
            return target_state

    def list_favorite_ids(self) -> set[str]:
        with self._connect() as conn:
            rows = conn.execute("SELECT template_id FROM favorites").fetchall()
            return {r["template_id"] for r in rows}

    # --- Downloads ---
    def upsert_download(self, record: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO downloads
                    (id, template_id, model_key, filename, directory, url, target_path,
                     status, bytes_downloaded, total_bytes, speed_bps, error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    bytes_downloaded = excluded.bytes_downloaded,
                    total_bytes = COALESCE(excluded.total_bytes, downloads.total_bytes),
                    speed_bps = excluded.speed_bps,
                    error = excluded.error,
                    updated_at = excluded.updated_at
                """,
                (
                    record["id"],
                    record["template_id"],
                    record["model_key"],
                    record["filename"],
                    record["directory"],
                    record["url"],
                    record["target_path"],
                    record["status"],
                    int(record.get("bytes_downloaded") or 0),
                    record.get("total_bytes"),
                    float(record.get("speed_bps") or 0.0),
                    record.get("error"),
                    record.get("created_at") or now,
                    now,
                ),
            )
            conn.commit()
        return self.get_download(record["id"]) or record

    def get_download(self, download_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM downloads WHERE id = ?", (download_id,)).fetchone()
            return dict(row) if row else None

    def list_downloads(self, template_id: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if template_id:
                rows = conn.execute(
                    "SELECT * FROM downloads WHERE template_id = ? ORDER BY created_at DESC",
                    (template_id,),
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM downloads ORDER BY created_at DESC LIMIT 100").fetchall()
            return [dict(r) for r in rows]

    # --- Runs ---
    def create_run(self, record: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO runs
                    (id, template_id, template_title, prompt_id, status, progress_step, progress_total,
                     current_node, fields_json, api_prompt_json, outputs_json, error, created_at, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    record["template_id"],
                    record["template_title"],
                    record.get("prompt_id"),
                    record.get("status", "queued"),
                    int(record.get("progress_step") or 0),
                    int(record.get("progress_total") or 0),
                    record.get("current_node"),
                    json.dumps(record.get("fields") or {}),
                    json.dumps(record.get("api_prompt") or {}),
                    json.dumps(record.get("outputs") or []),
                    record.get("error"),
                    record.get("created_at") or now,
                    record.get("completed_at"),
                ),
            )
            conn.commit()
        return self.get_run(record["id"]) or record

    def update_run(self, run_id: str, **updates: Any) -> dict[str, Any] | None:
        current = self.get_run(run_id)
        if not current:
            return None
        columns: list[str] = []
        values: list[Any] = []
        for k, v in updates.items():
            if k in ("fields", "api_prompt", "outputs"):
                columns.append(f"{k}_json = ?")
                values.append(json.dumps(v))
            elif k in (
                "prompt_id",
                "status",
                "progress_step",
                "progress_total",
                "current_node",
                "error",
                "completed_at",
            ):
                columns.append(f"{k} = ?")
                values.append(v)
        if columns:
            values.append(run_id)
            with self._connect() as conn:
                conn.execute(f"UPDATE runs SET {', '.join(columns)} WHERE id = ?", values)
                conn.commit()
        return self.get_run(run_id)

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            return self._deserialize_run(row) if row else None

    def delete_run(self, run_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            conn.commit()
            return cur.rowcount > 0

    def list_runs(self, template_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if template_id:
                rows = conn.execute(
                    "SELECT * FROM runs WHERE template_id = ? ORDER BY created_at DESC LIMIT ?",
                    (template_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM runs ORDER BY created_at DESC LIMIT ?", (limit,)
                ).fetchall()
            return [self._deserialize_run(r) for r in rows]

    @staticmethod
    def _deserialize_run(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "template_id": row["template_id"],
            "template_title": row["template_title"],
            "prompt_id": row["prompt_id"],
            "status": row["status"],
            "progress_step": row["progress_step"],
            "progress_total": row["progress_total"],
            "current_node": row["current_node"],
            "fields": json.loads(row["fields_json"] or "{}"),
            "api_prompt": json.loads(row["api_prompt_json"] or "{}"),
            "outputs": json.loads(row["outputs_json"] or "[]"),
            "error": row["error"],
            "created_at": row["created_at"],
            "completed_at": row["completed_at"],
        }

    # --- Settings ---
    def get_setting(self, key: str, default: str | None = None) -> str | None:
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
            return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO app_settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, value),
            )
            conn.commit()

    def delete_setting(self, key: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))
            conn.commit()

    # --- ArtCraft Media Registry ---
    def save_artcraft_media(
        self,
        token: str,
        filename: str,
        subfolder: str = "",
        folder_type: str = "output",
        media_class: str = "image",
        media_type: str = "png",
        title: str = "",
        model_id: str = "",
        run_id: str | None = None,
        is_user_upload: bool = False,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        ts = created_at or time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO artcraft_media
                    (token, filename, subfolder, folder_type, media_class, media_type, title, model_id, run_id, is_user_upload, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(token) DO UPDATE SET
                    filename = excluded.filename,
                    subfolder = excluded.subfolder,
                    folder_type = excluded.folder_type
                """,
                (
                    token,
                    filename,
                    subfolder,
                    folder_type,
                    media_class,
                    media_type,
                    title,
                    model_id,
                    run_id,
                    1 if is_user_upload else 0,
                    ts,
                ),
            )
            conn.commit()
        return self.get_artcraft_media(token) or {}

    def get_artcraft_media(self, token: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM artcraft_media WHERE token = ?", (token,)
            ).fetchone()
            return dict(row) if row else None

    def list_artcraft_media(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM artcraft_media ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(r) for r in rows]
