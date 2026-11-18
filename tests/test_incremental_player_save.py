import json

from fastapi.testclient import TestClient
from farida.app import create_app


def checkpoint(key, sequence, clip, position=24.5):
    return {'queue_key': key, 'sequence': sequence, 'current_id': clip,
            'position': position, 'segment': 1, 'shuffle': True,
            'repeat': 'all', 'skip_unavailable': True}


def test_checkpoints_preserve_queue_and_preferences_across_backup_and_restart(settings, video):
    app = create_app(settings, scan_on_start=False)
    with TestClient(app) as client:
        db = app.state.db
        db.save_video(db.source(1), video, [])
        ids = [item['id'] for item in db.clips()['items']]
        uri = '/api/player-state'
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        started = client.put(uri, json={'clip_ids': ids, 'current_id': ids[0], 'name': '中文队列'})
        queue_key = started.json()['queue_key']
        original_row = db.one('SELECT value FROM playback_state WHERE id=1')
        data = checkpoint(queue_key, 3, ids[1])
        assert client.patch(uri, json=data).json() == {'saved': True}
        assert db.one('SELECT value FROM playback_state WHERE id=1') == original_row
        assert client.patch(uri, json=checkpoint(queue_key, 2, ids[0])).json() == {'saved': False}
        assert client.patch(uri, json=data).json() == {'saved': False}
        assert client.patch(uri, json={**data,'sequence':4,'position':-1}).status_code == 422
        assert client.patch(uri, json=data, headers={'X-Farida-Token': ''}).status_code == 403
        assert client.patch('/api/player-preferences', json={'volume':0.42,'muted':True,'compact':True}).status_code == 200
        snapshot = client.get('/api/backup').json()
        public_state = client.get(uri).json()
        exported = json.loads(snapshot['tables']['playback_state'][0]['value'])
        assert exported == {k:v for k,v in public_state.items() if k!='items'}
        assert queue_key not in json.dumps(snapshot) and 'playback_progress' not in snapshot['tables']
        assert exported['clip_ids']==ids and exported['name']=='中文队列'
        assert all(exported[k]==v for k,v in data.items() if k not in {'queue_key','sequence'})
        assert exported['muted'] and exported['volume']==0.42
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        assert client.get(uri).json() == public_state
        assert client.post('/api/restore',json=snapshot).status_code == 200
        assert client.patch(uri,json=checkpoint(queue_key, 4, ids[0])).json() == {'saved': False}
        assert client.get(uri).json() == public_state


def test_replacing_queue_invalidates_delayed_writes_from_previous_page(settings):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        uri = '/api/player-state'
        first = {'name':'one','clip_ids':['first'], 'current_id':'first'}
        second = {'name':'two','clip_ids':['second'], 'current_id':'second'}
        key1=client.put(uri,json=first).json()['queue_key']
        key2=client.put(uri,json=second).json()['queue_key']
        assert key1!=key2
        assert client.patch(uri,json=checkpoint(key1, 99, 'first')).json()=={'saved':False}
        assert client.patch(uri,json=checkpoint(key2, 1, 'second')).json()=={'saved':True}
        assert client.get(uri).json()['clip_ids']==['second']
