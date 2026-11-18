from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from farida.app import create_app
from farida.db import Database


def save_index(db, bvid, *titles):
    source = next(source for source in db.sources() if source["source_type"] == "songlist")
    db.save_songlist(source, [{"id": index, "song_title": title, "original_artist": "", "language": "", "style": "",
                              "bvid": bvid} for index, title in enumerate(titles, 1)])


def test_user_can_reset_only_title_to_latest_local_credit_and_resume_refreshes(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        video["pages"] = video["pages"][:1]
        source = db.source(1)
        db.save_video(source, video, [])
        clip_id = video["bvid"] + ":100"
        db.annotate([clip_id], {"display_song_title": "手动歌名", "inclusion_status": "excluded",
                                "song_group": "我的分组", "notes": "保留备注"})
        db.bookmark(clip_id, True)
        save_index(db, video["bvid"], "歌单新标题")
        # Older imported records can lack the original upstream detail payload.
        db.execute("UPDATE videos SET raw_metadata='{}' WHERE bvid=?", (video["bvid"],))
        before = db.clip(clip_id)
        url = "/api/clips/" + clip_id + "/automatic-title"
        assert client.post(url).status_code == 403
        client.headers["X-Farida-Token"] = client.get("/api/session").json()["token"]
        response = client.post(url)
        assert response.status_code == 200
        assert response.json() == {**before, "display_song_title": "歌单新标题",
                                   "manual_fields": ["inclusion_status", "song_group"]}
        assert client.get("/api/clips/" + clip_id).json() == response.json()
        save_index(db, video["bvid"], "后续采集曲名")
        assert client.post(url).json()["display_song_title"] == "歌单新标题"  # No override left to clear.
        db.save_video(source, video, [])
        current = db.clip(clip_id)
        assert (current["display_song_title"], current["inclusion_status"], current["notes"],
                current["song_group"], current["bookmarked"]) == ("后续采集曲名", "excluded", "保留备注", "我的分组", 1)
        assert client.post("/api/clips/missing/automatic-title").status_code == 404


@pytest.mark.parametrize("multipart,titles,expected", [
    (True, ["Moon", "另一首", "Moon"], "Moon"),
    (True, ["Moon", "moon"], "ＭＯＯＮ"),
    (True, ["另一首"], "ＭＯＯＮ"),
    (False, ["Moon", "另一首"], "原视频曲名"),
    (False, [], "原视频曲名"),
])
def test_reset_uses_same_exact_part_and_ambiguous_credit_rules_as_collection(db, source, video, multipart, titles, expected):
    video["title"] = "法里达翻唱《原视频曲名》"
    video["pages"][0]["part"] = "《ＭＯＯＮ》"
    if not multipart:
        video["pages"] = video["pages"][:1]
    save_index(db, video["bvid"], *titles)
    db.save_video(source, video, [])
    clip_id = video["bvid"] + ":100"
    assert db.clip(clip_id)["display_song_title"] == expected
    db.annotate([clip_id], {"display_song_title": "自定义"})
    if multipart:
        db.annotate([video["bvid"] + ":200"], {"display_song_title": "保留另一分 P"})
    assert db.reset_song_title(clip_id)["display_song_title"] == expected
    if multipart:
        assert db.clip(video["bvid"] + ":200")["display_song_title"] == "保留另一分 P"


def test_removed_cid_uses_its_own_last_caption_and_preserves_override_when_missing(db, source, video):
    video["pages"][1]["part"] = "  已归档曲名  "
    db.save_video(source, video, [])
    archived = video["bvid"] + ":200"
    db.annotate([archived], {"display_song_title": "我改的名字"})
    video["pages"] = video["pages"][:1]
    video["title"] = "替换后的视频"
    save_index(db, video["bvid"], "替换后的整理曲名")
    db.save_video(source, video, [])
    assert db.reset_song_title(archived)["display_song_title"] == "已归档曲名"
    db.annotate([archived], {"display_song_title": "再次修改"})
    db.execute("UPDATE parts SET raw_part_title='' WHERE id=?", (archived,))
    with pytest.raises(ValueError, match="保留手动歌名"):
        db.reset_song_title(archived)
    assert db.clip(archived)["display_song_title"] == "再次修改"
    assert db.clip(archived)["manual_fields"] == ["display_song_title"]


@pytest.mark.parametrize("operation", ["refresh", "edit"])
def test_concurrent_refresh_or_annotation_preserves_title_reset(db, source, video, operation):
    video["pages"] = video["pages"][:1]
    video["title"] = "已采集标题"
    db.save_video(source, video, [])
    clip_id = video["bvid"] + ":100"
    db.annotate([clip_id], {"display_song_title": "手动标题", "notes": "保留"})
    video["title"] = "最新上传标题"
    barrier = Barrier(2)

    def apply(reset):
        worker = Database(db.path)
        barrier.wait(timeout=5)
        if reset:
            worker.reset_song_title(clip_id)
        elif operation == "refresh":
            worker.save_video(source, video, [])
        else:
            worker.annotate([clip_id], {"song_group": "新分组", "notes": "新备注"})

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(apply, [True, False]))
    clip = db.clip(clip_id)
    if operation == "refresh":
        assert (clip["display_song_title"], clip["notes"], clip["manual_fields"]) == ("最新上传标题", "保留", [])
    else:
        assert (clip["display_song_title"], clip["notes"], clip["song_group"], clip["manual_fields"]) == (
            "已采集标题", "新备注", "新分组", ["song_group"])
