import json
import os
import sqlite3
from copy import deepcopy
import pytest
from fastapi.testclient import TestClient
from farida.app import create_app
from farida.backup import export_backup, restore_backup


def test_backup_restore_roundtrip_and_recovery(db, source, video):
    db.save_video(source, video, [])
    clip = video['bvid'] + ':100'
    db.bookmark(clip, True)
    db.annotate([clip], {'notes':'personal note', 'display_song_title':'My song'})
    db.save_playlist('My list', [clip])
    backup = export_backup(db)
    assert 'sync_jobs' not in backup['tables']
    assert 'session' not in backup['tables']
    db.annotate([clip], {'notes':'new note'})
    db.bookmark(clip, False)
    filename = restore_backup(db, backup)
    assert db.clip(clip)['notes'] == 'personal note'
    assert db.clip(clip)['bookmarked'] == 1
    assert db.playlists()[0]['name'] == 'My list'
    recovery = json.loads((db.path.parent / 'backups' / filename).read_text(encoding='utf-8'))
    assert recovery['tables']['user_state'][0]['notes'] == 'new note'


def test_corrupt_restore_is_atomic(db, source, video):
    db.save_video(source, video, [])
    before = export_backup(db)
    bad = deepcopy(before)
    bad['tables']['parts'][0]['video_bvid'] = 'missing'
    with pytest.raises(Exception): restore_backup(db, bad)
    assert export_backup(db)['tables'] == before['tables']
    assert not (db.path.parent / 'backups').exists()


