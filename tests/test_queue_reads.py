import json
from copy import deepcopy

from fastapi.testclient import TestClient

from farida.app import create_app
from farida.player_state import PlayerState


def test_saved_queue_compatibility_and_order(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        source = db.source(1)
        for index in range(3):
            item = deepcopy(video)
            item['bvid'] = f'BV{index:010d}'
            db.save_video(source, item, [])
        live, inactive, unavailable = (f'BV{i:010d}:100' for i in range(3))
        second = live.replace(':100', ':200')
        db.execute('UPDATE parts SET active=0 WHERE id=?', (inactive,))
        db.execute("UPDATE videos SET availability_status='unavailable' WHERE bvid=?", (unavailable.split(':')[0],))
        db.annotate([live], {'inclusion_status': 'excluded', 'notes': 'saved annotation'})
        ids = [second, 'not-found', live, inactive, second, unavailable]
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        assert client.put('/api/player-state', json={'clip_ids': ids, 'current_id': live}).status_code == 200
        full = client.get('/api/player-state').json()
        compact = client.get('/api/player-state', params={'compact': 'true'}).json()

        # Unavailable and missing clips stay in the saved IDs but cannot play.
        assert full['clip_ids'] == compact['clip_ids'] == ids
        assert [row['id'] for row in full['items']] == [second, live, second]
        assert full['items'][1]['notes'] == 'saved annotation'
        assert full['items'][1]['inclusion_status'] == 'excluded'
        queue = client.get('/api/play-queue', params={'status': 'all'}).json()['items']
        by_id = {row['id']: row for row in queue}
        assert compact['items'] == [by_id[second], by_id[live], by_id[second]]
        for short, detailed in zip(compact['items'], full['items']):
            assert short == {key: detailed[key] for key in short}


def test_saved_queue_uses_one_parameter_for_large_lists(db, source, video):
    db.save_video(source, video, [])
    clip = video['bvid'] + ':100'
    # A backup can reference clips that are no longer in the active catalog.
    ids = [str(i) for i in range(19998)] + [clip, clip]
    result = db.saved_queue(ids, compact=True)
    assert [row['id'] for row in result] == [clip, clip]


def test_player_summary_skips_queue_hydration_and_keeps_full_contracts(settings, video, monkeypatch):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        uri = '/api/player-state'
        db = client.app.state.db
        db.save_video(db.source(1), video, [])
        a, b = [item['id'] for item in db.clips()['items']]
        ids = [f'unavailable-{i}' for i in range(19996)] + [a, b, a, b]
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        default = client.get(uri + '?summary=true').json()
        assert default['current_item'] is None and default['resume_queue_key'] is None
        assert default['volume'] == 1 and 'preference_writer' in default
        assert 'clip_ids' not in default and 'items' not in default
        started = client.put(uri, json={'clip_ids': ids, 'current_id': a, 'name': '本地队列'})
        key = started.json()['queue_key']
        progress = {'current_id': b, 'position': 19, 'segment': 1, 'shuffle': True, 'repeat': 'one', 'skip_unavailable': True}
        assert client.patch(uri, json={**progress, 'queue_key': key, 'sequence': 1}).json() == {'saved': True}
        writer_header = {'X-Farida-Preference-Writer': default['preference_writer'], 'X-Farida-Preference-Sequence': '1'}
        assert client.patch('/api/player-preferences', json={'volume': .25, 'muted': True, 'compact': True},
                            headers=writer_header).json() == {'saved': True}
        with monkeypatch.context() as guard:
            def no_queue(*args, **kwargs):
                raise AssertionError('Summary must not hydrate the stored queue')
            guard.setattr(db, 'saved_queue', no_queue)
            validate = PlayerState.model_validate_json
            def only_scalars(cls, data):
                assert len(data) < 1024 and 'clip_ids' not in json.loads(data)
                return validate(data)
            guard.setattr(PlayerState, 'model_validate_json', classmethod(only_scalars))
            response = client.get(uri + '?summary=true')
        assert response.status_code == 200 and len(response.content) < 1024
        summary = response.json()
        assert summary['current_item'] == {'id': b, 'display_song_title': db.clip(b)['display_song_title']}
        assert summary['resume_queue_key'] and summary['resume_queue_key'] != key
        assert 'clip_ids' not in summary and 'items' not in summary
        assert (summary['volume'], summary['muted'], summary['compact']) == (.25, True, True)
        assert all(summary[k] == v for k, v in progress.items())

        full = client.get(uri).json()
        compact = client.get(uri + '?compact=true').json()
        hydrate = client.get(uri + '?compact=true&resume=true').json()
        assert 'resume_queue_key' not in full and 'resume_queue_key' not in compact
        assert 'preference_writer' not in full and 'preference_writer' not in hydrate
        assert 'preference_writer' in compact
        assert hydrate['items'] == compact['items'] and hydrate['clip_ids'] == compact['clip_ids'] == full['clip_ids'] == ids
        assert [item['id'] for item in hydrate['items']] == [a, b, a, b]
        assert hydrate['resume_queue_key'] == summary['resume_queue_key']
        # A new queue with the same current ID must still replace the old offer.
        client.put(uri, json={'clip_ids': [b, a], 'current_id': b})
        replacement = client.get(uri + '?compact=true&resume=true').json()
        assert replacement['resume_queue_key'] != summary['resume_queue_key'] and replacement['current_id'] == b


def test_player_summary_requires_a_playable_member_and_handles_legacy_restore(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        db.save_video(db.source(1), video, [])
        a, b = [item['id'] for item in db.clips()['items']]
        uri = '/api/player-state'
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        for ids, current in [([], None), ([], a), ([b], a), (['missing'], 'missing')]:
            client.put(uri, json={'clip_ids': ids, 'current_id': current})
            summary = client.get(uri + '?summary=true').json()
            assert summary['current_item'] is None
            if not ids:
                assert summary['resume_queue_key'] is None
        client.put(uri, json={'clip_ids': [a, b], 'current_id': b})
        live = client.get(uri + '?summary=true').json()
        db.execute('UPDATE parts SET active=0 WHERE id=?', (b,))
        assert client.get(uri + '?summary=true').json()['current_item'] is None
        db.execute('UPDATE parts SET active=1 WHERE id=?', (b,))
        db.execute("UPDATE videos SET availability_status='unavailable' WHERE bvid=?", (video['bvid'],))
        assert client.get(uri + '?summary=true').json()['current_item'] is None
        db.execute("UPDATE videos SET availability_status='available' WHERE bvid=?", (video['bvid'],))
        backup = client.get('/api/backup').json()
        # Old backups do not contain progress keys and can omit newer playback preferences.
        restored = {'clip_ids': [a, b], 'current_id': b, 'position': 3}
        backup['tables']['playback_state'][0]['value'] = json.dumps(restored)
        assert client.post('/api/restore', json=backup).status_code == 200
        legacy = client.get(uri + '?summary=true').json()
        hydrate = client.get(uri + '?compact=true&resume=true').json()
        assert legacy['current_item'] == live['current_item'] and legacy['volume'] == 1
        assert legacy['resume_queue_key'] == hydrate['resume_queue_key'] != live['resume_queue_key']
        assert legacy['position'] == hydrate['position'] == 3 and hydrate['clip_ids'] == [a, b]
        for change in ({'clip_ids': [b, a]}, {'name': '另一歌单'}):
            db.execute('UPDATE playback_state SET value=? WHERE id=1', (json.dumps({**restored, **change}),))
            assert client.get(uri + '?summary=true').json()['resume_queue_key'] != legacy['resume_queue_key']
