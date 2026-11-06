from __future__ import annotations

import hashlib
import json
import re
import shutil
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.config import Settings, settings

UI_ONLY_NODES = {
    "MarkdownNote",
    "Note",
    "Reroute",
    "PrimitiveNode",
}

BUNDLE_PACKAGE_MAP = {
    "media-api": "comfyui_workflow_templates_media_api",
    "media-video": "comfyui_workflow_templates_media_video",
    "media-image": "comfyui_workflow_templates_media_image",
    "media-other": "comfyui_workflow_templates_media_other",
    "media-assets-01": "comfyui_workflow_templates_media_assets_01",
    "media-assets-02": "comfyui_workflow_templates_media_assets_02",
}

FOLDER_ALIASES: dict[str, list[str]] = {
    "diffusion_models": ["diffusion_models", "unet"],
    "unet": ["unet", "diffusion_models"],
    "text_encoders": ["text_encoders", "clip"],
    "clip": ["clip", "text_encoders"],
}

HF_LINK_RE = re.compile(
    r"\[(?P<name>[^\]]+\.(?:safetensors|ckpt|pt|pth|bin|gguf|onnx))\]"
    r"\((?P<url>https://huggingface\.co/[^\s\)]+)\)"
)
MARKDOWN_DIR_RE = re.compile(r"\*\*(?P<dir>[a-zA-Z0-9_]+)\*\*")


@dataclass
class ModelRequirement:
    key: str
    name: str
    directory: str
    url: str | None = None
    sha256: str | None = None
    installed: bool = False
    installed_path: str | None = None
    size_bytes: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "directory": self.directory,
            "url": self.url,
            "sha256": self.sha256,
            "installed": self.installed,
            "installed_path": self.installed_path,
            "size_bytes": self.size_bytes,
        }


@dataclass
class TemplateSummary:
    id: str
    title: str
    description: str
    category: str
    media_type: str
    media_subtype: str
    tags: list[str]
    model_families: list[str]
    open_source: bool
    estimated_size_bytes: int
    usage: int
    date: str
    status: str  # "ready", "needs_models", "needs_nodes", "paid_api"
    installed: bool = False
    favorite: bool = False
    models: list[ModelRequirement] = field(default_factory=list)
    missing_models: list[str] = field(default_factory=list)
    missing_nodes: list[str] = field(default_factory=list)
    required_nodes: list[str] = field(default_factory=list)
    has_subgraphs: bool = False
    io_inputs: list[dict[str, Any]] = field(default_factory=list)
    io_outputs: list[dict[str, Any]] = field(default_factory=list)
    thumbnail_url: str | None = None
    tutorial_url: str | None = None
    source_sha256: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "category": self.category,
            "media_type": self.media_type,
            "media_subtype": self.media_subtype,
            "tags": self.tags,
            "model_families": self.model_families,
            "open_source": self.open_source,
            "estimated_size_bytes": self.estimated_size_bytes,
            "usage": self.usage,
            "date": self.date,
            "status": self.status,
            "installed": self.installed,
            "favorite": self.favorite,
            "models": [m.to_dict() for m in self.models],
            "missing_models": self.missing_models,
            "missing_nodes": self.missing_nodes,
            "required_nodes": self.required_nodes,
            "has_subgraphs": self.has_subgraphs,
            "io_inputs": self.io_inputs,
            "io_outputs": self.io_outputs,
            "thumbnail_url": self.thumbnail_url,
            "tutorial_url": self.tutorial_url,
            "source_sha256": self.source_sha256,
        }