def test_backup_api_and_player_state(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db=client.app.state.db
        db.save_video(db.source(1), video, [])
        clip=video['bvid']+':100'
        assert client.post('/api/restore', json={}).status_code==403
        client.headers['X-Farida-Token']=client.get('/api/session').json()['token']
        state={'clip_ids':[clip], 'current_id':clip, 'name':'中文歌单', 'position':42.5, 'shuffle':True, 'repeat':'all'}
        assert client.put('/api/player-state',json=state).status_code==200
        saved=client.get('/api/player-state').json()
        assert saved['position']==42.5 and saved['items'][0]['id']==clip
        assert client.put('/api/player-state',json={**state,'position':-1}).status_code==422
        snapshot=client.get('/api/backup').json()
        assert client.post('/api/restore',json=snapshot).status_code==200
        assert client.get('/api/player-state').json()['repeat']=='all'
        snapshot['tables']['playback_state'][0]['value']='{}bad'
        assert client.post('/api/restore',json=snapshot).status_code==400
        assert client.get('/api/player-state').json()['position']==42.5


def test_backup_history_roundtrip_and_recovery(db, source, video):
    db.save_video(source, video, [])
    clip = video['bvid'] + ':100'
    original_time = '2026-10-22T12:00:00+00:00'
    db.execute('INSERT INTO listening_history(clip_id,last_played_at) VALUES(?,?)', (clip, original_time))
    snapshot = export_backup(db)
    assert snapshot['version'] == 2
    assert snapshot['tables']['listening_history'] == [{'clip_id': clip, 'last_played_at': original_time}]

    changed_time = '2026-10-22T13:00:00+00:00'
    db.execute('UPDATE listening_history SET last_played_at=?', (changed_time,))
    safety_name = restore_backup(db, snapshot)
    assert db.all('SELECT * FROM listening_history') == snapshot['tables']['listening_history']
    recovery = json.loads((db.path.parent / 'backups' / safety_name).read_text(encoding='utf-8'))
    assert recovery['tables']['listening_history'][0]['last_played_at'] == changed_time


def test_legacy_backup_clears_current_history_and_preserves_recovery(db, source, video):
    db.save_video(source, video, [])
    clip = video['bvid'] + ':100'
    snapshot = export_backup(db)
    snapshot['version'] = 1
    del snapshot['tables']['listening_history']
    db.execute('INSERT INTO listening_history(clip_id,last_played_at) VALUES(?,?)', (clip, '2026-10-22T12:00:00+00:00'))
    safety_name = restore_backup(db, snapshot)
    assert db.all('SELECT * FROM listening_history') == []
    assert db.clip(clip)
    recovery = json.loads((db.path.parent / 'backups' / safety_name).read_text(encoding='utf-8'))
    assert recovery['version'] == 2
    assert recovery['tables']['listening_history'][0]['clip_id'] == clip
    # Normalization must not mutate the user's supplied legacy document.
    assert snapshot['version'] == 1
    assert 'listening_history' not in snapshot['tables']


@pytest.mark.parametrize('bad_history', [
    [{'clip_id': 'missing:1', 'last_played_at': '2026-10-22T12:00:00+00:00'}],
    [{'clip_id': 'BV1br4y1R7BP:100', 'last_played_at': 'invalid timestamp'}],
    [{'clip_id': 'BV1br4y1R7BP:100', 'last_played_at': '2026-10-22T12:00:00'}],
    [{'clip_id': 'BV1br4y1R7BP:100', 'last_played_at': None}],
    [{'clip_id': 123, 'last_played_at': '2026-10-22T12:00:00+00:00'}],
    [{'clip_id': 'BV1br4y1R7BP:100'}],
    'invalid rows',
])
def test_invalid_history_restore_preserves_catalog(db, source, video, bad_history):
    db.save_video(source, video, [])
    clip = video['bvid'] + ':100'
    db.execute('INSERT INTO listening_history(clip_id,last_played_at) VALUES(?,?)', (clip, '2026-10-22T12:00:00+00:00'))
    before = export_backup(db)
    damaged = deepcopy(before)
    damaged['tables']['listening_history'] = bad_history
    with pytest.raises((ValueError, sqlite3.IntegrityError)):
        restore_backup(db, damaged)
    assert export_backup(db)['tables'] == before['tables']
    assert not (db.path.parent / 'backups').exists()


def test_manual_backups_exclude_credentials(db, source, video):
    secret = 'synthetic-login-secret-must-not-be-exported'
    auth_file = db.path.parent / 'bilibili-session.dat'
    auth_file.write_text(secret, encoding='utf-8')
    db.save_video(source, video, [])
    snapshot = export_backup(db)
    safety_name = restore_backup(db, snapshot)
    recovery = (db.path.parent / 'backups' / safety_name).read_text(encoding='utf-8')
    assert secret not in json.dumps(snapshot)
    assert secret not in recovery
    assert auth_file.read_text(encoding='utf-8') == secret
    assert 'sync_jobs' not in snapshot['tables']

def test_download_latest_automatic_recovery_is_local_and_read_only(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        folder = db.path.parent / "backups"
        url = "/api/backup/recovery"
        assert client.get(url, params={"check": True}).json() == {"available": False}
        assert client.get(url).status_code == 404
        assert not folder.exists()
        db.save_video(db.source(1), video, [])
        clip = video["bvid"] + ":100"
        db.annotate([clip], {"notes": "original"})
        initial = export_backup(db)
        db.annotate([clip], {"notes": "first recovery"})
        older = restore_backup(db, initial)
        db.annotate([clip], {"notes": "second recovery"})
        latest = restore_backup(db, initial)
        assert older != latest

        valid = (folder / latest).read_bytes()
        stamp = "before-restore-2099-01-01T00-00-00+00-00-"
        (folder / (stamp + "abc12345.tmp")).write_bytes(valid)
        (folder / (stamp + "abc12345.json")).write_bytes(valid[:-10])
        (folder / (stamp + "badshape.json")).write_bytes(b'{"unrelated": []}}')
        (folder / "before-restore-manual.json").write_bytes(valid)
        # A hard link with the right name must not expose another file.
        target = db.path.parent / "unrelated.json"
        target.write_bytes(valid)
        os.link(target, folder / (stamp + "hardlink.json"))
        (folder / (stamp + "isfolder.json")).mkdir()

        current = export_backup(db)["tables"]
        assert client.get(url, params={"check": True}).json() == {"available": True}
        assert client.get(url, headers={"Host": "untrusted.invalid"}).status_code == 400
        response = client.get(url, params={"filename": "unrelated.json"})
        assert response.status_code == 200 and response.content == valid
        assert response.headers["content-disposition"] == f"attachment; filename={latest}"
        assert response.headers["content-length"] == str(len(valid))
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["tables"]["user_state"][0]["notes"] == "second recovery"
        assert export_backup(db)["tables"] == current
        (folder / latest).unlink()
        assert client.get(url).content == (folder / older).read_bytes()
        (folder / older).unlink()
        assert client.get(url, params={"check": True}).json() == {"available": False}
        assert client.get(url).status_code == 404


def test_automatic_recovery_lookup_ignores_linked_folders(db):
    from farida.backup import open_latest_recovery

    name = restore_backup(db, export_backup(db))
    folder = db.path.parent / "backups"
    real = db.path.parent / "actual-backups"
    folder.rename(real)
    try:
        folder.symlink_to(real, target_is_directory=True)
    except OSError:
        # Windows allows normal users to create directory junctions even when
        # its developer-mode permission for symlink creation is disabled.
        if os.name != "nt":
            raise
        import subprocess
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
             "New-Item -ItemType Junction -Path $env:FARIDA_QA_LINK -Target $env:FARIDA_QA_TARGET | Out-Null"],
            env={**os.environ, "FARIDA_QA_LINK": str(folder), "FARIDA_QA_TARGET": str(real)},
            check=True, capture_output=True,
        )
        assert open_latest_recovery(folder) is None
        return
    assert open_latest_recovery(folder) is None
    folder.unlink()
    folder.mkdir()
    (folder / name).symlink_to(real / name)
    assert open_latest_recovery(folder) is None
