from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime
from threading import Barrier

import pytest

from fastapi.testclient import TestClient

from farida.app import create_app
from farida.backup import export_backup, restore_backup
from farida.db import Database, PlaylistConflict


def test_playlists_preserve_order_deduplicate_and_survive_restart(db, source, video):
    db.save_video(source, video, [])
    ids = [item['id'] for item in db.clips()['items']]
    result = db.save_playlist('  晚安歌单  ', [ids[1], ids[0], ids[1]])
    assert result['name'] == '晚安歌单'
    assert [item['id'] for item in result['items']] == [ids[1], ids[0]]
    restored = Database(db.path)
    restored.initialize()
    assert restored.playlist(result['id']) == result
    assert restored.playlists()[0]['count'] == 2
    restored.save_playlist('我的歌单', [ids[0]], result['id'])
    assert [item['id'] for item in restored.playlist(result['id'])['items']] == [ids[0]]
    restored.delete_playlist(result['id'])
    assert restored.playlists() == []
    assert restored.clips()['total'] == 2


def test_playlist_changes_are_atomic_and_require_local_token(settings, video):
    app = create_app(settings, scan_on_start=False)
    with TestClient(app) as client:
        db = app.state.db
        db.save_video(db.source(1), video, [])
        ids = [item['id'] for item in db.clips()['items']]
        assert client.post('/api/playlists', json={'name': 'Test'}).status_code == 403
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        response = client.post('/api/playlists', json={'name': '原名称', 'clip_ids': ids})
        assert response.status_code == 201
        playlist = response.json()
        url = '/api/playlists/' + str(playlist['id'])
        assert client.patch(url, json={'name': '不应保存', 'clip_ids': [ids[0], 'missing']}).status_code == 400
        assert client.get(url).json() == playlist
        assert client.post('/api/playlists', json={'name': '   '}).status_code == 400
        assert client.delete(url, headers={'Origin': 'https://evil.example'}).status_code == 403
        assert client.delete(url).status_code == 200
        assert client.get(url).status_code == 404


def test_conditional_playlist_requests_preserve_newer_and_deleted_versions(settings, video, monkeypatch):
    # All writes happen within the very same clock tick, including a delete and recreation.
    fixed = datetime.fromisoformat('2026-01-02T03:04:05+00:00')
    class FrozenClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed
    monkeypatch.setattr('farida.db.datetime', FrozenClock)
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        db.save_video(db.source(1), video, [])
        ids = [part['id'] for part in db.clips()['items']]
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        original = client.post('/api/playlists', json={'name': '晚安', 'clip_ids': ids}).json()
        assert original['revision'].isascii() and 0 < original['id'] < 2**53
        url = '/api/playlists/' + str(original['id'])
        first = client.get(url).json()
        second = client.get(url).json()
        assert first == second == original
        header = 'X-Farida-Playlist-Revision'
        a = client.patch(url, json={'clip_ids': ids[::-1]}, headers={header: first['revision']})
        assert a.status_code == 200 and a.json()['updated_at'] == original['updated_at']
        next_revision = a.json()['revision']
        assert next_revision != first['revision'] and client.get(url).json() == a.json()
        for stale in [client.patch(url, json={'name': '过时'}, headers={header: second['revision']}),
                      client.delete(url, headers={header: second['revision']}),
                      client.patch(url, json={'name': '空版本'}, headers={header: ''})]:
            assert stale.status_code == 409 and stale.headers['X-Farida-Error'] == 'playlist_conflict'
            assert '歌单' in stale.json()['detail']
        assert client.get(url).json() == a.json()
        # Optional headers leave old clients free to make normal unconditional changes.
        renamed = client.patch(url, json={'name': '新歌单'}).json()
        assert renamed['revision'] != next_revision and [item['id'] for item in renamed['items']] == ids[::-1]
        assert client.delete(url, headers={header: renamed['revision']}).status_code == 200
        assert client.get(url).status_code == 404 and client.delete(url).status_code == 404
        for absent in [client.patch(url, json={'name': '复活'}, headers={header: next_revision}),
                       client.delete(url, headers={header: next_revision})]:
            assert absent.status_code == 409 and absent.headers['X-Farida-Error'] == 'playlist_conflict'
        replacement = client.post('/api/playlists', json={'name': '晚安', 'clip_ids': ids}).json()
        assert replacement['id'] != first['id'] and replacement['revision'] != first['revision']
        assert client.delete(url, headers={header: first['revision']}).status_code == 409
        assert client.get('/api/playlists/' + str(replacement['id'])).json() == replacement


