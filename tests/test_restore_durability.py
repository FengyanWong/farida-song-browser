import asyncio
import json
import sqlite3

import httpx
import pytest

from farida import backup
from farida.adapter import Page
from farida.app import create_app


def test_edits_during_restore_remain_in_the_live_catalog(db, source, video, monkeypatch):
    db.save_video(source, video, [])
    clip = video["bvid"] + ":100"
    db.annotate([clip], {"notes": "in the supplied backup"})
    supplied = backup.export_backup(db)
    db.annotate([clip], {"notes": "before restore"})
    save_recovery = backup._save_recovery
    statements = []

    with db.connect() as editor:
        editor.execute("PRAGMA busy_timeout=0")

        def attempt_edit_after_copy(restore_connection, folder):
            name = save_recovery(restore_connection, folder)
            # A second SQLite connection must wait even though the copy is already complete.
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                editor.execute("BEGIN IMMEDIATE")
            restore_connection.set_trace_callback(statements.append)
            return name

        monkeypatch.setattr(backup, "_save_recovery", attempt_edit_after_copy)
        recovery_name = backup.restore_backup(db, supplied)
        assert db.clip(clip)["notes"] == "in the supplied backup"
        # The traced connection performs the live replacement before its first commit.
        assert "DELETE FROM user_state" in statements[:statements.index("COMMIT")]
        assert statements[-1] == "COMMIT"
        editor.execute("BEGIN IMMEDIATE")
        editor.execute("UPDATE user_state SET notes=? WHERE clip_id=?", ("edited during restore", clip))

    recovery_file = db.path.parent / "backups" / recovery_name
    recovered = json.loads(recovery_file.read_text(encoding="utf-8"))
    assert recovered["tables"]["user_state"][0]["notes"] == "before restore"
    assert db.clip(clip)["notes"] == "edited during restore"


def test_incomplete_recovery_copy_leaves_current_data_intact(db, source, video, monkeypatch):
    db.save_video(source, video, [])
    clip = video["bvid"] + ":100"
    supplied = backup.export_backup(db)
    db.annotate([clip], {"notes": "only in the current catalog"})

    def fail_to_flush(_fd):
        raise OSError("simulated disk failure")

    monkeypatch.setattr(backup.os, "fsync", fail_to_flush)
    with pytest.raises(OSError, match="simulated disk failure"):
        backup.restore_backup(db, supplied)

    assert db.clip(clip)["notes"] == "only in the current catalog"
    assert list((db.path.parent / "backups").iterdir()) == []

async def test_invalid_upload_preserves_current_collection_and_playback(settings, video):
    from test_sync import FakeAdapter

    started = asyncio.Event()
    release = asyncio.Event()

    class WaitingAdapter(FakeAdapter):
        async def list_entries(self, source, page):
            started.set()
            await release.wait()
            return Page([], False, 0)

    app = create_app(settings, adapter_factory=lambda _: WaitingAdapter(video),
                     scan_on_start=False, preview_mode=True)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://testserver") as client:
            client.headers["X-Farida-Token"] = (await client.get("/api/session")).json()["token"]
            job = (await client.post("/api/sync", json={"source_ids": [1]})).json()
            await asyncio.wait_for(started.wait(), timeout=3)
            generation = app.state.playback.generation

            damaged = (await client.get("/api/backup")).json()
            damaged["tables"]["user_state"].append({"clip_id": "missing:1", "bookmarked": 1, "notes": ""})
            response = await client.post("/api/restore", json=damaged)
            assert response.status_code == 400
            assert app.state.db.job(job["id"])["state"] == "running"
            assert app.state.playback.generation == generation
            assert not (settings.data_dir / "backups").exists()

            release.set()
            await asyncio.wait_for(app.state.collector.task, timeout=3)
            assert app.state.db.job(job["id"])["state"] == "completed"


async def test_recovery_write_keeps_second_window_responsive(settings, monkeypatch):
    from threading import Event

    app = create_app(settings, scan_on_start=False, preview_mode=True)
    writing, resume = Event(), Event()
    original = backup._save_recovery

    def wait_for_disk(con, folder):
        writing.set()
        if not resume.wait(3):
            raise TimeoutError("The other page could not use the app during a restore")
        return original(con, folder)

    monkeypatch.setattr(backup, "_save_recovery", wait_for_disk)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://testserver") as client:
            client.headers["X-Farida-Token"] = (await client.get("/api/session")).json()["token"]
            saved = (await client.get("/api/backup")).content
            restoring = asyncio.create_task(client.post("/api/restore", content=saved))
            try:
                assert await asyncio.to_thread(writing.wait, 3)
                health = await asyncio.wait_for(client.get("/api/health"), timeout=2)
                assert health.json()["status"] == "ok"
                assert not restoring.done()
            finally:
                resume.set()
                response = await restoring
            assert response.status_code == 200


async def test_failed_recovery_write_preserves_playback_and_reports_storage_failure(settings, monkeypatch):
    def disk_full(_con, _folder):
        raise OSError("simulated full disk")

    monkeypatch.setattr(backup, "_save_recovery", disk_full)
    app = create_app(settings, scan_on_start=False, preview_mode=True)
    transport = httpx.ASGITransport(app, raise_app_exceptions=False)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            client.headers["X-Farida-Token"] = (await client.get("/api/session")).json()["token"]
            saved = (await client.get("/api/backup")).json()
            playback = app.state.playback
            generation = playback.generation
            playback.leases["current"] = {"generation": generation}
            response = await client.post("/api/restore", json=saved)
            assert response.status_code == 507
            assert "磁盘" in response.json()["detail"]
            assert playback.generation == generation and "current" in playback.leases
            assert (await client.get("/api/backup")).json()["tables"] == saved["tables"]
