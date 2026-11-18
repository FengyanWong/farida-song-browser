import asyncio
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from farida.app import create_app
from farida.auth import LoginError
from test_auth import LoginServer, assert_no_secrets


async def test_tabs_share_one_qr_and_poll_and_can_leave_independently(settings):
    server = LoginServer(flow="headers", codes=[86090, 0])
    login = server.login(settings)
    first_tab, second_tab = uuid4(), uuid4()
    first, second, legacy = await asyncio.gather(login.start(first_tab), login.start(second_tab), login.start())
    assert len({result["id"] for result in (first, second, legacy)}) == 3
    assert first["qr_image"] == second["qr_image"] == legacy["qr_image"]
    assert (await login.start(first_tab))["id"] == first["id"]
    assert (await login.start())["id"] == legacy["id"]
    assert len(server.calls) == 1

    server.time += 3
    a, b = await asyncio.gather(login.poll(first["id"]), login.poll(second["id"]))
    assert (a["id"], b["id"]) == (first["id"], second["id"])
    assert a["state"] == b["state"] == "scanned" and len(server.calls) == 2
    await login.cancel(first["id"])
    assert (await login.poll(first["id"]))["state"] == "cancelled"
    assert login.pending["client"] is not None

    server.time += 3
    accepted, replay = await asyncio.gather(login.poll(second["id"]), login.poll(legacy["id"]))
    assert accepted["state"] == replay["state"] == "authenticated"
    assert accepted["auth"] == replay["auth"] == login.status()
    assert accepted["id"] == second["id"] and replay["id"] == legacy["id"]
    assert_no_secrets(accepted)
    assert sum(r.url.path.endswith("/poll") for r in server.calls) == 2
    assert sum(r.url.path.endswith("/nav") for r in server.calls) == 1
    assert login.pending["client"] is None and not login.pending["observers"]
    assert "auth" not in await login.poll(first["id"])
    await login.logout()
    with pytest.raises(LoginError):
        await login.poll(second["id"])
    await login.close()


async def test_observer_capacity_stale_cancel_and_expiry(settings, monkeypatch):
    monkeypatch.setattr("farida.auth.MAX_QR_OBSERVERS", 2)
    server = LoginServer()
    login = server.login(settings)
    first_tab, second_tab, third_tab = uuid4(), uuid4(), uuid4()
    first = await login.start(first_tab)
    second = await login.start(second_tab)
    with pytest.raises(LoginError, match="页面过多"):
        await login.start(third_tab)
    assert (await login.start(second_tab))["id"] == second["id"]
    await login.cancel(first["id"])
    for _ in range(4):
        replacement = await login.start(first_tab)
        assert replacement["id"] != first["id"]
        await login.cancel(first["id"])
        assert (await login.poll(replacement["id"]))["state"] == "waiting"
        await login.cancel(replacement["id"])
    third = await login.start(third_tab)
    assert len(login.pending["released"]) <= 2 and len(server.calls) == 1

    server.time += 181
    assert (await login.poll(third["id"]))["state"] == "expired"
    assert (await login.poll(second["id"]))["state"] == "expired"
    assert not login.pending["observers"] and login.pending["client"] is None
    new = await login.start(second_tab)
    await login.cancel(second["id"])
    assert (await login.poll(new["id"]))["state"] == "waiting"
    await login.cancel(new["id"])
    assert login.pending["client"] is None and (await login.poll(new["id"]))["state"] == "cancelled"
    with pytest.raises(LoginError, match="稍候"):
        await login.start(second_tab)
    await login.close()


def test_qr_start_api_accepts_optional_validated_document_uuid(settings):
    server = LoginServer()
    app = create_app(settings, scan_on_start=False, auth_transport=httpx.MockTransport(server.handler))
    with TestClient(app) as client:
        client.headers["X-Farida-Token"] = client.get("/api/session").json()["token"]
        assert client.post("/api/auth/qr", params={"observer": "not-a-uuid"}).status_code == 422
        assert not server.calls
        tab = UUID(int=1)
        result = client.post("/api/auth/qr", params={"observer": str(tab)}).json()
        assert client.post("/api/auth/qr", params={"observer": tab.hex}).json()["id"] == result["id"]
        legacy = client.post("/api/auth/qr").json()
        assert legacy["id"] != result["id"] and legacy["qr_image"] == result["qr_image"]
        assert client.post(f"/api/auth/qr/{result['id']}/cancel").json() == {"cancelled": True}
        assert client.post(f"/api/auth/qr/{legacy['id']}/poll").json()["state"] == "waiting"
        assert len(server.calls) == 1

async def test_abandoned_qr_releases_its_resources_without_a_poll(settings, monkeypatch):
    monkeypatch.setattr("farida.auth.QR_LIFETIME_SECONDS", 0)
    server = LoginServer()
    login = server.login(settings)
    qr = await login.start(uuid4())
    client = login.pending["client"]
    await asyncio.wait_for(login.expiry_task, timeout=2)

    assert login.expiry_task is None and client.is_closed
    assert login.pending["state"] == "expired" and not login.pending["observers"]
    assert login.pending["image"] is None and login.pending["key"] is None
    assert (await login.poll(qr["id"]))["state"] == "expired"
    assert len(server.calls) == 1
    await login.close()


async def test_stale_expiry_cannot_close_replacement_and_shutdown_joins_timer(settings):
    server = LoginServer()
    login = server.login(settings)
    first = await login.start(uuid4())
    old_attempt, old_timer = login.pending, login.expiry_task
    await login.cancel(first["id"])
    assert old_timer.cancelled()
    server.time += 181
    second = await login.start(uuid4())
    new_timer, client = login.expiry_task, login.pending["client"]

    # A previously dispatched expiry is harmless even if it resumes after replacement.
    await login.expire_after(old_attempt)
    assert login.expiry_task is new_timer and not client.is_closed
    assert (await login.poll(second["id"]))["state"] == "waiting"
    await login.close()
    assert new_timer.cancelled() and client.is_closed and login.pending is None
    assert len(server.calls) == 2
