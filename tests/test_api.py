from fastapi.testclient import TestClient

from farida.app import create_app


def client_app(settings,video=None):
    opened=[]
    app=create_app(settings,browser_opener=lambda url:opened.append(url) or True,scan_on_start=False)
    return app,opened


def authorize(client):
    client.headers['X-Farida-Token']=client.get('/api/session').json()['token']


def test_local_ui_defaults_and_csrf(settings):
    app,_=client_app(settings)
    with TestClient(app) as client:
        assert client.get('/').status_code==200
        assert 'color-scheme' in client.get('/').text
        assert client.get('/api/overview').json()['entries']==0
        assert client.get('/api/session').json()['preview_mode'] is False
        assert client.post('/api/sync',json={}).status_code==403
        authorize(client)
        assert client.post('/api/sources',json={'url':'123'},headers={'Origin':'https://evil.example'}).status_code==403
        assert client.get('/api/overview',headers={'Host':'evil.example'}).status_code==400
        assert client.get('/api/clips?page_size=10000').status_code==400
        assert client.get('/api/clips?after=2024-02-01&before=2024-01-01').status_code==400


def test_real_target_opening_and_export(settings,video):
    app,opened=client_app(settings)
    with TestClient(app) as client:
        authorize(client)
        db=app.state.db;source=db.source(1);db.save_video(source,video,[])
        rows=client.get('/api/clips').json()['items']
        target=next(row for row in rows if row['part_number']==2)
        assert target['thumbnail_url']==video['pic']
        result=client.post('/api/clips/'+target['id']+'/open')
        assert result.json()['opened']
        assert opened==['https://www.bilibili.com/video/BV1br4y1R7BP/?p=2']
        assert client.post('/api/clips/https%3A%2F%2Fevil.example/open').status_code in {404,405}
        assert len(opened)==1
        client.patch('/api/clips/'+target['id']+'/bookmark',json={'bookmarked':True})
        assert len(client.get('/api/export?format=json&bookmarked=true').json())==1
        assert '夜に駆ける' in client.get('/api/export').text
        assert client.get('/api/clips/'+target['id']).json()['statistics']['favorite'] is None


def test_long_share_reference_selects_the_requested_part_everywhere(settings, video):
    import csv
    import io

    app, _ = client_app(settings)
    with TestClient(app) as client:
        db = app.state.db
        db.save_video(db.source(1), video, [])
        prefix = f'https://www.bilibili.com/video/{video["bvid"]}/?share='
        long_url = prefix + "x" * 580 + "&p=2"
        suffix = "】 " + long_url
        at_limit = "【" + "🎵" * (2047 - len(suffix)) + suffix
        assert len(at_limit) == 2048

        for endpoint, params in (("/api/clips", {}), ("/api/clips", {"grouped": True}),
                                 ("/api/play-queue", {}), ("/api/export", {"format": "json"}),
                                 ("/api/export", {"format": "csv"})):
            for query in (long_url, "【歌曲】 " + long_url, at_limit):
                reply = client.get(endpoint, params={**params, "q": query})
                assert reply.status_code == 200, reply.text
                if params.get("format") == "csv":
                    rows = list(csv.DictReader(io.StringIO(reply.content.decode("utf-8-sig"))))
                else:
                    payload = reply.json()
                    rows = payload if isinstance(payload, list) else payload["items"]
                assert [int(row["part_number"]) for row in rows] == [2]

            for query, message in ((at_limit.replace("【", "【a", 1), "2,048"), ("字"*501, "500"),
                                   (long_url + "&p=1", "有效"), (long_url.replace("bilibili.com", "example.com"), "有效")):
                reply = client.get(endpoint, params={**params, "q": query})
                assert reply.status_code == 400 and message in reply.json()["detail"]
            assert client.get(endpoint, params={**params, "q": "字"*500}).status_code == 200


