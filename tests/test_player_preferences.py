from copy import deepcopy

from fastapi.testclient import TestClient
from farida.app import create_app


def test_preferences_preserve_queue_while_stopped_and_survive_restart(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db=client.app.state.db
        db.save_video(db.source(1), video, [])
        clip=video['bvid']+':100'
        token=client.get('/api/session').json()['token']
        preferences={'volume':0.27,'muted':True,'compact':True}
        assert client.patch('/api/player-preferences',json=preferences).status_code==403
        client.headers['X-Farida-Token']=token
        state={'clip_ids':[clip],'current_id':clip,'position':46.5,'name':'保留歌单','shuffle':True}
        assert client.put('/api/player-state',json=state).status_code==200
        assert client.patch('/api/player-preferences',json=preferences).status_code==200
        saved=client.get('/api/player-state').json()
        assert all(saved[key]==value for key,value in preferences.items())
        assert saved['clip_ids']==[clip] and saved['position']==46.5 and saved['shuffle']
        snapshot=client.get('/api/backup').json()
        assert client.patch('/api/player-preferences',json={**preferences,'volume':0.8}).status_code==200
        assert client.post('/api/restore',json=snapshot).status_code==200
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        saved=client.get('/api/player-state').json()
        assert saved['volume']==0.27 and saved['muted'] and saved['compact']
        assert saved['clip_ids']==[clip] and saved['position']==46.5


def test_legacy_player_state_defaults_and_empty_queue_preferences(settings):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        client.headers['X-Farida-Token']=client.get('/api/session').json()['token']
        db=client.app.state.db
        db.execute('INSERT INTO playback_state(id,value) VALUES(1,?)', ('{"position":25,"shuffle":true}',))
        saved=client.get('/api/player-state').json()
        assert saved['volume']==1 and not saved['muted'] and not saved['compact']
        assert client.patch('/api/player-preferences',json={'volume':0,'muted':False,'compact':True}).status_code==200
        saved=client.get('/api/player-state').json()
        assert saved['volume']==0 and saved['compact'] and saved['position']==25 and saved['shuffle']


def test_invalid_preferences_and_restore_do_not_change_state(settings):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        client.headers['X-Farida-Token']=client.get('/api/session').json()['token']
        prefs={'volume':0.5,'muted':False,'compact':False}
        assert client.patch('/api/player-preferences',json=prefs).status_code==200
        saved=client.get('/api/player-state').json()
        for patch in ({**prefs,'volume':-0.1},{**prefs,'volume':1.1},{**prefs,'volume':'NaN'},{**prefs,'unexpected':True}):
            assert client.patch('/api/player-preferences',json=patch).status_code==422
        assert client.patch('/api/player-preferences',json=prefs,headers={'Origin':'https://example.com'}).status_code==403
        snapshot=client.get('/api/backup').json()
        bad=deepcopy(snapshot)
        bad['tables']['playback_state'][0]['value']='{"volume":42}'
        assert client.post('/api/restore',json=bad).status_code==400
        assert client.get('/api/player-state').json()==saved


def test_quick_close_out_of_order_and_cross_tab_preferences(settings):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        def writer():
            return client.get('/api/player-state?compact=true').json()['preference_writer']
        first, second = writer(), writer()
        def send(key, seq, fields, **values):
            return client.patch('/api/player-preferences',
                json={'volume':1, 'muted':False, 'compact':False, **values},
                headers={'X-Farida-Preference-Writer':key, 'X-Farida-Preference-Sequence':str(seq),
                         'X-Farida-Preference-Fields':fields}).json()['saved']
        # Simulate older requests arriving AFTER the final page-close request.
        assert send(first, 3, 'volume', volume=.25)
        assert not send(first, 1, 'volume', volume=.9)
        assert send(first, 2, 'compact', compact=True)
        assert send(second, 1, 'muted', muted=True)
        # A first queue save may arrive after all three small changes.
        response = client.put('/api/player-state',json={'clip_ids':['item'], 'current_id':'item'},
                              headers={'X-Farida-Preference-Writer':first})
        assert response.status_code == 200
        state = client.get('/api/player-state').json()
        assert (state['volume'], state['compact'], state['muted']) == (.25, True, True)
        snapshot = client.get('/api/backup').json()
        assert client.post('/api/restore',json=snapshot).status_code == 200
        assert not send(first, 4, 'volume', volume=.7)
        assert client.put('/api/player-state',json={},headers={'X-Farida-Preference-Writer':first}).status_code == 409
        assert send(writer(), 1, 'volume', volume=.7)
