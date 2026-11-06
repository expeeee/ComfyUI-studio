from __future__ import annotations

import asyncio
import json
import subprocess
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

import websockets

from app.comfy.client import ComfyUIClient
from app.config import Settings, settings
from app.db import StudioDatabase
from app.templates.compiler import compile_workflow_to_api_prompt


def extract_outputs_from_history(history_entry: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract generated images, videos, gifs, or audio items from a ComfyUI history record."""
    outputs_block = history_entry.get("outputs") or {}
    collected: list[dict[str, Any]] = []
    for node_id, node_out in outputs_block.items():
        if not isinstance(node_out, dict):
            continue
        for kind_key, media_kind in (
            ("images", "image"),
            ("gifs", "video"),
            ("videos", "video"),
            ("audio", "audio"),
            ("3d", "3d"),
        ):
            for item in node_out.get(kind_key) or []:
                if not isinstance(item, dict) or not item.get("filename"):
                    continue
                fname = item["filename"]
                subfolder = item.get("subfolder") or ""
                folder_type = item.get("type") or "output"
                actual_kind = media_kind
                lower_fname = fname.lower()
                if lower_fname.endswith((".mp4", ".webm", ".mov", ".mkv")):
                    actual_kind = "video"
                elif lower_fname.endswith((".mp3", ".wav", ".flac", ".ogg")):
                    actual_kind = "audio"
                elif lower_fname.endswith((".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply", ".spz", ".splat", ".ksplat")):
                    actual_kind = "3d"
                qs = urllib.parse.urlencode(
                    {"filename": fname, "subfolder": subfolder, "type": folder_type}
                )
                collected.append(
                    {
                        "node_id": str(node_id),
                        "filename": fname,
                        "subfolder": subfolder,
                        "type": folder_type,
                        "media_kind": actual_kind,
                        "url": f"/api/view?{qs}",
                    }
                )
        # Also support legacy Preview3D {"result": ["3d/ComfyUI_00001_.glb", ...]}
        res_list = node_out.get("result")
        if isinstance(res_list, list) and len(res_list) > 0 and isinstance(res_list[0], str):
            model_rel = res_list[0].replace("\\", "/")
            if model_rel.lower().endswith((".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply", ".spz", ".splat")):
                subf, _, fn = model_rel.rpartition("/")
                qs = urllib.parse.urlencode({"filename": fn, "subfolder": subf, "type": "output"})
                collected.append(
                    {
                        "node_id": str(node_id),
                        "filename": fn,
                        "subfolder": subf,
                        "type": "output",
                        "media_kind": "3d",
                        "url": f"/api/view?{qs}",
                    }
                )
    # Prefer 'output' type over 'temp' if both exist
    saved = [o for o in collected if o["type"] == "output"]
    return saved if saved else collected


class RunExecutionTracker:
    def __init__(
        self,
        db: StudioDatabase,
        comfy: ComfyUIClient,
        cfg: Settings = settings,
    ) -> None:
        self.db = db
        self.comfy = comfy
        self.cfg = cfg
        self._tasks: dict[str, asyncio.Task[None]] = {}

    async def start_run(
        self,
        template_id: str,
        template_title: str,
        fields: dict[str, Any],
        api_prompt: dict[str, Any],
    ) -> dict[str, Any]:
        run_id = f"run-{uuid.uuid4().hex[:12]}"
        client_id = f"studio-{run_id}"
        rec = self.db.create_run(
            {
                "id": run_id,
                "template_id": template_id,
                "template_title": template_title,
                "status": "submitting",
                "fields": fields,
                "api_prompt": api_prompt,
            }
        )
        try:
            submit_res = await self.comfy.submit_prompt(api_prompt, client_id=client_id)
            prompt_id = submit_res.get("prompt_id")
            if not prompt_id:
                raise ValueError(f"ComfyUI did not return prompt_id: {submit_res}")
            rec = self.db.update_run(run_id, prompt_id=prompt_id, status="queued") or rec
        except Exception as exc:
            rec = (
                self.db.update_run(
                    run_id,
                    status="failed",
                    error=str(exc),
                    completed_at=time.time(),
                )
                or rec
            )
            return rec

        task = asyncio.create_task(self._monitor_run(run_id, prompt_id, client_id))
        self._tasks[run_id] = task
        return rec

    async def start_segmented_video_run(
        self,
        template_id: str,
        template_title: str,
        workflow: dict[str, Any],
        obj_info: dict[str, Any],
        fields: dict[str, Any],
        video_param_key: str,
        video_filename: str,
        segment_seconds: float,
    ) -> dict[str, Any]:
        input_path = self.cfg.comfyui_input_dir / Path(video_filename).name
        if not input_path.is_file():
            raise ValueError(f"Input video not found in ComfyUI input directory: {video_filename}")

        run_id = f"run-{uuid.uuid4().hex[:12]}"
        base_prompt = compile_workflow_to_api_prompt(workflow, obj_info, field_overrides=fields)
        rec = self.db.create_run(
            {
                "id": run_id,
                "template_id": template_id,
                "template_title": f"{template_title} (Segmented {int(segment_seconds)}s chunks)",
                "status": "running",
                "current_node": "Splitting video into segments...",
                "fields": fields,
                "api_prompt": base_prompt,
            }
        )
        task = asyncio.create_task(
            self._run_segmented_batch(
                run_id=run_id,
                workflow=workflow,
                obj_info=obj_info,
                fields=fields,
                video_param_key=video_param_key,
                input_path=input_path,
                segment_seconds=segment_seconds,
            )
        )
        self._tasks[run_id] = task
        return rec

    async def _run_segmented_batch(
        self,
        run_id: str,
        workflow: dict[str, Any],
        obj_info: dict[str, Any],
        fields: dict[str, Any],
        video_param_key: str,
        input_path: Path,
        segment_seconds: float,
    ) -> None:
        seg_dir = self.cfg.data_dir / "segments" / run_id
        seg_dir.mkdir(parents=True, exist_ok=True)
        seg_files: list[Path] = []
        try:
            seg_pattern = seg_dir / f"seg_{run_id}_%04d.mp4"
            split_cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(input_path),
                "-c",
                "copy",
                "-f",
                "segment",
                "-segment_time",
                str(max(2.0, float(segment_seconds))),
                "-reset_timestamps",
                "1",
                str(seg_pattern),
            ]
            await asyncio.to_thread(
                subprocess.run,
                split_cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            seg_files = sorted(seg_dir.glob(f"seg_{run_id}_*.mp4"))
            if not seg_files:
                raise RuntimeError("ffmpeg did not produce any video segments")

            total_segs = len(seg_files)
            self.db.update_run(
                run_id,
                status="running",
                progress_step=0,
                progress_total=total_segs,
                current_node=f"Segment 1 / {total_segs}",
            )

            output_root = self.cfg.comfyui_root / "output"
            completed_segment_outputs: list[Path] = []

            for idx, seg_path in enumerate(seg_files):
                cur = self.db.get_run(run_id)
                if not cur or cur["status"] == "cancelled":
                    return

                # Upload segment into ComfyUI's input directory via API
                await self.comfy.upload_image(
                    filename=seg_path.name,
                    content=seg_path.read_bytes(),
                    content_type="video/mp4",
                    overwrite=True,
                )

                seg_fields = dict(fields)
                seg_fields[video_param_key] = seg_path.name
                seg_prompt = compile_workflow_to_api_prompt(
                    workflow, obj_info, field_overrides=seg_fields
                )
                client_id = f"studio-{run_id}-seg{idx}"
                submit_res = await self.comfy.submit_prompt(seg_prompt, client_id=client_id)
                prompt_id = submit_res.get("prompt_id")
                if not prompt_id:
                    raise RuntimeError(f"Segment {idx + 1} failed to queue: {submit_res}")

                self.db.update_run(
                    run_id,
                    prompt_id=prompt_id,
                    status="running",
                    progress_step=idx,
                    progress_total=total_segs,
                    current_node=f"Segment {idx + 1} / {total_segs} (running in ComfyUI)",
                )

                # Wait for this segment's prompt_id in history
                seg_outputs: list[dict[str, Any]] = []
                while True:
                    cur_check = self.db.get_run(run_id)
                    if not cur_check or cur_check["status"] == "cancelled":
                        return
                    hist = await self.comfy.get_history(prompt_id)
                    if prompt_id in hist:
                        entry = hist[prompt_id]
                        st_block = entry.get("status") or {}
                        if st_block.get("status_str") == "error":
                            raise RuntimeError(
                                f"Segment {idx + 1} failed: {st_block.get('messages')}"
                            )
                        seg_outputs = extract_outputs_from_history(entry)
                        break
                    await asyncio.sleep(1.0)

                video_out = next(
                    (o for o in seg_outputs if o.get("media_kind") == "video"),
                    seg_outputs[0] if seg_outputs else None,
                )
                if not video_out:
                    raise RuntimeError(f"Segment {idx + 1} produced no video output")

                subf = video_out.get("subfolder") or ""
                out_file = (
                    (output_root / subf / video_out["filename"])
                    if subf
                    else (output_root / video_out["filename"])
                )
                completed_segment_outputs.append(out_file)

            # Stitch all completed segment outputs into a single final video
            self.db.update_run(
                run_id,
                current_node=f"Stitching {total_segs} upscaled segments with ffmpeg...",
                progress_step=total_segs,
                progress_total=total_segs,
            )
            stitched_dir = self.cfg.data_dir / "stitched_outputs"
            stitched_dir.mkdir(parents=True, exist_ok=True)
            concat_list_path = seg_dir / f"concat_{run_id}.txt"
            concat_lines = [
                f"file '{p.resolve().as_posix()}'" for p in completed_segment_outputs
            ]
            concat_list_path.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")

            final_filename = f"stitched_{run_id}.mp4"
            final_path = stitched_dir / final_filename
            stitch_cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_list_path),
                "-c",
                "copy",
                str(final_path),
            ]
            await asyncio.to_thread(
                subprocess.run,
                stitch_cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )

            qs = urllib.parse.urlencode(
                {"filename": final_filename, "subfolder": "video", "type": "output"}
            )
            self.db.update_run(
                run_id,
                status="completed",
                progress_step=total_segs,
                progress_total=total_segs,
                current_node=None,
                outputs=[
                    {
                        "node_id": "stitched",
                        "filename": final_filename,
                        "subfolder": "video",
                        "type": "output",
                        "media_kind": "video",
                        "url": f"/api/view?{qs}",
                    }
                ],
                completed_at=time.time(),
            )
        except asyncio.CancelledError:
            self.db.update_run(run_id, status="cancelled", completed_at=time.time())
        except Exception as exc:
            self.db.update_run(
                run_id,
                status="failed",
                error=str(exc),
                completed_at=time.time(),
            )
        finally:
            for sp in seg_files:
                try:
                    sp.unlink(missing_ok=True)
                except OSError:
                    pass
            self._tasks.pop(run_id, None)

    def ensure_monitoring(self, rec: dict[str, Any]) -> None:
        run_id = rec["id"]
        prompt_id = rec.get("prompt_id")
        if (
            prompt_id
            and rec.get("status") in ("queued", "running", "submitting")
            and run_id not in self._tasks
        ):
            client_id = f"studio-{run_id}"
            self._tasks[run_id] = asyncio.create_task(
                self._monitor_run(run_id, prompt_id, client_id)
            )

    async def cancel_run(self, run_id: str) -> dict[str, Any] | None:
        rec = self.db.get_run(run_id)
        if not rec:
            return None
        prompt_id = rec.get("prompt_id")
        if prompt_id and rec["status"] in ("queued", "running", "submitting"):
            try:
                await self.comfy.interrupt_or_delete_from_queue(prompt_id)
            except Exception:
                pass
        task = self._tasks.get(run_id)
        if task and not task.done():
            task.cancel()
        return self.db.update_run(
            run_id,
            status="cancelled",
            completed_at=time.time(),
        )

    async def delete_run(self, run_id: str) -> bool:
        rec = self.db.get_run(run_id)
        if not rec:
            return False
        prompt_id = rec.get("prompt_id")
        if prompt_id and rec.get("status") in ("queued", "running", "submitting"):
            try:
                await self.comfy.interrupt_or_delete_from_queue(prompt_id)
            except Exception:
                pass
        task = self._tasks.pop(run_id, None)
        if task and not task.done():
            task.cancel()
        return self.db.delete_run(run_id)

    async def _monitor_run(self, run_id: str, prompt_id: str, client_id: str) -> None:
        ws_url = f"{self.comfy.ws_url}?clientId={client_id}"
        try:
            # Run WS listener and history poller concurrently so we never miss fast completions
            await asyncio.gather(
                self._ws_listener(run_id, prompt_id, ws_url),
                self._poll_history_until_done(run_id, prompt_id),
            )
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            cur = self.db.get_run(run_id)
            if cur and cur["status"] not in ("completed", "cancelled", "failed"):
                self.db.update_run(
                    run_id,
                    status="failed",
                    error=str(exc),
                    completed_at=time.time(),
                )
        finally:
            self._tasks.pop(run_id, None)

    async def _ws_listener(self, run_id: str, prompt_id: str, ws_url: str) -> None:
        try:
            async with websockets.connect(ws_url, open_timeout=5.0, close_timeout=2.0) as ws:
                while True:
                    cur = self.db.get_run(run_id)
                    if not cur or cur["status"] in ("completed", "failed", "cancelled"):
                        return
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    except asyncio.TimeoutError:
                        continue
                    if isinstance(msg, bytes):
                        continue
                    payload = json.loads(msg)
                    mtype = payload.get("type")
                    data = payload.get("data") or {}
                    if data.get("prompt_id") and data.get("prompt_id") != prompt_id:
                        continue

                    if mtype == "executing":
                        node_id = data.get("node")
                        if node_id is None:
                            # Execution finished on ComfyUI side; history poller will finalize outputs
                            return
                        self.db.update_run(
                            run_id,
                            status="running",
                            current_node=str(node_id),
                        )
                    elif mtype == "progress":
                        val = int(data.get("value") or 0)
                        max_val = int(data.get("max") or 0)
                        node_id = data.get("node")
                        updates: dict[str, Any] = {
                            "status": "running",
                            "progress_step": val,
                            "progress_total": max_val,
                        }
                        if node_id:
                            updates["current_node"] = str(node_id)
                        self.db.update_run(run_id, **updates)
                    elif mtype == "execution_error":
                        err_msg = data.get("exception_message") or str(data)
                        self.db.update_run(
                            run_id,
                            status="failed",
                            error=err_msg,
                            completed_at=time.time(),
                        )
                        return
        except Exception:
            # Fallback relies on _poll_history_until_done
            return

    async def _poll_history_until_done(self, run_id: str, prompt_id: str) -> None:
        while True:
            cur = self.db.get_run(run_id)
            if not cur or cur["status"] in ("completed", "failed", "cancelled"):
                return
            try:
                hist = await self.comfy.get_history(prompt_id)
                if prompt_id in hist:
                    entry = hist[prompt_id]
                    status_block = entry.get("status") or {}
                    status_str = status_block.get("status_str")
                    if status_str == "error":
                        msgs = status_block.get("messages") or []
                        err_detail = json.dumps(msgs) if msgs else "ComfyUI execution failed"
                        self.db.update_run(
                            run_id,
                            status="failed",
                            error=err_detail,
                            completed_at=time.time(),
                        )
                        return
                    outputs = extract_outputs_from_history(entry)
                    self.db.update_run(
                        run_id,
                        status="completed",
                        outputs=outputs,
                        progress_step=cur.get("progress_total") or 1,
                        progress_total=cur.get("progress_total") or 1,
                        current_node=None,
                        completed_at=time.time(),
                    )
                    return
            except Exception:
                pass
            await asyncio.sleep(0.8)
