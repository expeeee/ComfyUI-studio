from __future__ import annotations

import asyncio
import base64
import json
import subprocess
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.comfy.client import ComfyUIClient
from app.config import settings


class ExtractFrameRequest(BaseModel):
    filename: str
    subfolder: str = ""
    type: str = "output"
    timestamp: float | str = 0.0  # float seconds or "last"


class TrimVideoRequest(BaseModel):
    filename: str
    subfolder: str = ""
    type: str = "output"
    start_sec: float = 0.0
    end_sec: float
    mode: str = "keep_range"  # "keep_range" | "remove_range"


class VideoClipItem(BaseModel):
    filename: str
    subfolder: str = ""
    type: str = "output"


class StitchVideosRequest(BaseModel):
    clips: list[VideoClipItem] = Field(default_factory=list)


def _parse_fps(rate_str: str) -> float:
    if not rate_str or rate_str == "0/0":
        return 24.0
    if "/" in rate_str:
        num_s, _, den_s = rate_str.partition("/")
        try:
            num = float(num_s)
            den = float(den_s)
            return round(num / den, 3) if den > 0 else 24.0
        except ValueError:
            return 24.0
    try:
        return round(float(rate_str), 3)
    except ValueError:
        return 24.0


def _probe_video_sync(path: Path) -> dict[str, Any]:
    cmd = [
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    res = subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    data = json.loads(res.stdout.decode("utf-8", errors="replace"))
    streams = data.get("streams") or []
    fmt = data.get("format") or {}

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = float(video_stream.get("duration") or fmt.get("duration") or 0.0)
    fps = _parse_fps(
        video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate") or "24/1"
    )
    width = int(video_stream.get("width") or 0)
    height = int(video_stream.get("height") or 0)
    nb_frames_raw = video_stream.get("nb_frames")
    frame_count = (
        int(nb_frames_raw)
        if nb_frames_raw and str(nb_frames_raw).isdigit()
        else max(1, int(round(duration * fps)))
    )
    return {
        "filename": path.name,
        "duration": round(duration, 3),
        "fps": fps,
        "width": width,
        "height": height,
        "frame_count": frame_count,
        "codec": video_stream.get("codec_name") or "unknown",
        "has_audio": audio_stream is not None,
    }


def create_video_router(comfy_client: ComfyUIClient) -> APIRouter:
    router = APIRouter(prefix="/api/video", tags=["video"])

    async def _resolve_video_path(
        filename: str, subfolder: str = "", folder_type: str = "output"
    ) -> Path:
        safe_name = Path(filename).name
        candidates: list[Path] = []
        if folder_type == "input":
            candidates.append(settings.comfyui_input_dir / subfolder / safe_name if subfolder else settings.comfyui_input_dir / safe_name)
        else:
            out_root = settings.comfyui_root / "output"
            candidates.append(out_root / subfolder / safe_name if subfolder else out_root / safe_name)

        candidates.extend(
            [
                settings.comfyui_input_dir / safe_name,
                settings.comfyui_root / "output" / safe_name,
                settings.comfyui_root / "output" / "video" / safe_name,
                settings.data_dir / "stitched_outputs" / safe_name,
                settings.data_dir / "sample_inputs" / safe_name,
            ]
        )
        for c in candidates:
            if c.is_file():
                return c

        # Fallback: fetch from ComfyUI /view and cache locally
        try:
            content, _ = await comfy_client.fetch_view(
                filename=safe_name, subfolder=subfolder, folder_type=folder_type
            )
            cache_dir = settings.data_dir / "stitched_outputs"
            cache_dir.mkdir(parents=True, exist_ok=True)
            cached_path = cache_dir / safe_name
            cached_path.write_bytes(content)
            return cached_path
        except Exception as exc:
            raise HTTPException(
                status_code=404, detail=f"Video file '{safe_name}' not found: {exc}"
            ) from exc

    @router.get("/probe")
    async def probe_video(
        filename: str = Query(...),
        subfolder: str = Query(""),
        type: str = Query("output"),
    ) -> dict[str, Any]:
        video_path = await _resolve_video_path(filename, subfolder, type)
        try:
            return await asyncio.to_thread(_probe_video_sync, video_path)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"ffprobe failed: {exc}") from exc

    @router.get("/filmstrip")
    async def get_video_filmstrip(
        filename: str = Query(...),
        subfolder: str = Query(""),
        type: str = Query("output"),
        count: int = Query(12, ge=2, le=24),
    ) -> dict[str, Any]:
        video_path = await _resolve_video_path(filename, subfolder, type)
        meta = await asyncio.to_thread(_probe_video_sync, video_path)
        duration = max(0.1, float(meta.get("duration") or 1.0))
        fps = float(meta.get("fps") or 24.0)

        tmp_dir = settings.data_dir / "filmstrips" / uuid.uuid4().hex[:10]
        tmp_dir.mkdir(parents=True, exist_ok=True)
        frames: list[dict[str, Any]] = []
        try:
            for i in range(count):
                ts = round((duration * i) / max(1, count), 2)
                out_jpg = tmp_dir / f"thumb_{i:02d}.jpg"
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    str(ts),
                    "-i",
                    str(video_path),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=220:-1",
                    "-q:v",
                    "5",
                    str(out_jpg),
                ]
                await asyncio.to_thread(
                    subprocess.run,
                    cmd,
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                if out_jpg.is_file():
                    b64 = base64.b64encode(out_jpg.read_bytes()).decode("ascii")
                    frames.append(
                        {
                            "index": i,
                            "timestamp": ts,
                            "frame_number": max(0, int(round(ts * fps))),
                            "data_url": f"data:image/jpeg;base64,{b64}",
                        }
                    )
        finally:
            for f in tmp_dir.glob("*"):
                f.unlink(missing_ok=True)
            tmp_dir.rmdir()

        return {"filename": video_path.name, "meta": meta, "frames": frames}

    @router.post("/extract-frame")
    async def extract_video_frame(req: ExtractFrameRequest) -> dict[str, Any]:
        video_path = await _resolve_video_path(req.filename, req.subfolder, req.type)
        meta = await asyncio.to_thread(_probe_video_sync, video_path)
        duration = float(meta.get("duration") or 0.0)

        out_name = f"frame_{Path(req.filename).stem}_{uuid.uuid4().hex[:6]}.png"
        settings.comfyui_input_dir.mkdir(parents=True, exist_ok=True)
        out_path = settings.comfyui_input_dir / out_name

        if req.timestamp == "last" or (
            isinstance(req.timestamp, (int, float))
            and duration > 0.1
            and float(req.timestamp) >= duration - 0.04
        ):
            seek_ts = max(0.0, duration - 0.08)
            cmd = [
                "ffmpeg",
                "-y",
                "-sseof",
                "-0.08",
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                str(out_path),
            ]
        else:
            seek_ts = max(0.0, float(req.timestamp))
            cmd = [
                "ffmpeg",
                "-y",
                "-ss",
                str(seek_ts),
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                str(out_path),
            ]

        await asyncio.to_thread(
            subprocess.run,
            cmd,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        # Fallback if -sseof produced nothing on very short clips
        if not out_path.is_file():
            fallback_ts = max(0.0, duration - 0.15)
            await asyncio.to_thread(
                subprocess.run,
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    str(fallback_ts),
                    "-i",
                    str(video_path),
                    "-frames:v",
                    "1",
                    str(out_path),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )

        # Also copy to sample_inputs so /api/view can serve it even if ComfyUI is busy
        sample_dir = settings.data_dir / "sample_inputs"
        sample_dir.mkdir(parents=True, exist_ok=True)
        (sample_dir / out_name).write_bytes(out_path.read_bytes())

        qs = urllib.parse.urlencode({"filename": out_name, "subfolder": "", "type": "input"})
        return {
            "filename": out_name,
            "url": f"/api/view?{qs}",
            "timestamp": round(seek_ts, 3),
            "width": meta.get("width"),
            "height": meta.get("height"),
        }

    @router.post("/trim")
    async def trim_video(req: TrimVideoRequest) -> dict[str, Any]:
        if req.end_sec <= req.start_sec:
            raise HTTPException(status_code=400, detail="end_sec must be greater than start_sec")
        video_path = await _resolve_video_path(req.filename, req.subfolder, req.type)
        orig_meta = await asyncio.to_thread(_probe_video_sync, video_path)
        total_dur = float(orig_meta.get("duration") or 0.0)

        prefix = "spliced" if req.mode == "remove_range" else "trimmed"
        out_name = f"{prefix}_{Path(req.filename).stem}_{uuid.uuid4().hex[:6]}.mp4"
        stitched_dir = settings.data_dir / "stitched_outputs"
        stitched_dir.mkdir(parents=True, exist_ok=True)
        out_path = stitched_dir / out_name

        if req.mode == "remove_range":
            # Keep [0, start_sec] + [end_sec, total_dur]
            tmp_dir = settings.data_dir / "segments" / f"rm_{uuid.uuid4().hex[:8]}"
            tmp_dir.mkdir(parents=True, exist_ok=True)
            parts: list[Path] = []
            try:
                if req.start_sec > 0.08:
                    p1 = tmp_dir / "part1.mp4"
                    await asyncio.to_thread(
                        subprocess.run,
                        [
                            "ffmpeg",
                            "-y",
                            "-ss",
                            "0",
                            "-i",
                            str(video_path),
                            "-t",
                            str(req.start_sec),
                            "-c:v",
                            "libx264",
                            "-preset",
                            "fast",
                            "-crf",
                            "18",
                            "-pix_fmt",
                            "yuv420p",
                            "-an",
                            str(p1),
                        ],
                        check=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                    )
                    if p1.is_file():
                        parts.append(p1)
                if total_dur - req.end_sec > 0.08:
                    p2 = tmp_dir / "part2.mp4"
                    await asyncio.to_thread(
                        subprocess.run,
                        [
                            "ffmpeg",
                            "-y",
                            "-ss",
                            str(req.end_sec),
                            "-i",
                            str(video_path),
                            "-c:v",
                            "libx264",
                            "-preset",
                            "fast",
                            "-crf",
                            "18",
                            "-pix_fmt",
                            "yuv420p",
                            "-an",
                            str(p2),
                        ],
                        check=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                    )
                    if p2.is_file():
                        parts.append(p2)
                if not parts:
                    raise HTTPException(
                        status_code=400,
                        detail="Cannot remove entire video duration; leave frames before In or after Out.",
                    )
                if len(parts) == 1:
                    out_path.write_bytes(parts[0].read_bytes())
                else:
                    concat_txt = tmp_dir / "concat.txt"
                    concat_txt.write_text(
                        "\n".join(f"file '{p.resolve().as_posix()}'" for p in parts) + "\n",
                        encoding="utf-8",
                    )
                    await asyncio.to_thread(
                        subprocess.run,
                        [
                            "ffmpeg",
                            "-y",
                            "-f",
                            "concat",
                            "-safe",
                            "0",
                            "-i",
                            str(concat_txt),
                            "-c",
                            "copy",
                            str(out_path),
                        ],
                        check=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                    )
            finally:
                for f in tmp_dir.glob("*"):
                    f.unlink(missing_ok=True)
                tmp_dir.rmdir()
        else:
            duration = req.end_sec - req.start_sec
            cmd = [
                "ffmpeg",
                "-y",
                "-ss",
                str(max(0.0, req.start_sec)),
                "-i",
                str(video_path),
                "-t",
                str(duration),
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                str(out_path),
            ]
            await asyncio.to_thread(
                subprocess.run,
                cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )

        # Also stage into ComfyUI input dir so workflows can use the trimmed video immediately
        settings.comfyui_input_dir.mkdir(parents=True, exist_ok=True)
        (settings.comfyui_input_dir / out_name).write_bytes(out_path.read_bytes())

        meta = await asyncio.to_thread(_probe_video_sync, out_path)
        qs = urllib.parse.urlencode({"filename": out_name, "subfolder": "", "type": "output"})
        return {
            "filename": out_name,
            "url": f"/api/view?{qs}",
            "meta": meta,
        }

    @router.post("/stitch")
    async def stitch_videos(req: StitchVideosRequest) -> dict[str, Any]:
        if len(req.clips) < 2:
            raise HTTPException(status_code=400, detail="Provide at least 2 clips to stitch")

        resolved_paths: list[Path] = []
        for clip in req.clips:
            p = await _resolve_video_path(clip.filename, clip.subfolder, clip.type)
            resolved_paths.append(p)

        first_meta = await asyncio.to_thread(_probe_video_sync, resolved_paths[0])
        target_w = first_meta.get("width") or 1280
        target_h = first_meta.get("height") or 720
        # Ensure even dimensions for yuv420p
        target_w = target_w - (target_w % 2)
        target_h = target_h - (target_h % 2)

        tmp_dir = settings.data_dir / "segments" / f"stitch_{uuid.uuid4().hex[:8]}"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        stitched_dir = settings.data_dir / "stitched_outputs"
        stitched_dir.mkdir(parents=True, exist_ok=True)
        out_name = f"stitched_clip_{uuid.uuid4().hex[:8]}.mp4"
        out_path = stitched_dir / out_name

        try:
            normalized_files: list[Path] = []
            for idx, p in enumerate(resolved_paths):
                norm_p = tmp_dir / f"norm_{idx:03d}.mp4"
                vf = (
                    f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
                    f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24"
                )
                norm_cmd = [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(p),
                    "-vf",
                    vf,
                    "-c:v",
                    "libx264",
                    "-preset",
                    "fast",
                    "-crf",
                    "18",
                    "-pix_fmt",
                    "yuv420p",
                    "-an",
                    str(norm_p),
                ]
                await asyncio.to_thread(
                    subprocess.run,
                    norm_cmd,
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
                normalized_files.append(norm_p)

            concat_txt = tmp_dir / "concat.txt"
            concat_txt.write_text(
                "\n".join(f"file '{np.resolve().as_posix()}'" for np in normalized_files) + "\n",
                encoding="utf-8",
            )
            stitch_cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_txt),
                "-c",
                "copy",
                str(out_path),
            ]
            await asyncio.to_thread(
                subprocess.run,
                stitch_cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        finally:
            for f in tmp_dir.glob("*"):
                f.unlink(missing_ok=True)
            tmp_dir.rmdir()

        settings.comfyui_input_dir.mkdir(parents=True, exist_ok=True)
        (settings.comfyui_input_dir / out_name).write_bytes(out_path.read_bytes())

        meta = await asyncio.to_thread(_probe_video_sync, out_path)
        qs = urllib.parse.urlencode({"filename": out_name, "subfolder": "", "type": "output"})
        return {
            "filename": out_name,
            "url": f"/api/view?{qs}",
            "meta": meta,
        }

    return router
