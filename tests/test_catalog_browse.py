from contextlib import contextmanager
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from farida.app import create_app


BROWSE_FIELDS = set("""
    id part_number raw_part_title part_count uploader_uid uploader_name raw_title thumbnail_url
    published_at display_song_title song_group inclusion_status bookmarked has_curated_credit playback_url
""".split())


@pytest.mark.parametrize("grouped", [False, True])
def test_compact_catalog_matches_full_page_for_sort_filter_and_group(settings, video, grouped):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        source = db.source(1)
        db.save_video(source, video, ["翻唱"])
        newer = deepcopy(video)
        newer["bvid"] = "BV0000000001"
        newer["pubdate"] += 10
        db.save_video(source, newer, ["翻唱"])
        credited = video["bvid"] + ":100"
        ids = [credited, newer["bvid"] + ":100"]
        db.annotate(ids, {"song_group": "同一首歌", "notes": "detail only"})
        for clip_id in ids:
            db.bookmark(clip_id, True)
        db.execute("UPDATE videos SET availability_status='unavailable' WHERE bvid=?", (newer["bvid"],))
        db.execute("INSERT INTO curated_songs VALUES(6,1,'曲名','歌手','中','翻唱',?,'2026-01-01')",
                   (video["bvid"],))

        for sort in ("newest", "oldest", "uploader", "uploader_desc", "title", "title_desc", "discovered"):
            for extra in ({}, {"bookmarked": True, "q": "同一首歌", "source_id": 1},
                          {"q": f'https://www.bilibili.com/video/{video["bvid"]}/?p=2'},
                          {"page": 2, "page_size": 1}):
                query = {"grouped": grouped, "sort": sort, **extra}
                full = client.get("/api/clips", params=query).json()
                compact = client.get("/api/clips", params={**query, "compact": True}).json()
                assert compact["items"] == [{k: row[k] for k in BROWSE_FIELDS} for row in full["items"]]
                assert {k: v for k, v in compact.items() if k != "items"} == {
                    k: v for k, v in full.items() if k != "items"
                }
        compact = client.get("/api/clips", params={"grouped": grouped, "compact": True}).json()
        by_id = {row["id"]: row for row in compact["items"]}
        assert by_id[credited]["has_curated_credit"] == 1 and by_id[credited]["part_count"] == 2
        assert by_id[ids[1]]["playback_url"] is None
        detail = client.get("/api/clips/" + credited).json()
        assert detail["notes"] == "detail only" and detail["tags"] == ["翻唱"]
        exported = client.get("/api/export", params={"format": "json", "compact": True}).json()
        assert next(row for row in exported if row["id"] == credited)["notes"] == "detail only"


def test_flat_count_and_page_share_a_snapshot_during_a_collection_write(db, source, video, monkeypatch):
    db.save_video(source, video, [])
    connect = db.connect
    writes = []

    @contextmanager
    def update_before_page_query():
        with connect() as reader:
            reads = 0

            def track(sql):
                nonlocal reads
                if not sql.lstrip().upper().startswith("SELECT"):
                    return
                reads += 1
                if reads == 2:
                    with connect() as writer:
                        writes.append(writer.execute("UPDATE parts SET active=0").rowcount)

            reader.set_trace_callback(track)
            yield reader

    monkeypatch.setattr(db, "connect", update_before_page_query)
    page = db.clips(compact=True)
    assert page["total"] == len(page["items"]) == 2
    assert writes == [2]
    with connect() as con:
        assert con.execute("SELECT SUM(active) FROM parts").fetchone()[0] == 0