@pytest.mark.parametrize("same_playlist", [True, False])
def test_conditional_writers_guard_only_their_playlist(db, source, video, same_playlist):
    db.save_video(source, video, [])
    ids = [part['id'] for part in db.clips()['items']]
    first = db.save_playlist('甲', ids)
    second = first if same_playlist else db.save_playlist('乙', ids)
    barrier = Barrier(2)

    def edit(request):
        playlist, name, ordering = request
        writer = Database(db.path)
        barrier.wait(timeout=5)
        try:
            return writer.save_playlist(name, ordering, playlist['id'], expected_revision=playlist['revision'])
        except PlaylistConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(edit, [(first, '编辑甲', ids[::-1]), (second, '编辑乙', ids[:1])]))
    winners = [result for result in results if result is not None]
    assert len(winners) == (1 if same_playlist else 2)
    for winner in winners:
        assert db.playlist(winner['id']) == winner


def test_playlist_detail_and_write_response_are_coherent_under_concurrent_edits(db, source, video, monkeypatch):
    db.save_video(source, video, [])
    ids = [part['id'] for part in db.clips()['items']]
    original = db.save_playlist('读之前', ids)
    other = Database(db.path)
    connect = db.connect

    @contextmanager
    def update_between_reads():
        with connect() as con:
            def trace(sql):
                if 'JOIN playlist_items pi' in sql:
                    other.save_playlist('读期间', ids[::-1], original['id'])
            con.set_trace_callback(trace)
            yield con
    monkeypatch.setattr(db, 'connect', update_between_reads)
    assert db.playlist(original['id']) == original
    during = other.playlist(original['id'])
    assert during['name'] == '读期间' and [i['id'] for i in during['items']] == ids[::-1]

    @contextmanager
    def update_after_commit():
        with connect() as con:
            yield con
        other.save_playlist('下一次提交', ids[::-1], original['id'])
    monkeypatch.setattr(db, 'connect', update_after_commit)
    saved = db.save_playlist('当前提交', ids[:1], original['id'], expected_revision=during['revision'])
    assert saved['name'] == '当前提交' and [i['id'] for i in saved['items']] == ids[:1]
    assert saved['revision'] != other.playlist(original['id'])['revision']


def test_playlist_revision_checks_saved_backup_state_and_legacy_ids(db, source, video, monkeypatch):
    db.save_video(source, video, [])
    ids = [part['id'] for part in db.clips()['items']]
    stamp = '2024-01-01T12:00:00+00:00'
    db.execute('INSERT INTO playlists VALUES(1,?,?,?)', ('旧歌单', stamp, stamp))
    legacy = db.playlist(1)
    snapshot = export_backup(db)
    updated = db.save_playlist('我的歌单', ids, 1, expected_revision=legacy['revision'])
    restore_backup(db, snapshot)
    assert db.playlist(1) == legacy
    with pytest.raises(PlaylistConflict):
        db.delete_playlist(1, expected_revision=updated['revision'])
    # Restored playlists can keep sequential legacy IDs; collisions on new creation retry safely.
    candidates = iter([0, 2**53 - 2])
    monkeypatch.setattr('farida.db.secrets.randbelow', lambda _: next(candidates))
    new = db.save_playlist('新歌单')
    assert new['id'] == 2**53 - 1 and db.playlist(1) == legacy
    db.save_playlist('恢复后继续编辑', ids, 1, expected_revision=legacy['revision'])


def test_play_all_includes_every_page_and_respects_filters(settings, video):
    app = create_app(settings, scan_on_start=False)
    with TestClient(app) as client:
        db = app.state.db
        for index in range(51):
            item = deepcopy(video)
            item['bvid'] = f'BV{index:010d}'
            db.save_video(db.source(1), item, [])
        first = client.get('/api/clips?page_size=40').json()
        all_items = client.get('/api/play-queue').json()['items']
        assert len(first['items']) == 40 and len(all_items) == 102
        assert len({item['id'] for item in all_items}) == 102
        assert [item['id'] for item in first['items']] == [item['id'] for item in all_items[:40]]
        db.bookmark(all_items[-1]['id'], True)
        assert client.get('/api/play-queue?bookmarked=true').json()['items'] == [all_items[-1]]
        assert len(client.get('/api/play-queue?q=夜に').json()['items']) == 51
        assert client.get('/api/play-queue?after=2025-01-01&before=2020-01-01').status_code == 400
        assert client.get('/api/play-queue?sort=bad').status_code == 422


