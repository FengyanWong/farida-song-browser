import httpx
import pytest

from farida.adapter import Page, UpstreamError
from farida.app import create_app
from farida.db import Database
from farida.session import SessionStore


def authenticated_app(settings, adapter):
    SessionStore(settings).save('SESSDATA=synthetic-startup-cookie', {'uid': '123', 'name': '测试账号'})
    def nav(request):
        assert request.url.path == '/x/web-interface/nav'
        assert 'synthetic-startup-cookie' in request.headers['cookie']
        return httpx.Response(200, json={'code': 0, 'data': {'isLogin': True, 'mid': 123, 'uname': '测试账号'}})
    return create_app(settings, adapter_factory=lambda _: adapter, auth_transport=httpx.MockTransport(nav))


class StartupAdapter:
    def __init__(self, restricted=False):
        self.restricted = restricted
        self.resolved = []
        self.listed = []
        self.closed = False

    async def resolve_source(self, source):
        self.resolved.append(source['id'])
        if self.restricted:
            raise UpstreamError('restricted', 'Synthetic restriction', code=-352)
        return {'uid': source['uid'], 'name': source['display_name'], 'method': 'test_fixture', 'songs': []}

    async def list_entries(self, source, page):
        self.listed.append((source['id'], page))
        return Page([], False, 0)

    async def close(self):
        self.closed = True


@pytest.mark.parametrize('disabled', [None, 1, 'all'])
async def test_startup_scans_enabled_sources_once_without_page_triggers(settings, disabled):
    db = Database(settings.db_path)
    db.initialize()
    db.add_source('Additional test uploader', '99887766')
    if disabled == 'all':
        db.execute('UPDATE sources SET enabled=0')
    elif disabled:
        db.update_source(disabled, {'enabled': False})
    enabled = [source['id'] for source in db.sources() if source['enabled']]
    adapter = StartupAdapter()
    app = authenticated_app(settings, adapter)
    async with app.router.lifespan_context(app):
        await app.state.startup_task
        worker = app.state.collector
        if enabled:
            # Startup returns while collection is still a background task.
            assert worker.task
            await worker.task
            job = db.jobs()[0]
            assert job['source_ids'] == enabled
            assert job['mode'] == 'incremental'
            assert job['state'] == 'completed'
            assert adapter.listed == [(sid, 1) for sid in enabled]
            assert adapter.closed
            assert all(source['last_complete_scan_at'] is None for source in db.sources())
        else:
            assert worker.task is None
            assert adapter.resolved == []
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://testserver') as client:
            # Simulate reloads and multiple tabs after the job has finished.
            for _ in range(3):
                for path in ['/', '/api/session', '/api/overview', '/api/clips']:
                    assert (await client.get(path)).status_code == 200
        assert len(db.jobs()) == (1 if enabled else 0)
        assert adapter.resolved == enabled


async def test_startup_restriction_stops_all_sources_and_is_not_retried_on_reload(settings):
    adapter = StartupAdapter(restricted=True)
    app = authenticated_app(settings, adapter)
    async with app.router.lifespan_context(app):
        await app.state.startup_task
        await app.state.collector.task
        db = app.state.db
        job = db.jobs()[0]
        assert job['state'] == 'paused'
        assert job['errors'][0]['upstream_code'] == -352
        assert adapter.resolved == [job['source_ids'][0]]
        assert adapter.listed == []
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://testserver') as client:
            await client.get('/')
            await client.get('/api/session')
            assert (await client.get('/api/overview')).json()['jobs'][0]['state'] == 'paused'
        assert len(db.jobs()) == 1
        assert adapter.resolved == [job['source_ids'][0]]


