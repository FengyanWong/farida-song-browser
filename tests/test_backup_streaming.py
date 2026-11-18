import io
import json
from importlib import import_module

import pytest
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse

from farida import backup
from farida.app import create_app


def test_manual_backup_has_no_import_cap_and_oversized_recovery_preserves_the_catalog(settings, video, monkeypatch):
    monkeypatch.setattr(backup, "now", lambda: "2026-11-18T12:00:00+00:00")
    app = create_app(settings, scan_on_start=False, preview_mode=True)
    with TestClient(app) as client:
        client.headers["X-Farida-Token"] = client.get("/api/session").json()["token"]
        db = app.state.db
        db.save_video(db.source(1), video, [])
        clip = video["bvid"] + ":100"
        smaller = JSONResponse(backup.export_backup(db)).body
        db.annotate([clip], {"notes": '中文 🎵 "合唱"\n第二行'})
        db.save_playlist("我的歌单", [clip])
        assert client.put("/api/player-state", json={"name": "我的歌单", "clip_ids": [clip],
                                                    "current_id": clip, "position": 2.5}).status_code == 200
        complete = backup.export_backup(db)
        expected = JSONResponse(complete).body
        assert len(smaller) < len(expected)

        monkeypatch.setattr(backup, "LIMIT", len(expected))
        response = client.get("/api/backup")
        assert response.status_code == 200 and response.content == expected
        assert int(response.headers["content-length"]) == len(expected)
        assert response.headers["content-type"] == "application/json"
        assert response.headers["content-disposition"] == "attachment; filename=farida-backup.json"
        recovery = backup.restore_backup(db, complete)
        folder = db.path.parent / "backups"
        assert (folder / recovery).read_bytes() == expected

        monkeypatch.setattr(backup, "LIMIT", len(expected) - 1)
        monkeypatch.setattr(import_module("farida.app"), "LIMIT", len(expected) - 1)
        response = client.get("/api/backup")
        assert response.status_code == 200 and response.content == expected
        assert int(response.headers["content-length"]) == len(expected)
        response = client.post("/api/restore", content=expected, headers={"content-type": "application/json"})
        assert response.status_code == 413 and "64 MiB" in response.json()["detail"]
        response = client.post("/api/restore", content=smaller, headers={"content-type": "application/json"})
        assert response.status_code == 409 and "未替换本机数据" in response.json()["detail"]
        assert backup.export_backup(db) == complete
        assert [path.name for path in folder.iterdir()] == [recovery]


def test_streamed_tables_share_one_sqlite_snapshot(db, source, video, monkeypatch):
    db.save_video(source, video, [])
    clip = video["bvid"] + ":100"
    db.annotate([clip], {"notes": "备份开始前"})
    expected = backup.export_backup(db)["tables"]
    read_rows = backup._rows

    def update_between_tables(con, table):
        yield from read_rows(con, table)
        if table == "sources":
            db.annotate([clip], {"notes": "备份开始后"})

    monkeypatch.setattr(backup, "_rows", update_between_tables)
    stream = io.BytesIO()
    backup.write_backup(db, stream)
    assert json.loads(stream.getvalue())["tables"] == expected
    assert db.clip(clip)["notes"] == "备份开始后"


async def test_download_releases_tempfile_on_disconnect(settings):
    app = create_app(settings, scan_on_start=False)
    app.state.db.initialize()
    endpoint = next(route.endpoint for route in app.routes if route.path == "/api/backup")
    response = endpoint()

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            raise OSError("client left during download")

    with pytest.raises(ClientDisconnect):
        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
    assert response.stream.closed


def test_download_write_failure_closes_file_and_reports_reason(settings, monkeypatch):
    app_module = import_module("farida.app")

    class DiskFull(io.BytesIO):
        def write(self, data):
            raise OSError("simulated full disk")

    with TestClient(create_app(settings, scan_on_start=False, preview_mode=True)) as client:
        stream = DiskFull()
        monkeypatch.setattr(app_module.tempfile, "TemporaryFile", lambda: stream)
        response = client.get("/api/backup")
        assert response.status_code == 507 and "磁盘空间" in response.json()["detail"]
        assert stream.closed
