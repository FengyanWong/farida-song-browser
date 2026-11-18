import pytest
from fastapi.testclient import TestClient

from farida.app import create_app
from farida.db import encode


def mark_verified(db, source, video):
    db.save_video(source, video, [])
    db.verified_source(source["id"], {"uid": source["uid"], "name": "已核对", "method": "fixture"})
    stamp = "2026-03-04T12:00:00+00:00"
    db.execute("UPDATE sources SET last_refresh_at=?,last_complete_scan_at=?,last_discovery_at=?,last_error=? WHERE id=?",
               (stamp, stamp, stamp, encode({"category": "network", "message": "保留记录"}), source["id"]))
    checkpoint = {str(source["id"]): {"source_url": source["canonical_url"], "state": "completed", "processed": 1}}
    db.execute("INSERT INTO sync_jobs(id,source_ids,mode,state,checkpoints,started_at,heartbeat) "
               "VALUES('finished',?,'full','completed',?,?,?)", (encode([source["id"]]), encode(checkpoint), stamp, stamp))
    return db.source(source["id"])


def test_equivalent_uploader_edits_preserve_memberships_and_history(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        original = mark_verified(db, db.source(1), video)
        client.headers["X-Farida-Token"] = client.get("/api/session").json()["token"]
        assert original["entries"] == 2 and original["submissions"] == 1
        before_memberships = db.all("SELECT * FROM memberships WHERE source_id=1")
        for url in (original["uid"], original["canonical_url"], original["canonical_url"] + "/",
                    original["canonical_url"] + "/video?spm_id_from=333"):
            response = client.patch("/api/sources/1", json={
                "display_name": "新名称", "url": url, "enabled": False, "singing_collection": True,
            })
            assert response.status_code == 200
            expected = {**original, "display_name": "新名称", "enabled": 0, "singing_collection": 0}
            assert response.json() == expected
            assert db.all("SELECT * FROM memberships WHERE source_id=1") == before_memberships
            assert db.collection_status(response.json())["job_id"] == "finished"


@pytest.mark.parametrize("url,kind", [
    ("https://space.bilibili.com/123/lists/456?type=season", "season"),
    ("https://space.bilibili.com/123/lists/456?type=series", "series"),
    ("https://space.bilibili.com/123/favlist?fid=456", "favorites"),
])
def test_only_collection_sources_can_enable_singing_evidence(db, url, kind):
    source = db.add_source("测试", "123", singing_collection=True)
    assert source["singing_collection"] == 0
    collection = db.update_source(source["id"], {"url": url, "singing_collection": True})
    assert collection["source_type"] == kind and collection["singing_collection"] == 1
    assert db.update_source(source["id"], {"url": "123"})["singing_collection"] == 0
    assert db.update_source(source["id"], {"singing_collection": True})["singing_collection"] == 0
    assert db.add_source("合集", url, singing_collection=True)["singing_collection"] == 1


def test_public_songlist_and_discovery_never_take_collection_flag(db):
    for source in db.sources():
        if source["source_type"] in {"songlist", "search"}:
            assert db.update_source(source["id"], {"singing_collection": True})["singing_collection"] == 0


def test_collection_alias_and_real_replacement_are_distinguished(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        url = "https://space.bilibili.com/394803911/lists/678?type=season"
        old = mark_verified(db, db.add_source("合集", url, singing_collection=True), video)
        db.save_video(db.source(1), video, [])
        clip = video["bvid"] + ":100"
        db.bookmark(clip, True)
        path = "/api/sources/" + str(old["id"])
        client.headers["X-Farida-Token"] = client.get("/api/session").json()["token"]
        alias = "https://www.bilibili.com/medialist/play/394803911?business=space_collection&business_id=678"
        result = client.patch(path, json={"url": alias, "singing_collection": False})
        assert result.status_code == 200 and result.json() == {**old, "singing_collection": 0}

        # A conflicting new identity must roll back both the new settings and the removed memberships.
        conflict = client.patch(path, json={"url": old["uid"], "display_name": "已冲突"})
        assert conflict.status_code == 409 and db.source(old["id"]) == result.json()

        replacement = client.patch(path, json={"url": url.replace("/678?", "/679?"), "display_name": "新合集"})
        assert replacement.status_code == 200
        new = replacement.json()
        assert new["collection_id"] == "679" and new["uid"] == old["uid"] and new["display_name"] == "新合集"
        assert new["submissions"] == new["entries"] == 0 and new["verification_status"] == "pending"
        for field in ("last_refresh_at", "last_complete_scan_at", "last_discovery_at", "last_error",
                      "verified_uid", "resolved_name", "verification_method"):
            assert new[field] is None
        assert db.collection_status(new)["job_id"] is None
        assert db.source(1)["submissions"] == 1 and db.clip(clip)["bookmarked"] == 1


def test_retargeted_default_source_and_restored_source_list_survive_restart(settings):
    from farida.backup import export_backup, restore_backup

    app = create_app(settings, scan_on_start=False)
    with TestClient(app) as client:
        db = app.state.db
        old = next(row for row in db.sources() if row["uid"] == "394803911")
        token = client.get("/api/session").json()["token"]
        response = client.patch(f"/api/sources/{old['id']}", headers={"X-Farida-Token": token},
                                json={"url": "UID: 123456790", "display_name": "新来源"})
        assert response.status_code == 200
        modified = {row["canonical_url"] for row in db.sources()}
        assert len(modified) == 6 and old["canonical_url"] not in modified

    with TestClient(create_app(settings, scan_on_start=False)) as reopened:
        db = reopened.app.state.db
        assert {row["canonical_url"] for row in db.sources()} == modified
        assert db.source(old["id"])["display_name"] == "新来源"
        supplied = export_backup(db)
        supplied["tables"]["sources"] = []
        restore_backup(db, supplied)

    with TestClient(create_app(settings, scan_on_start=False)) as restored:
        assert restored.get("/api/sources").json() == []