def test_unavailable_parts_stay_in_saved_playlist(db, source, video):
    db.save_video(source, video, [])
    second = video['bvid'] + ':200'
    playlist = db.save_playlist('多 P 歌单', [second])
    db.execute('UPDATE parts SET active=0 WHERE id=?', (second,))
    item = db.playlist(playlist['id'])['items'][0]
    assert item['id'] == second and item['part_number'] == 2 and item['playback_url'] is None


def test_resolve_pasted_links_locally_without_changing_playlists(settings, video):
    app = create_app(settings, scan_on_start=False)
    with TestClient(app) as client:
        db = app.state.db
        db.save_video(db.source(1), video, [])
        bvid = video['bvid']
        endpoint = '/api/playlists/resolve-links'
        link = f'https://www.bilibili.com/video/{bvid}/'
        posted = {'links': [link + '?p=2&share_source=copy', bvid, link, link + '?p=0002',
                            link + '?p=3', link + '?p=1&p=2', 'https://b23.tv/unknown', 'BV0000000001']}
        assert client.post(endpoint, json=posted).status_code == 403
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        response = client.post(endpoint, json=posted)
        assert response.status_code == 200
        result = response.json()
        items = result.pop('items')
        assert result == {'invalid': 2, 'duplicates': 2, 'missing': 2, 'unavailable': 0}
        assert [item['id'] for item in items] == [bvid + ':200', bvid + ':100']
        assert items[0]['raw_part_title'] == video['pages'][1]['part']
        assert items[0]['playback_url'] == link + '?p=2'
        assert db.playlists() == []
        assert db.listening_history() == []
        assert client.post(endpoint, json={'links': []}).status_code == 422
        assert client.post(endpoint, json={'links': ['x'*2049]}).status_code == 422
        assert client.post(endpoint, json={'links': [bvid]*20000}).json()['duplicates'] == 19999
        assert client.post(endpoint, json={'links': [bvid]*20001}).status_code == 422


def test_playlist_import_recognizes_bilibili_share_captions(db, source, video):
    db.save_video(source, video, [])
    bvid = video['bvid']
    url = f'https://www.bilibili.com/video/{bvid}/'
    mobile = url.replace('www.', 'm.')
    links = [
        f'【【法里达】歌曲分享】 {mobile}?p=2&share_source=copy',
        '【歌曲分享-哔哩哔哩】', url,               # Title and URL copied on separate lines
        f'【歌曲分享】\n{mobile}?p=2',              # API clients may send a whole copied entry
        'Unrelated invalid row', url + '?p=1',     # Remains an invalid row and a duplicate
        '【待检查】', 'invalid',                    # Neither line is a valid entry
        f'【歌曲分享】 {url} {mobile}?p=2',          # Multiple links in one line
        f'【歌曲分享】 https://bilibili.com.evil.example/video/{bvid}',
        '【歌曲分享】 https://b23.tv/test',
        f'【https://other.example/clip】 {url}',
        '【缺少下一行】',
    ]
    result = db.resolve_playlist_links(links)
    items = result.pop('items')
    assert [item['id'] for item in items] == [bvid + ':200', bvid + ':100']
    assert result == {'invalid': 8, 'duplicates': 2, 'missing': 0, 'unavailable': 0}


def test_pasted_part_uses_active_replacement_and_skips_unavailable(db, source, video):
    db.save_video(source, video, [])
    updated = deepcopy(video)
    updated['pages'][0]['cid'] = 333
    db.save_video(source, updated, [])
    bvid = video['bvid']
    url = f'https://m.bilibili.com/video/{bvid}/?p=2'
    db.execute('UPDATE parts SET active=0 WHERE id=?', (bvid + ':200',))
    result = db.resolve_playlist_links([url, bvid])
    assert [item['id'] for item in result['items']] == [bvid + ':333']
    assert result['unavailable'] == 1 and result['missing'] == 0
    db.execute('UPDATE videos SET availability_status=? WHERE bvid=?', ('unavailable', bvid))
    assert db.resolve_playlist_links([bvid, url]) == {
        'items': [], 'invalid': 0, 'duplicates': 0, 'missing': 0, 'unavailable': 2}