def test_local_upload_day_matches_catalog_groups_queue_and_exports(settings, video):
    from datetime import datetime

    app, _ = client_app(settings)
    with TestClient(app) as client:
        db = app.state.db
        source = db.source(1)
        # In Shanghai these uploads straddle midnight between March 1 and 2.
        timestamps = ("2026-03-01T15:59:59Z", "2026-03-01T16:00:00Z",
                      "2026-03-02T15:59:59Z", "2026-03-02T16:00:00Z")
        ids = [f"BV{n:010d}" for n in range(4)]
        for bvid, stamp in zip(ids, timestamps):
            db.save_video(source, {**video, "bvid": bvid,
                                   "pubdate": int(datetime.fromisoformat(stamp).timestamp())}, [])
        day = {"after": "2026-03-02T00:00:00+08:00", "before": "2026-03-02T23:59:59+08:00"}
        for path, options in (("/api/clips", {}), ("/api/clips", {"grouped": True}),
                              ("/api/play-queue", {}), ("/api/export", {"format": "json"})):
            reply = client.get(path, params={**day, **options})
            assert reply.status_code == 200, reply.text
            result = reply.json()
            items = result if isinstance(result, list) else result["items"]
            assert {item["id"].split(":")[0] for item in items} == set(ids[1:3])
        exported = client.get("/api/export", params=day).text
        assert all((bvid in exported) == (bvid in ids[1:3]) for bvid in ids)
        legacy = client.get("/api/clips", params={"after": "2026-03-02", "before": "2026-03-02"}).json()
        assert {item["video_bvid"] for item in legacy["items"]} == set(ids[2:])
        assert client.get("/api/clips", params={"after":"2026-03-03", "before":day["before"]}).status_code == 400


def test_source_settings_and_unknown_fields(settings):
    app,_=client_app(settings)
    with TestClient(app) as client:
        authorize(client)
        source=client.post('/api/sources',json={'display_name':'new','url':'123'}).json()
        assert source['verification_status']=='pending'
        assert client.patch('/api/sources/'+str(source['id']),json={'enabled':False}).json()['enabled']==0
        assert client.patch('/api/sources/'+str(source['id']),json={'verified_uid':'1'}).status_code==422
        assert client.post('/api/sources',json={'url':'123'}).status_code==409
        assert client.post('/api/sources',json={'url':'http://127.0.0.1/secret'}).status_code==400


def test_csv_formula_safety_and_raw_data_preserved(settings,video):
    app,_=client_app(settings)
    with TestClient(app) as client:
        authorize(client);db=app.state.db;db.save_video(db.source(1),video,[])
        identity=video['bvid']+':100'
        client.patch('/api/clips/'+identity+'/annotation',json={'display_song_title':'=1+1'})
        assert "'=1+1" in client.get('/api/export').text
        assert client.get('/api/clips/'+identity).json()['display_song_title']=='=1+1'


def test_bulk_validation_is_atomic(settings,video):
    app,_=client_app(settings)
    with TestClient(app) as client:
        authorize(client);db=app.state.db;db.save_video(db.source(1),video,[])
        result=client.patch('/api/review/bulk',json={'ids':[video['bvid']+':100','missing'],'inclusion_status':'excluded'})
        assert result.status_code==404
        assert db.clips()['total']==2


def test_shutdown_requires_local_token_but_not_bilibili_login(settings):
    stopped = []
    app = create_app(settings, scan_on_start=False, shutdown_callback=lambda: stopped.append(True))
    with TestClient(app) as client:
        assert client.get('/api/session').json()['can_shutdown'] is True
        assert client.get('/api/auth').json()['state'] == 'signed_out'
        assert client.post('/api/shutdown').status_code == 403
        authorize(client)
        assert client.post('/api/shutdown', headers={'Origin': 'https://evil.example'}).status_code == 403
        assert stopped == []
        response = client.post('/api/shutdown')
        assert response.status_code == 200 and response.json() == {'status': 'stopping'}
        assert stopped == [True]


def test_shutdown_unavailable_in_preview_or_without_launcher(settings):
    stopped = []
    for options in ({}, {'preview_mode': True, 'shutdown_callback': lambda: stopped.append(True)}):
        with TestClient(create_app(settings, scan_on_start=False, **options)) as client:
            assert client.get('/api/session').json()['can_shutdown'] is False
            authorize(client)
            assert client.post('/api/shutdown').status_code == 409
    assert stopped == []
