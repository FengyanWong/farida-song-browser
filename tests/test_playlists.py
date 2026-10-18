from copy import deepcopy

from fastapi.testclient import TestClient

from farida.app import create_app
from farida.db import Database


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
