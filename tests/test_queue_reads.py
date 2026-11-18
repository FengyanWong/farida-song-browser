from copy import deepcopy

from fastapi.testclient import TestClient

from farida.app import create_app


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
