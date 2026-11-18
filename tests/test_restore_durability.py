import asyncio
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

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
    snapshot_ready = threading.Event()
    write_attempted = threading.Event()

    def edit_from_another_connection():
        assert snapshot_ready.wait(5)
        with db.connect() as con:
            # Force the first attempt to report immediately whether the writer lock is held.
            con.execute("PRAGMA busy_timeout=0")
            sql = "UPDATE user_state SET notes=? WHERE clip_id=?"
            values = ("edited during restore", clip)
            try:
                con.execute(sql, values)
            except sqlite3.OperationalError as error:
                if "locked" not in str(error):
                    raise
                write_attempted.set()
                con.execute("PRAGMA busy_timeout=5000")
                con.execute(sql, values)
            else:
                write_attempted.set()

    dump = json.dump
    with ThreadPoolExecutor(max_workers=1) as pool:
        edit = pool.submit(edit_from_another_connection)

        def dump_and_edit(*args, **kwargs):
            dump(*args, **kwargs)
            snapshot_ready.set()
            assert write_attempted.wait(3)

        monkeypatch.setattr(backup.json, "dump", dump_and_edit)
        recovery_name = backup.restore_backup(db, supplied)
        edit.result(timeout=5)

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
