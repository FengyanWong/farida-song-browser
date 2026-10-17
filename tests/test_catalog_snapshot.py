import json
import sqlite3
from pathlib import Path

import pytest

from farida.catalog_snapshot import public_snapshot, seed_new_catalog, write_public_catalog
from farida.db import Database
from farida.resources import resource_root


def test_public_export_omits_personal_state_and_authenticated_response_fields(db, source, video, tmp_path):
    video["private_response_field"] = "do-not-publish"
    video["owner"]["private_field"] = "do-not-publish"
    video["pages"][0]["private_field"] = "do-not-publish"
    video["staff"] = [{"mid": 123, "name": "Public coauthor", "private_field": "do-not-publish"}]
    db.save_video(source, video, ["法里达", "直播切片", "翻唱"])
    clip_id = f"{video['bvid']}:100"
    db.bookmark(clip_id, True)
    db.annotate([clip_id], {"notes": "do-not-publish", "song_group": "do-not-publish"})
    db.execute("UPDATE sources SET last_error=? WHERE id=1", ('{"message":"do-not-publish"}',))
    snapshot = public_snapshot(db.path)
    serialized = json.dumps(snapshot)
    assert "do-not-publish" not in serialized
    assert "user_state" not in snapshot["tables"]
    assert "sync_jobs" not in snapshot["tables"]
    assert "Public coauthor" in serialized
    assert db.clip(clip_id)["notes"] == "do-not-publish"
    assert db.clip(clip_id)["bookmarked"] == 1


def test_seed_round_trip_preserves_parts_memberships_and_attribution(db, source, video, tmp_path):
    curated_source = next(row for row in db.sources() if row["source_type"] == "songlist")
    db.save_songlist(curated_source, [{"id": 1, "song_title": "月亮代表我的心", "original_artist": "邓丽君",
                                     "language": "中文", "style": "流行", "bvid": video["bvid"]},
                                    {"id": 2, "song_title": "未取得视频", "original_artist": "",
                                     "language": "中文", "style": "", "bvid": "BV0000000000"}])
    db.save_video(source, video, ["法里达", "直播切片", "翻唱"])
    db.save_video(curated_source, video, ["法里达", "直播切片", "翻唱"])
    output = tmp_path / "public"
    counts = write_public_catalog(db.path, output)
    assert counts["active_clips"] == 2
    assert counts["unique_bilibili_videos"] == 2
    assert counts["linked_videos_without_metadata"] == 1
    assert "?p=2" in (output / "bilibili-clips.csv").read_text(encoding="utf-8-sig")
    assert "BV0000000000" in (output / "bilibili-links.txt").read_text()
    target = tmp_path / "new-computer" / "catalog.sqlite3"
    assert seed_new_catalog(target, output / "catalog.json")
    restored = Database(target)
    restored.initialize()
    clip = restored.clip(f"{video['bvid']}:200")
    assert clip["playback_url"].endswith("?p=2")
    assert clip["songlist_attribution"] == "CLANNADOR"
    assert len(clip["sources"]) == 2
    assert restored.overview()["entries"] == 2
    assert restored.overview()["bookmarked"] == 0
    assert restored.jobs() == []
    # The sanitized cache still works with the normal recent-update path.
    restored.reuse_video(restored.source(1), restored.one("SELECT * FROM videos WHERE bvid=?", (video["bvid"],)))
    assert restored.overview()["entries"] == 2


def test_seed_never_changes_an_existing_catalog(db, source, video, tmp_path):
    db.save_video(source, video, ["法里达", "翻唱"])
    db.bookmark(f"{video['bvid']}:100", True)
    assert not seed_new_catalog(db.path, tmp_path / "missing.json")
    assert db.clip(f"{video['bvid']}:100")["bookmarked"] == 1
    assert db.overview()["entries"] == 2


def test_failed_seed_does_not_leave_a_partial_catalog(db, source, video, tmp_path):
    db.save_video(source, video, ["法里达", "翻唱"])
    snapshot = public_snapshot(db.path)
    snapshot["tables"]["parts"][0]["video_bvid"] = "BVbadreference"
    source_path = tmp_path / "bad.json"
    source_path.write_text(json.dumps(snapshot), encoding="utf-8")
    target = tmp_path / "fresh" / "catalog.sqlite3"
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        seed_new_catalog(target, source_path)
    assert not target.exists()
    assert not list(target.parent.glob("seed-*"))


def test_resources_resolve_in_source_and_frozen_bundle(monkeypatch, tmp_path):
    assert (resource_root() / "frontend" / "index.html").is_file()
    monkeypatch.setattr("sys.frozen", True, raising=False)
    monkeypatch.setattr("sys._MEIPASS", str(tmp_path), raising=False)
    assert resource_root() == Path(tmp_path)