def test_summary_playlist_saves_return_matching_revisions_without_reading_clip_details(settings, video, monkeypatch):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        db.save_video(db.source(1), video, [])
        ids = [item["id"] for item in db.clips()["items"]]
        client.headers["X-Farida-Token"] = client.get("/api/session").json()["token"]
        # Summary writes must not construct the full playlist response inside the transaction.
        with monkeypatch.context() as patch:
            def unexpected(*args):
                pytest.fail("summary save fetched full song metadata")
            patch.setattr(Database, "_read_playlist", unexpected)
            created = client.post("/api/playlists?summary=true", json={"name": "排序", "clip_ids": [*ids, ids[0]]})
            assert created.status_code == 201
            receipt = created.json()
            assert set(receipt) == {"id", "revision"}
            target = "/api/playlists/" + str(receipt["id"])
            headers = {"X-Farida-Playlist-Revision": receipt["revision"]}
            renamed = client.patch(target+"?summary=true", headers=headers, json={"name": "改名"}).json()
            assert set(renamed) == {"id", "revision"} and renamed["revision"] != receipt["revision"]
            assert client.patch(target+"?summary=true", headers=headers, json={"clip_ids": []}).status_code == 409
        full = client.get(target).json()
        assert full["name"] == "改名" and full["revision"] == renamed["revision"]
        assert [item["id"] for item in full["items"]] == ids
        reordered = client.patch(target+"?summary=true", json={"clip_ids": ids[::-1]}).json()
        assert reordered["revision"] == client.get(target).json()["revision"]
        assert [item["id"] for item in client.get(target).json()["items"]] == ids[::-1]


def test_copy_links_resolves_current_parts_in_draft_order(settings, video):
    opened = []
    app = create_app(settings, scan_on_start=False, browser_opener=lambda url: opened.append(url) or True)
    with TestClient(app) as client:
        db = app.state.db
        bvid = video["bvid"]
        video["pages"].append({"cid": 300, "page": 3, "part": "第三首", "duration": 60})
        db.save_video(db.source(1), video, [])
        clip_id = lambda cid: f"{bvid}:{cid}"
        url = lambda page: f"https://www.bilibili.com/video/{bvid}/?p={page}"
        draft = [clip_id(300), clip_id(100), "missing", clip_id(200)]
        endpoint = "/api/playlists/copy-links"
        assert client.post(endpoint, json={"clip_ids": draft}).status_code == 403
        client.headers["X-Farida-Token"] = client.get("/api/session").json()["token"]

        def copy(ids):
            response = client.post(endpoint, json={"clip_ids": ids})
            assert response.status_code == 200
            return response.json()

        assert copy(draft) == {"links": [url(3), url(1), url(2)], "skipped": 1}
        first, second, _ = video["pages"]
        video["pages"] = [{**second, "page": 1}, {**first, "page": 2, "cid": 400}, {**first, "page": 3}]
        db.save_video(db.source(1), video, [])
        assert copy(draft) == {"links": [url(3), url(1)], "skipped": 2}
        assert copy([]) == {"links": [], "skipped": 0}
        assert copy([clip_id(100), clip_id(200)] * 600) == {"links": [url(3), url(1)] * 600, "skipped": 0}
        assert copy(["missing"] * 20000) == {"links": [], "skipped": 20000}
        assert client.post(endpoint, json={"clip_ids": ["missing"] * 20001}).status_code == 422
        assert client.post(endpoint, json={"clip_ids": ["x" * 101]}).status_code == 422
        assert opened == []
        assert client.post(f"/api/clips/{clip_id(100)}/open").json()["url"] == url(3)
        assert client.post(f"/api/clips/{clip_id(300)}/open").status_code == 409
        assert opened == [url(3)]
        db.execute("UPDATE videos SET availability_status='unavailable' WHERE bvid=?", (bvid,))
        assert copy(draft) == {"links": [], "skipped": 4}