def _iter_all_graph_nodes(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Return all top-level and subgraph nodes in a workflow JSON."""
    nodes = list(workflow.get("nodes", []))
    subgraphs = workflow.get("definitions", {}).get("subgraphs", []) or []
    for sg in subgraphs:
        nodes.extend(sg.get("nodes", []))
    return nodes


def extract_models_from_workflow(workflow: dict[str, Any]) -> list[ModelRequirement]:
    """Extract and deduplicate all required models from top-level and subgraph nodes."""
    seen: dict[tuple[str, str], ModelRequirement] = {}
    all_nodes = _iter_all_graph_nodes(workflow)

    for node in all_nodes:
        if node.get("mode") in (2, 4):
            continue
        props = node.get("properties") or {}
        models_list = props.get("models") or []
        for m in models_list:
            name = (m.get("name") or "").strip()
            directory = (m.get("directory") or "").strip()
            url = (m.get("url") or "").strip() or None
            sha256 = (m.get("hash") or "").strip() or None
            if not name or not directory:
                continue
            # Normalize filename basename
            clean_name = Path(name).name
            key = f"{directory}/{clean_name}"
            dedupe_k = (directory, clean_name)
            if dedupe_k not in seen:
                seen[dedupe_k] = ModelRequirement(
                    key=key,
                    name=clean_name,
                    directory=directory,
                    url=url,
                    sha256=sha256,
                )
            elif url and not seen[dedupe_k].url:
                seen[dedupe_k].url = url

    # Fallback: parse MarkdownNote if no structured properties.models were found
    if not seen:
        for node in all_nodes:
            if node.get("type") in ("MarkdownNote", "Note"):
                wvs = node.get("widgets_values") or []
                text = "\n".join(str(x) for x in wvs if isinstance(x, str))
                current_dir = "checkpoints"
                for line in text.splitlines():
                    dir_match = MARKDOWN_DIR_RE.search(line)
                    if dir_match:
                        candidate = dir_match.group("dir").strip()
                        if candidate in (
                            "checkpoints",
                            "diffusion_models",
                            "unet",
                            "vae",
                            "text_encoders",
                            "clip",
                            "clip_vision",
                            "loras",
                            "controlnet",
                            "upscale_models",
                            "audio_encoders",
                            "latent_upscale_models",
                            "model_patches",
                        ):
                            current_dir = candidate
                    for m_link in HF_LINK_RE.finditer(line):
                        clean_name = Path(m_link.group("name").strip()).name
                        url = m_link.group("url").strip()
                        dedupe_k = (current_dir, clean_name)
                        if dedupe_k not in seen:
                            seen[dedupe_k] = ModelRequirement(
                                key=f"{current_dir}/{clean_name}",
                                name=clean_name,
                                directory=current_dir,
                                url=url,
                            )

    return list(seen.values())


def extract_required_nodes(workflow: dict[str, Any]) -> list[str]:
    """Return sorted unique execution node class_types in the workflow."""
    subgraphs = {
        sg["id"]
        for sg in (workflow.get("definitions", {}).get("subgraphs", []) or [])
        if "id" in sg
    }
    required: set[str] = set()
    for node in _iter_all_graph_nodes(workflow):
        if node.get("mode") in (2, 4):
            continue
        ntype = node.get("type")
        if not ntype or ntype in UI_ONLY_NODES or ntype in subgraphs:
            continue
        required.add(str(ntype))
    return sorted(required)


def check_model_installed(req: ModelRequirement, models_root: Path) -> ModelRequirement:
    """Check if a model file exists and is non-empty under models_root."""
    candidate_dirs = FOLDER_ALIASES.get(req.directory, [req.directory])
    for folder in candidate_dirs:
        folder_path = models_root / folder
        if not folder_path.exists():
            continue
        direct = folder_path / req.name
        if direct.is_file() and direct.stat().st_size > 0:
            st = direct.stat()
            req.installed = True
            req.installed_path = str(direct)
            req.size_bytes = st.st_size
            return req
        # Also check nested paths inside the category folder
        for sub in folder_path.rglob(req.name):
            if sub.is_file() and sub.stat().st_size > 0:
                st = sub.stat()
                req.installed = True
                req.installed_path = str(sub)
                req.size_bytes = st.st_size
                return req
    req.installed = False
    req.installed_path = None
    return req


class TemplateCatalogInspector:
    def __init__(self, cfg: Settings = settings) -> None:
        self.cfg = cfg

    @lru_cache(maxsize=1)
    def _load_index(self) -> list[dict[str, Any]]:
        index_path = self.cfg.templates_json_dir / "index.json"
        if not index_path.is_file():
            return []
        return json.loads(index_path.read_text(encoding="utf-8"))

    @lru_cache(maxsize=1)
    def _load_manifest(self) -> dict[str, dict[str, Any]]:
        manifest_path = self.cfg.templates_core_dir / "manifest.json"
        if not manifest_path.is_file():
            return {}
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        return {entry["id"]: entry for entry in raw.get("templates", []) if "id" in entry}

    @lru_cache(maxsize=1024)
    def load_workflow_json(self, template_id: str) -> tuple[dict[str, Any], str]:
        path = self.cfg.templates_json_dir / f"{template_id}.json"
        if not path.is_file():
            raise FileNotFoundError(f"Template JSON not found: {template_id}")
        raw_bytes = path.read_bytes()
        sha = hashlib.sha256(raw_bytes).hexdigest()
        return json.loads(raw_bytes.decode("utf-8")), sha

    def _upload_bytes_to_comfy_input(self, safe_name: str, data: bytes) -> bool:
        """Upload sample input bytes to ComfyUI's /upload/image endpoint so ComfyUI writes to input/."""
        import mimetypes

        import httpx

        dst = self.cfg.comfyui_input_dir / safe_name
        if dst.is_file() and dst.stat().st_size > 0:
            return True
        try:
            dst.write_bytes(data)
            return True
        except OSError:
            pass

        mime, _ = mimetypes.guess_type(safe_name)
        files = {"image": (safe_name, data, mime or "application/octet-stream")}
        form = {"overwrite": "true", "type": "input"}
        try:
            with httpx.Client(timeout=20.0) as client:
                resp = client.post(
                    f"{self.cfg.comfyui_base_url.rstrip('/')}/upload/image",
                    files=files,
                    data=form,
                )
                return resp.status_code == 200
        except Exception:
            return False

    def _find_bundle_asset_file(self, template_id: str, filename: str) -> Path | None:
        safe_name = Path(filename).name
        manifest = self._load_manifest()
        entry = manifest.get(template_id)
        if entry:
            asset_bundle = next(
                (a.get("bundle") for a in entry.get("assets", []) if a.get("filename") == safe_name),
                None,
            )
            bundle_name = asset_bundle or entry.get("bundle")
            pkg_name = BUNDLE_PACKAGE_MAP.get(bundle_name or "")
            if pkg_name:
                candidate = self.cfg.comfyui_site_packages / pkg_name / "templates" / safe_name
                if candidate.is_file():
                    return candidate

        for pkg_name in BUNDLE_PACKAGE_MAP.values():
            candidate = self.cfg.comfyui_site_packages / pkg_name / "templates" / safe_name
            if candidate.is_file():
                return candidate
        return None

    def resolve_asset_file(self, template_id: str, filename: str) -> Path | None:
        """Resolve a thumbnail or sample input asset from bundles, input dir, or remote io.inputs."""
        import urllib.parse
        import urllib.request

        safe_name = Path(filename).name
        bundle_file = self._find_bundle_asset_file(template_id, safe_name)
        if bundle_file:
            return bundle_file

        input_candidate = self.cfg.comfyui_input_dir / safe_name
        if input_candidate.is_file() and input_candidate.stat().st_size > 0:
            return input_candidate

        sample_cache_dir = self.cfg.data_dir / "sample_inputs"
        sample_cache_dir.mkdir(parents=True, exist_ok=True)
        cached_candidate = sample_cache_dir / safe_name
        if cached_candidate.is_file() and cached_candidate.stat().st_size > 0:
            self._upload_bytes_to_comfy_input(safe_name, cached_candidate.read_bytes())
            return cached_candidate

        # Check template io.inputs for sourceRevision and fetch on demand
        for cat in self._load_index():
            for entry in cat.get("templates", []):
                if entry.get("name") != template_id:
                    continue
                for inp in (entry.get("io") or {}).get("inputs") or []:
                    if Path(inp.get("file", "")).name == safe_name:
                        rev = inp.get("sourceRevision")
                        if isinstance(rev, str) and re.fullmatch(r"[0-9a-f]{40}", rev):
                            encoded_file = urllib.parse.quote(safe_name)
                            raw_url = f"https://raw.githubusercontent.com/Comfy-Org/workflow_templates/{rev}/input/{encoded_file}"
                            try:
                                req = urllib.request.Request(
                                    raw_url, headers={"User-Agent": "ComfyUI-Studio/0.1"}
                                )
                                with urllib.request.urlopen(req, timeout=20) as resp:
                                    data = resp.read()
                                    if data:
                                        cached_candidate.write_bytes(data)
                                        self._upload_bytes_to_comfy_input(safe_name, data)
                                        return cached_candidate
                            except Exception:
                                break

        # Fallback: if an image preview was requested for an unbundled placeholder filename,
        # return the template thumbnail so the UI shows a clean preview image instead of 404.
        if safe_name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            return self.find_thumbnail_file(template_id)
        return None

    def find_thumbnail_file(self, template_id: str) -> Path | None:
        manifest = self._load_manifest()
        entry = manifest.get(template_id)
        if entry:
            for asset in entry.get("assets", []):
                fname = asset.get("filename", "")
                if fname.endswith((".webp", ".png", ".jpg", ".jpeg", ".mp4")):
                    resolved = self._find_bundle_asset_file(template_id, fname)
                    if resolved:
                        return resolved
        # Fallback conventional name
        return self._find_bundle_asset_file(template_id, f"{template_id}-1.webp")

    def stage_sample_inputs(self, template_id: str, io_inputs: list[dict[str, Any]]) -> list[str]:
        """Copy or fetch bundled sample input files (io.inputs) into ComfyUI's input directory."""
        staged: list[str] = []
        for inp in io_inputs:
            fname = inp.get("file")
            if not fname:
                continue
            safe_name = Path(fname).name
            dst = self.cfg.comfyui_input_dir / safe_name
            if dst.is_file() and dst.stat().st_size > 0:
                staged.append(safe_name)
                continue

            resolved = self.resolve_asset_file(template_id, safe_name)
            if resolved and resolved.is_file():
                if self._upload_bytes_to_comfy_input(safe_name, resolved.read_bytes()):
                    staged.append(safe_name)
        return staged

    def inspect_template(
        self,
        raw_entry: dict[str, Any],
        category_title: str,
        available_nodes: set[str] | None = None,
        installed_ids: set[str] | None = None,
        favorite_ids: set[str] | None = None,
    ) -> TemplateSummary:
        tid = raw_entry["name"]
        open_source = raw_entry.get("openSource", True) is not False
        io_data = raw_entry.get("io") or {}
        io_inputs = io_data.get("inputs") or []
        io_outputs = io_data.get("outputs") or []

        try:
            wf, sha = self.load_workflow_json(tid)
        except FileNotFoundError:
            wf, sha = {}, ""

        has_subgraphs = bool(wf.get("definitions", {}).get("subgraphs"))
        models = [
            check_model_installed(m, self.cfg.models_root)
            for m in extract_models_from_workflow(wf)
        ]
        required_nodes = extract_required_nodes(wf)
        missing_nodes = (
            [n for n in required_nodes if n not in available_nodes]
            if available_nodes is not None
            else []
        )
        missing_models = [m.name for m in models if not m.installed]

        if not open_source or tid.startswith("api_"):
            status = "paid_api"
        elif missing_nodes:
            status = "needs_nodes"
        elif missing_models:
            status = "needs_models"
        else:
            status = "ready"

        thumb_path = self.find_thumbnail_file(tid)
        thumb_url = f"/api/templates/{tid}/thumbnail" if thumb_path else None

        return TemplateSummary(
            id=tid,
            title=raw_entry.get("title") or tid,
            description=raw_entry.get("description") or "",
            category=category_title,
            media_type=raw_entry.get("mediaType") or "image",
            media_subtype=raw_entry.get("mediaSubtype") or "png",
            tags=raw_entry.get("tags") or [],
            model_families=raw_entry.get("models") or [],
            open_source=open_source,
            estimated_size_bytes=int(raw_entry.get("size") or 0),
            usage=int(raw_entry.get("usage") or 0),
            date=raw_entry.get("date") or "",
            status=status,
            installed=bool(installed_ids and tid in installed_ids),
            favorite=bool(favorite_ids and tid in favorite_ids),
            models=models,
            missing_models=missing_models,
            missing_nodes=missing_nodes,
            required_nodes=required_nodes,
            has_subgraphs=has_subgraphs,
            io_inputs=io_inputs,
            io_outputs=io_outputs,
            thumbnail_url=thumb_url,
            tutorial_url=raw_entry.get("tutorialUrl"),
            source_sha256=sha,
        )

    def list_templates(
        self,
        available_nodes: set[str] | None = None,
        installed_ids: set[str] | None = None,
        favorite_ids: set[str] | None = None,
    ) -> list[TemplateSummary]:
        index_data = self._load_index()
        results: list[TemplateSummary] = []
        seen_ids: set[str] = set()
        for cat in index_data:
            cat_title = cat.get("title") or cat.get("category") or "General"
            for entry in cat.get("templates", []):
                tid = entry.get("name")
                if not tid or tid in seen_ids:
                    continue
                seen_ids.add(tid)
                results.append(
                    self.inspect_template(
                        entry,
                        category_title=cat_title,
                        available_nodes=available_nodes,
                        installed_ids=installed_ids,
                        favorite_ids=favorite_ids,
                    )
                )
        return results

    def get_template(
        self,
        template_id: str,
        available_nodes: set[str] | None = None,
        installed_ids: set[str] | None = None,
        favorite_ids: set[str] | None = None,
    ) -> TemplateSummary:
        for cat in self._load_index():
            cat_title = cat.get("title") or cat.get("category") or "General"
            for entry in cat.get("templates", []):
                if entry.get("name") == template_id:
                    return self.inspect_template(
                        entry,
                        category_title=cat_title,
                        available_nodes=available_nodes,
                        installed_ids=installed_ids,
                        favorite_ids=favorite_ids,
                    )
        raise KeyError(f"Template '{template_id}' not found in catalog")
