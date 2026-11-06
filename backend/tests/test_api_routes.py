from __future__ import annotations

from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.downloads.manager import validate_download_target
from app.main import app


@pytest.mark.asyncio
async def test_health_and_catalog_endpoints():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        h = await client.get("/api/health")
        assert h.status_code == 200
        hdata = h.json()
        assert hdata["comfyui_online"] is True
        assert hdata["disk"]["free_bytes"] > 0

        cat = await client.get("/api/templates", params={"status": "ready"})
        assert cat.status_code == 200
        cdata = cat.json()
        assert cdata["counts"]["total"] >= 650
        assert cdata["counts"]["ready"] >= 1
        ready_ids = [t["id"] for t in cdata["templates"]]
        assert "image_z_image_turbo" in ready_ids


@pytest.mark.asyncio
async def test_template_detail_and_install_flow():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        detail = await client.get("/api/templates/image_z_image_turbo")
        assert detail.status_code == 200
        ddata = detail.json()
        assert ddata["template"]["status"] == "ready"
        assert len(ddata["primary_parameters"]) >= 1
        assert len(ddata["detail_parameters"]) >= 4

        # Check thumbnail endpoint
        thumb = await client.get("/api/templates/image_z_image_turbo/thumbnail")
        assert thumb.status_code == 200
        assert len(thumb.content) > 1000

        # Install template
        inst = await client.post(
            "/api/templates/image_z_image_turbo/install",
            json={"default_overrides": {"57:3.steps": 8}},
        )
        assert inst.status_code == 200
        assert inst.json()["installed"] is True

        # Toggle favorite on, verify favorites_only filter, then toggle off
        fav_on = await client.post(
            "/api/templates/image_z_image_turbo/favorite",
            json={"favorite": True},
        )
        assert fav_on.status_code == 200
        assert fav_on.json()["favorite"] is True

        fav_cat = await client.get("/api/templates", params={"favorites_only": "true"})
        assert fav_cat.status_code == 200
        fav_ids = [t["id"] for t in fav_cat.json()["templates"]]
        assert "image_z_image_turbo" in fav_ids

        fav_off = await client.post(
            "/api/templates/image_z_image_turbo/favorite",
            json={"favorite": False},
        )
        assert fav_off.status_code == 200
        assert fav_off.json()["favorite"] is False


def test_download_policy_blocks_unsafe_paths_and_hosts(tmp_path: Path):
    # Valid HF URL and category passes
    target = validate_download_target(
        "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/ae.safetensors",
        "vae",
        "ae.safetensors",
        tmp_path,
    )
    assert target == (tmp_path / "vae" / "ae.safetensors").resolve()

    # Reject non-HTTPS
    with pytest.raises(ValueError, match="HTTPS"):
        validate_download_target(
            "http://huggingface.co/model.safetensors",
            "vae",
            "model.safetensors",
            tmp_path,
        )

    # Reject untrusted host
    with pytest.raises(ValueError, match="allowed model provider"):
        validate_download_target(
            "https://evil.example.com/model.safetensors",
            "vae",
            "model.safetensors",
            tmp_path,
        )

    # Reject traversal filename
    with pytest.raises(ValueError, match="Unsafe model filename"):
        validate_download_target(
            "https://huggingface.co/org/repo/resolve/main/model.safetensors",
            "vae",
            "../model.safetensors",
            tmp_path,
        )


@pytest.mark.asyncio
async def test_artcraft_storyteller_and_omnigen_adapter():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Health & Session
        health = await client.get("/health")
        assert health.status_code == 200
        assert health.json()["success"] is True
        assert health.json()["studio_bridge"] is True

        sess = await client.get("/v1/session")
        assert sess.status_code == 200
        sdata = sess.json()
        assert sdata["logged_in"] is True
        assert sdata["user"]["core_info"]["username"] == "local_comfyui"

        # 2. Credits & Subscription
        cred = await client.get("/v1/credits/namespace/artcraft")
        assert cred.status_code == 200
        assert cred.json()["sum_total_credits"] == 999999

        sub = await client.get("/v1/subscriptions/namespace/artcraft")
        assert sub.status_code == 200
        assert sub.json()["active_subscription"] is None

        # 3. OmniGen Model Listings across modalities
        img_models = await client.get("/v1/omni_gen/models/image")
        assert img_models.status_code == 200
        im_list = img_models.json()["models"]
        assert len(im_list) >= 1
        im_ids = [m["model"] for m in im_list]
        assert "image_z_image_turbo" in im_ids

        vid_models = await client.get("/v1/omni_gen/models/video")
        assert vid_models.status_code == 200
        assert len(vid_models.json()["models"]) >= 1

        mesh_models = await client.get("/v1/omni_gen/models/mesh")
        assert mesh_models.status_code == 200
        assert len(mesh_models.json()["models"]) >= 1

        # 4. Cost & Jobs Session
        cost = await client.post("/v1/omni_gen/cost/image", json={"model": "image_z_image_turbo"})
        assert cost.status_code == 200
        cdata = cost.json()
        assert cdata["is_free"] is True
        assert cdata["is_unlimited"] is True

        jobs = await client.post("/v1/jobs/session", json={"job_tokens": []})
        assert jobs.status_code == 200
        assert "jobs" in jobs.json()


@pytest.mark.asyncio
async def test_settings_and_configuration_endpoints():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Initial settings
        s = await client.get("/api/settings")
        assert s.status_code == 200
        sdata = s.json()
        assert "studio_port" in sdata
        assert "comfyui_url" in sdata
        assert "default_segment_seconds" in sdata
        assert sdata["default_segment_seconds"] >= 2

        # Update settings
        up = await client.post(
            "/api/settings",
            json={
                "hf_token": "hf_testdummytoken12345",
                "civitai_token": "civ_testdummytoken67890",
                "comfyui_url": "http://127.0.0.1:8189",
                "default_segment_seconds": 15,
            },
        )
        assert up.status_code == 200
        udata = up.json()
        assert udata["has_hf_token"] is True
        assert udata["has_civitai_token"] is True
        assert udata["comfyui_url"] == "http://127.0.0.1:8189"
        assert udata["is_custom_comfyui_url"] is True
        assert udata["default_segment_seconds"] == 15

        # Reset ComfyUI URL to default
        reset = await client.post(
            "/api/settings",
            json={
                "comfyui_url": udata["default_comfyui_url"],
                "default_segment_seconds": 10,
            },
        )
        assert reset.status_code == 200
        rdata = reset.json()
        assert rdata["is_custom_comfyui_url"] is False
        assert rdata["comfyui_url"] == rdata["default_comfyui_url"]
        assert rdata["default_segment_seconds"] == 10
