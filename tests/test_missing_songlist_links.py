from fastapi.testclient import TestClient

from farida.app import create_app
from farida.songlist import CURATOR, URL


def test_missing_links_paginate_index_entries_and_omit_loaded_videos(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        source = next(s for s in db.sources() if s["source_type"] == "songlist")
        sid = source["id"]
        path = f"/api/sources/{sid}/missing-links"
        known = video["bvid"]
        db.save_video(db.source(1), video, [])
        db.execute("UPDATE videos SET availability_status='unavailable' WHERE bvid=?", (known,))
        missing = "BV0000000001"
        other = "BV0000000002"
        references = [
            (1, known), (2, None), (3, missing), (5, "/bad"), (6, missing),
            (7, other), (8, other + "\x00suffix"),
        ]
        with db.connect() as con:
            con.executemany("INSERT INTO curated_songs VALUES(?,?,'同名曲','原唱','中','流行',?,'2026-01-01')",
                            ((sid, key, bvid) for key, bvid in references))
            # A restored catalog might contain unrelated references for another source.
            con.execute("INSERT INTO curated_songs VALUES(1,9,'其他来源','','','',?,'2026-01-01')", (other,))

        first = client.get(path, params={"limit": 1}).json()
        expected = {"id": 3, "song_title": "同名曲", "original_artist": "原唱", "bvid": missing,
                    "url": f"https://www.bilibili.com/video/{missing}/"}
        assert first == {"items": [expected], "next_after_id": 3, "attribution": CURATOR, "source_url": URL}
        second = client.get(path, params={"limit": 2, "after_id": first["next_after_id"]}).json()
        assert second["items"] == [{**expected, "id": 6},
                                   {**expected, "id": 7, "bvid": other, "url": f"https://www.bilibili.com/video/{other}/"}]
        assert second["next_after_id"] is None
        assert client.get(path, params={"after_id": 7}).json()["items"] == []
        assert [row["id"] for row in client.get(path).json()["items"]] == [3, 6, 7]

        video["bvid"] = missing
        db.save_video(db.source(1), video, [])
        assert [row["id"] for row in client.get(path).json()["items"]] == [7]
        assert db.jobs() == []


def test_missing_links_reject_other_sources_and_invalid_pagination(settings):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        source = next(s for s in client.app.state.db.sources() if s["source_type"] == "songlist")
        path = f"/api/sources/{source['id']}/missing-links"
        assert client.get("/api/sources/1/missing-links").status_code == 400
        assert client.get("/api/sources/12345/missing-links").status_code == 404
        assert client.get("/api/sources/999999999999999999999/missing-links").status_code == 404
        for params in ({"limit": 0}, {"limit": 101}, {"after_id": -1}, {"after_id": 2**63}):
            assert client.get(path, params=params).status_code == 400
        assert client.get(path, params={"limit": 100}).json() == {
            "items": [], "next_after_id": None, "attribution": CURATOR, "source_url": URL,
        }