async def test_signed_out_startup_makes_no_upstream_requests_and_rejects_collect_and_resume(settings):
    adapter = StartupAdapter()
    def unexpected(request):
        raise AssertionError('No upstream request is allowed without credentials')
    app = create_app(settings, adapter_factory=lambda _: adapter, auth_transport=httpx.MockTransport(unexpected))
    async with app.router.lifespan_context(app):
        await app.state.startup_task
        assert app.state.collector.task is None
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://testserver') as client:
            client.headers['X-Farida-Token'] = (await client.get('/api/session')).json()['token']
            for _ in range(3):
                assert (await client.post('/api/auth/check')).json()['state'] == 'signed_out'
                assert (await client.post('/api/sync', json={})).status_code == 401
                assert (await client.post('/api/sync/old-job/resume')).status_code == 401
                assert (await client.get('/api/overview')).json()['jobs'] == []
        assert adapter.resolved == []


@pytest.mark.parametrize('response,state', [
    (httpx.Response(200, json={'code': -101}), 'expired'),
    (httpx.Response(412), 'unknown'),
])
async def test_invalid_or_unverifiable_saved_login_does_not_start_collection(settings,response,state):
    SessionStore(settings).save('SESSDATA=synthetic-cookie', {'uid': '123', 'name': '测试账号'})
    adapter = StartupAdapter()
    calls = []
    def nav(request):
        calls.append(request)
        return response
    app = create_app(settings, adapter_factory=lambda _: adapter, auth_transport=httpx.MockTransport(nav))
    async with app.router.lifespan_context(app):
        await app.state.startup_task
        assert app.state.login.status()['state'] == state
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://testserver') as client:
            client.headers['X-Farida-Token'] = (await client.get('/api/session')).json()['token']
            assert (await client.post('/api/sync', json={})).status_code == 401
            await client.post('/api/auth/check')
        assert len(calls) == 1
        assert not app.state.db.jobs() and not adapter.resolved


async def test_qr_login_releases_one_startup_scan_even_with_repeated_tab_polls(settings):
    from test_auth import LoginServer
    server = LoginServer()
    adapter = StartupAdapter()
    app = create_app(settings, adapter_factory=lambda _: adapter, auth_transport=httpx.MockTransport(server.handler))
    app.state.login.clock = server.clock
    async with app.router.lifespan_context(app):
        await app.state.startup_task
        assert not app.state.db.jobs() and not server.calls
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://testserver') as client:
            client.headers['X-Farida-Token'] = (await client.get('/api/session')).json()['token']
            qr = (await client.post('/api/auth/qr')).json()
            server.time += 3
            for _ in range(3):
                response = await client.post(f"/api/auth/qr/{qr['id']}/poll")
                assert response.json()['state'] == 'authenticated'
                await client.post('/api/auth/check')
                await client.get('/api/overview')
            await app.state.collector.task
        jobs = app.state.db.jobs()
        assert len(jobs) == 1 and jobs[0]['state'] == 'completed'
        assert jobs[0]['source_ids'] == [1,2,3,4,5,6]
        assert adapter.resolved == [1,2,3,4,5,6]


async def test_expired_login_blocks_manual_scan_after_previous_success(settings):
    from test_auth import LoginServer, COOKIE, ACCOUNT
    SessionStore(settings).save(COOKIE, ACCOUNT)
    server = LoginServer()
    adapter = StartupAdapter()
    app = create_app(settings, adapter_factory=lambda _: adapter, scan_on_start=False, auth_transport=httpx.MockTransport(server.handler))
    app.state.login.clock = server.clock
    async with app.router.lifespan_context(app):
        await app.state.startup_task
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://testserver') as client:
            client.headers['X-Farida-Token'] = (await client.get('/api/session')).json()['token']
            assert (await client.post('/api/sync', json={'source_ids':[1]})).status_code == 202
            await app.state.collector.task
            server.time += 31
            server.nav = httpx.Response(200, json={'code': -101})
            assert (await client.post('/api/sync', json={'source_ids':[2]})).status_code == 401
        assert len(app.state.db.jobs()) == 1 and adapter.resolved == [1]
