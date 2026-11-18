from contextlib import contextmanager
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from farida.app import create_app
from farida.classifier import normalize_performer
from farida.db import Database


def add_video(db, source, video, index, title=None):
    item = deepcopy(video)
    item['bvid'] = f'BV{index:010d}'
    item['pubdate'] += index
    if title:
        item['pages'][0]['part'] = title
    db.save_video(source, item, [])
    return item['bvid'] + ':100'


def test_grouped_search_counts_once_and_hydrates_interleaved_versions_from_one_snapshot(db, source, video, monkeypatch):
    ids = []
    for index, group in enumerate(["Ａ", "月", "a", "星", "月", "星", "海"]):
        item = deepcopy(video)
        item.update(bvid=f"BV{index:010d}", title=f"法里达 翻唱《版本{index}》", pubdate=video["pubdate"] - index)
        item["pages"] = item["pages"][:1]
        db.save_video(source, item, ["法里达"])
        ids.append(item["bvid"] + ":100")
        db.annotate([ids[-1]], {"song_group": group, "notes": f"笔记{index}"})
    connect = db.connect
    search_calls, edits = [], []

    @contextmanager
    def edit_after_ranking():
        with connect() as con:
            def counted_search(text):
                search_calls.append(text)
                return normalize_performer(text)
            con.create_function("search_text", 1, counted_search, deterministic=True)
            def trace(sql):
                if "WHERE p.id IN (SELECT value FROM json_each(" in sql:
                    with connect() as writer:
                        edits.append(writer.execute("UPDATE parts SET active=0 WHERE id=?", (ids[0],)).rowcount)
                        writer.execute("UPDATE annotations SET display_song_title='刚刚修改' WHERE clip_id=?", (ids[0],))
            con.set_trace_callback(trace)
            yield con

    with monkeypatch.context() as patch:
        patch.setattr(db, "connect", edit_after_ranking)
        page = db.grouped_clips(q="法里达", page_size=2)
    assert len(search_calls) == 7 and edits == [1]
    assert (page["total_clips"], page["total"]) == (7, 4)
    assert [(g["key"], g["title"], g["clip_ids"]) for g in page["groups"]] == [
        ("a", "Ａ", [ids[0], ids[2]]), ("月", "月", [ids[1], ids[4]])]
    assert [item["id"] for item in page["items"]] == [ids[0], ids[2], ids[1], ids[4]]
    first = page["items"][0]
    assert first["active"] == 1 and first["display_song_title"] == "版本0" and first["notes"] == "笔记0"
    assert db.clip(ids[0])["active"] == 0 and db.clip(ids[0])["display_song_title"] == "刚刚修改"
    missing = db.grouped_clips(q="法里达", page=3, page_size=2, compact=True)
    assert missing["groups"] == missing["items"] == [] and (missing["total"], missing["total_clips"]) == (4, 6)


def test_groups_page_complete_versions_and_keep_order(db, source, video):
    ids = [add_video(db, source, video, i) for i in range(45)]
    flat = db.clips(page_size=100)
    assert flat['total'] == 90
    first = db.grouped_clips(page_size=1)
    second = db.grouped_clips(page=2, page_size=1)
    assert first['total'] == second['total'] == 2
    assert first['total_clips'] == 90
    assert len(first['groups']) == 1 and first['groups'][0]['count'] == 45
    assert [item['id'] for item in first['items']] == list(reversed(ids))
    assert first['groups'][0]['clip_ids'] == list(reversed(ids))
    assert len(second['items']) == 45
    assert not set(first['groups'][0]['clip_ids']) & set(second['groups'][0]['clip_ids'])
    oldest = db.grouped_clips(page_size=1, sort='oldest')
    assert [item['id'] for item in oldest['items']] == ids
    assert db.grouped_clips(page=3, page_size=1)['items'] == []
    assert db.clips(page_size=100) == flat  # Grouping never rewrites or deletes clips.


def test_groups_match_only_normalized_titles_or_explicit_groups(db, source, video):
    first = add_video(db, source, video, 1, '《ＡＢＣ》')
    second = add_video(db, source, video, 2, '《abc》')
    third = add_video(db, source, video, 3, '《abc live》')
    groups = db.grouped_clips()['groups']
    abc = next(g for g in groups if g['key'] == 'abc')
    assert set(abc['clip_ids']) == {first, second}
    assert third not in abc['clip_ids']
    db.annotate([third], {'song_group': 'ABC'})
    abc = next(g for g in db.grouped_clips()['groups'] if g['key'] == 'abc')
    assert set(abc['clip_ids']) == {first, second, third}
    db.bookmark(second, True)
    result = db.grouped_clips(bookmarked=True)
    assert result['total'] == result['total_clips'] == 1
    assert result['items'][0]['id'] == second
    assert db.grouped_clips(q='nonexistent')['groups'] == []
    db.annotate([third], {'inclusion_status': 'excluded'})
    assert db.grouped_clips(status='excluded')['groups'][0]['clip_ids'] == [third]


def test_group_and_history_api_validation(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        clip = add_video(db, db.source(1), video, 1)
        assert client.get('/api/clips?grouped=true&page_size=1').json()['total'] == 2
        assert client.get('/api/clips?grouped=true&page_size=0').status_code == 400
        assert client.get('/api/clips?grouped=true&sort=unknown').status_code == 422
        assert len(client.get('/api/play-queue?grouped=true&page_size=1').json()['items']) == 2
        assert client.post('/api/listening-history', json={'clip_id': clip}).status_code == 403
        assert client.delete('/api/listening-history').status_code == 403
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        assert client.post('/api/listening-history', json={'clip_id': 'unknown'}).status_code == 404
        assert client.post('/api/listening-history', json={'clip_id': clip, 'unexpected': 1}).status_code == 422
        assert client.post('/api/listening-history', json={'clip_id': clip}).status_code == 200
        items = client.get('/api/listening-history').json()['items']
        assert items[0]['id'] == clip and items[0]['last_played_at']
        assert client.delete('/api/listening-history', headers={'Origin': 'https://example.com'}).status_code == 403
        assert client.delete('/api/listening-history').json()['cleared']
        assert client.get('/api/listening-history').json()['items'] == []
        assert db.clip(clip)
        state = client.get('/api/player-state').json()
        assert state['skip_unavailable'] is False
        assert client.put('/api/player-state', json={'skip_unavailable': True}).status_code == 200
        assert client.get('/api/player-state').json()['skip_unavailable'] is True


def test_history_deduplicates_caps_survives_restart_and_keeps_unavailable(db, source, video):
    ids = [add_video(db, source, video, i) for i in range(102)]
    for clip in ids:
        db.record_listening(clip)
    history = db.listening_history()
    assert len(history) == 100
    assert [item['id'] for item in history] == list(reversed(ids[2:]))
    db.record_listening(ids[2])
    assert db.listening_history()[0]['id'] == ids[2]
    assert len(db.listening_history()) == 100
    db.execute('UPDATE parts SET active=0 WHERE id=?', (ids[2],))
    reopened = Database(db.path)
    reopened.initialize()
    assert reopened.listening_history()[0]['playback_url'] is None
    with pytest.raises(ValueError):
        reopened.record_listening(ids[2])
    with pytest.raises(KeyError):
        reopened.record_listening('missing')
