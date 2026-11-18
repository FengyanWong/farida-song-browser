import csv
from copy import deepcopy
import importlib
import io

import pytest
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse

from farida.app import create_app


FIELDS = ("display_song_title", "raw_title", "uploader_name", "published_at", "video_bvid", "cid",
          "part_number", "playback_url", "inclusion_status", "songlist_attribution", "songlist_url")


def expected_csv(entries):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(FIELDS)
    for entry in entries:
        row = []
        for key in FIELDS:
            value = entry[key]
            text = str(value or "")
            row.append("'" + text if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else value)
        writer.writerow(row)
    return output.getvalue().encode("utf-8-sig")


def test_csv_bytes_match_the_full_export_for_filters_and_sorts(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        source = db.source(1)
        video["title"] = '  =合唱,"直播"\r\n第二行'
        db.save_video(source, video, ["翻唱"])
        second = deepcopy(video)
        second["bvid"] = "BV0000000001"
        second["pubdate"] += 30
        db.save_video(source, second, [])
        first_clip = video["bvid"] + ":100"
        db.annotate([first_clip], {"display_song_title": "+中文歌"})
        db.bookmark(first_clip, True)
        db.execute("UPDATE videos SET availability_status='unavailable' WHERE bvid=?", (second["bvid"],))
        for song_id in (1, 2):
            db.execute("INSERT INTO curated_songs VALUES(6,?,'曲名','歌手','中','翻唱',?,'2026-01-01')",
                       (song_id, video["bvid"]))

        for query in ({}, {"sort": "oldest"}, {"sort": "title"}, {"sort": "uploader", "source_id": 1},
                      {"status": "all", "sort": "discovered"}, {"bookmarked": True},
                      {"q": f'https://www.bilibili.com/video/{video["bvid"]}/?p=2'}, {"q": "not-a-match"}):
            entries = client.get("/api/export", params={**query, "format": "json"}).json()
            response = client.get("/api/export", params=query)
            assert response.status_code == 200 and response.content == expected_csv(entries)
            assert int(response.headers["content-length"]) == len(response.content)
            assert response.headers["content-type"] == "text/csv; charset=utf-8"
            assert response.headers["content-disposition"] == "attachment; filename=farida-clips.csv"
        rows = list(csv.DictReader(io.StringIO(client.get("/api/export").content.decode("utf-8-sig"))))
        assert len(rows) == 4
        assert {row["songlist_attribution"] for row in rows if row["video_bvid"] == video["bvid"]} == {"CLANNADOR"}
        assert next(row for row in rows if row["video_bvid"] == second["bvid"])["playback_url"] == ""
        assert any(row["display_song_title"] == "'+中文歌" for row in rows)



def test_grouped_downloads_and_queue_match_all_catalog_pages_in_display_order(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        ids = []
        for index, group in enumerate(("夜", "Ｂ", "夜", "b", "夜", "星")):
            entry = deepcopy(video)
            entry.update(bvid=f"BV{index:010d}", pubdate=video["pubdate"] + index)
            entry["owner"]["name"] = f"歌手{index % 3}"
            entry["pages"] = entry["pages"][:1]
            db.save_video(db.source(1), entry, ["翻唱"])
            ids.append(entry["bvid"] + ":100")
            db.annotate([ids[-1]], {"song_group": group, "display_song_title": f"歌{index}",
                                    "inclusion_status": "excluded" if index == 0 else "included"})
            db.bookmark(ids[-1], index % 2 == 0)

        for sort in ("newest", "oldest", "title", "title_desc", "uploader", "uploader_desc", "discovered"):
            for scope in ({}, {"status": "all", "source_id": 1, "after": "2023-11-14", "before": "2023-11-14"},
                          {"status": "excluded"}, {"status": "all", "bookmarked": True}, {"q": "不存在"}):
                query = {**scope, "sort": sort, "grouped": True}
                page = client.get("/api/clips", params={**query, "page_size": 1}).json()
                expected = list(page["items"])
                for number in range(2, page["total"] + 1):
                    expected += client.get("/api/clips", params={**query, "page_size": 1, "page": number}).json()["items"]
                if sort == "newest" and not scope:
                    assert [item["id"] for item in expected] == [ids[5], ids[4], ids[2], ids[3], ids[1]]
                queue = client.get("/api/play-queue", params=query).json()["items"]
                assert [item["id"] for item in queue] == [item["id"] for item in expected]
                flat = client.get("/api/play-queue", params={**scope, "sort": sort}).json()["items"]
                flat_catalog = client.get("/api/clips", params={**scope, "sort": sort}).json()["items"]
                assert [item["id"] for item in flat] == [item["id"] for item in flat_catalog]
                as_json = client.get("/api/export", params={**query, "format": "json"})
                assert as_json.content == JSONResponse(expected).body
                assert int(as_json.headers["content-length"]) == len(as_json.content)
                assert as_json.headers["content-type"] == "application/json"
                assert client.get("/api/export", params=query).content == expected_csv(expected)


def test_export_uses_one_snapshot(db, source, video):
    db.save_video(source, video, [])
    with db.export_rows("csv") as rows:
        first = next(rows)
        db.execute("UPDATE videos SET raw_title='changed during export'")
        remaining = list(rows)
    assert len(remaining) == 1 and first[1] == remaining[0][1] == video["title"]


@pytest.mark.parametrize("format", ["csv", "json"])
async def test_export_closes_spool_on_disconnect(settings, format):
    app = create_app(settings, scan_on_start=False)
    app.state.db.initialize()
    endpoint = next(route.endpoint for route in app.routes if route.path == "/api/export")
    response = endpoint(format=format, grouped=True)

    async def disconnect_on_body(message):
        if message["type"] == "http.response.body":
            raise OSError("simulated client disconnect")

    async def receive():
        return {"type": "http.disconnect"}

    with pytest.raises(ClientDisconnect):
        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, disconnect_on_body)
    assert response.stream.closed


@pytest.mark.parametrize("format", ["csv", "json"])
def test_export_closes_spool_on_query_failure(settings, monkeypatch, format):
    app_module = importlib.import_module("farida.app")
    app = create_app(settings, scan_on_start=False)
    stream = app_module.tempfile.SpooledTemporaryFile(mode="w+", encoding="utf-8", newline="")
    monkeypatch.setattr(app_module.tempfile, "SpooledTemporaryFile", lambda **kwargs: stream)

    def bad_rows(*_, **kwargs):
        raise RuntimeError("simulated query failure")

    monkeypatch.setattr(app.state.db, "export_rows", bad_rows)
    endpoint = next(route.endpoint for route in app.routes if route.path == "/api/export")
    with pytest.raises(RuntimeError, match="simulated query failure"):
        endpoint(format=format, grouped=True)
    assert stream.closed
