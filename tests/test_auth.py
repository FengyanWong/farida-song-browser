import json
import os
from urllib.parse import urlencode

import httpx
import pytest
from fastapi.testclient import TestClient

from farida.adapter import BilibiliAdapter, UpstreamError
from farida.app import create_app
from farida.auth import BilibiliLogin, LoginError, checked_url
from farida.session import SessionError, SessionStore

KEY = 'synthetic-qr-key-1234567890'
SECRET = 'synthetic-session-secret'
CSRF = 'synthetic-csrf-secret'
TICKET = 'synthetic-one-use-ticket'
COOKIE = f'SESSDATA={SECRET}; bili_jct={CSRF}; DedeUserID=123'
ACCOUNT = {'uid': '123', 'name': '测试账号'}


def envelope(data):
    return httpx.Response(200, json={'code': 0, 'data': data})


class LoginServer:
    def __init__(self, flow='ticket', codes=None, nav=None):
        self.flow, self.codes, self.nav = flow, list(codes or [0]), nav
        self.calls = []
        self.time = 100

    def clock(self):
        return self.time

    def handler(self, request):
        self.calls.append(request)
        path = request.url.path
        if path.endswith('/generate'):
            return envelope({'url': f'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key={KEY}', 'qrcode_key': KEY})
        if path.endswith('/poll'):
            assert request.url.params['qrcode_key'] == KEY
            code = self.codes.pop(0)
            if code:
                return envelope({'code': code})
            if self.flow == 'ticket':
                return envelope({'code': 0, 'url': f'https://passport.biligame.com/x/passport-login/web/crossDomain?ticket={TICKET}'})
            if self.flow == 'query':
                return envelope({'code': 0, 'url': 'https://passport.bilibili.com/crossDomain?' + urlencode({'SESSDATA': SECRET, 'bili_jct': CSRF, 'DedeUserID': '123'})})
            if self.flow == 'headers':
                return httpx.Response(200, json={'code': 0, 'data': {'code': 0}}, headers=self.cookie_headers())
        if path.endswith('/crossDomain'):
            assert request.url.host == 'passport.biligame.com'
            assert request.url.params['ticket'] == TICKET
            # Real current flow can set .bilibili.com cookies on a biligame
            # response: the standard cookie jar rejects the domain mismatch.
            return httpx.Response(302, headers=[('Location', 'https://www.bilibili.com/'), *self.cookie_headers()])
        if path.endswith('/nav'):
            assert SECRET in request.headers['cookie']
            return self.nav if self.nav is not None else envelope({'isLogin': True, 'mid': 123, 'uname': ACCOUNT['name']})
        raise AssertionError(f'Unexpected fixed login route: {path}')

    @staticmethod
    def cookie_headers():
        return [('Set-Cookie', f'{key}={value}; Domain=.bilibili.com; Path=/; Secure; HttpOnly') for key, value in {'SESSDATA': SECRET, 'bili_jct': CSRF, 'DedeUserID': '123', 'unrelated': 'not-saved'}.items()]

    def login(self, settings, **kwargs):
        return BilibiliLogin(settings, transport=httpx.MockTransport(self.handler), clock=self.clock, **kwargs)

    async def poll(self, login, attempt):
        self.time += 3
        return await login.poll(attempt['id'])


def assert_no_secrets(value):
    text = json.dumps(value, ensure_ascii=False)
    assert all(secret not in text for secret in [SECRET, CSRF, TICKET, KEY, 'refresh_token'])


@pytest.mark.parametrize('flow', ['ticket', 'query', 'headers'])
async def test_confirmed_login_saved_private_and_reused_by_collector(settings, flow):
    server = LoginServer(flow)
    changes = []
    async def before_change():
        changes.append(True)
        assert not SessionStore(settings).cookie_header()
    login = server.login(settings, before_change=before_change)
    qr = await login.start()
    assert qr['qr_image'].startswith('data:image/png;base64,')
    assert_no_secrets(qr)
    result = await server.poll(login, qr)
    assert result['state'] == 'authenticated' and result['auth']['account'] == ACCOUNT
    assert changes == [True]
    assert_no_secrets(result)
    assert_no_secrets(login.status())
    assert login.pending['client'] is None and login.pending['key'] is None
    assert not login.pending['image']
    count = len(server.calls)
    assert await login.poll(qr['id']) == result
    assert len(server.calls) == count
    record = SessionStore(settings).load()
    assert SECRET in record['cookie'] and 'unrelated' not in record['cookie']
    raw = login.store.path.read_bytes()
    if os.name == 'nt':
        assert raw.startswith(b'FARIDA-DPAPI-1\n') and SECRET.encode() not in raw
    else:
        assert login.store.path.stat().st_mode & 0o777 == 0o600
    restarted = server.login(settings)
    assert restarted.status()['state'] == 'saved' and restarted.status()['account'] == ACCOUNT
    captured = []
    def collect(request):
        captured.append(request.headers.get('cookie', ''))
        return envelope([])
    adapter = BilibiliAdapter(settings, transport=httpx.MockTransport(collect))
    await adapter.get_video_tags('BV1br4y1R7BP')
    assert SECRET in captured[0]
    await adapter.close()
    await login.close()
    await restarted.close()


async def test_waiting_scanned_throttling_and_expiration(settings):
    server = LoginServer(codes=[86101, 86090, 86038])
    login = server.login(settings)
    qr = await login.start()
    assert (await login.start())['id'] == qr['id']
    for _ in range(5):
        assert (await login.poll(qr['id']))['state'] == 'waiting'
    assert len(server.calls) == 1
    for state in ['waiting', 'scanned', 'expired']:
        assert (await server.poll(login, qr))['state'] == state
    assert len(server.calls) == 4
    assert not login.store.path.exists()
    assert login.pending['client'] is None
    assert (await login.poll(qr['id']))['state'] == 'expired'
    assert len(server.calls) == 4
    await login.close()


async def test_local_expiry_and_old_cancel_does_not_cancel_new_qr(settings):
    server = LoginServer()
    login = server.login(settings)
    first = await login.start()
    server.time += 181
    assert (await login.poll(first['id']))['state'] == 'expired'
    assert len(server.calls) == 1
    second = await login.start()
    await login.cancel(first['id'])
    assert (await login.start())['id'] == second['id']
    await login.cancel(second['id'])
    with pytest.raises(LoginError, match='稍候'):
        await login.start()
    assert (await login.poll(second['id']))['state'] == 'cancelled'
    assert not login.store.path.exists()
    await login.close()


@pytest.mark.parametrize('url', [
    'https://evil.example/crossDomain?ticket=x',
    'https://passport.biligame.com.evil.example/crossDomain',
    'https://user@passport.bilibili.com/crossDomain',
    'http://passport.bilibili.com/crossDomain',
    'https://passport.bilibili.com:8443/crossDomain',
    'https://passport.bilibili.com/arbitrary',
    'https://passport.bilibili.com/\ncrossDomain',
    None, {}, 123,
])
def test_login_completion_url_is_fixed_and_validated(url):
    with pytest.raises(LoginError):
        checked_url(url)


@pytest.mark.parametrize('url', [
    'https://passport.bilibili.com/h5-app/passport/login/scan',
    'https://account.bilibili.com/h5/account-h5/auth/scan-web',
])
def test_old_and_current_official_qr_scan_routes(url):
    assert checked_url(url + '?qrcode_key=' + KEY, qr=True).scheme == 'https'


@pytest.mark.parametrize('url', [
    'https://account.bilibili.com.evil.example/h5/account-h5/auth/scan-web',
    'https://account.bilibili.com/arbitrary',
    'http://account.bilibili.com/h5/account-h5/auth/scan-web',
])
def test_qr_route_stays_restricted_to_official_https_paths(url):
    with pytest.raises(LoginError):
        checked_url(url + '?qrcode_key=' + KEY, qr=True)


async def test_untrusted_ticket_redirect_is_not_followed(settings):
    server = LoginServer()
    def handler(request):
        if request.url.path.endswith('/crossDomain'):
            server.calls.append(request)
            return httpx.Response(302, headers={'location': 'https://evil.example/?ticket=secret'})
        return server.handler(request)
    login = BilibiliLogin(settings, transport=httpx.MockTransport(handler), clock=server.clock)
    result = await server.poll(login, await login.start())
    assert result['state'] == 'failed'
    assert all(request.url.host != 'evil.example' for request in server.calls)
    assert not login.store.path.exists()
    assert 'secret' not in result['message']
    await login.close()


@pytest.mark.parametrize('nav,state,persisted', [
    (httpx.Response(200, json={'code': -101, 'data': {}}), 'failed', False),
    (envelope({'isLogin': True, 'mid': 999, 'uname': '不同账号'}), 'failed', False),
    (httpx.Response(412), 'saved', True),
])
async def test_login_verification_failures_do_not_mislabel_connected(settings, nav, state, persisted):
    server = LoginServer(nav=nav)
    login = server.login(settings)
    result = await server.poll(login, await login.start())
    assert result['state'] == state
    assert login.store.path.exists() is persisted
    assert login.status()['state'] != 'connected'
    assert_no_secrets(result)
    await login.close()


async def test_login_restriction_stops_without_retry_or_secret_in_error(settings):
    server = LoginServer()
    def handler(request):
        if request.url.path.endswith('/poll'):
            server.calls.append(request)
            return httpx.Response(429, text=SECRET, headers={'Set-Cookie': f'SESSDATA={SECRET}'})
        return server.handler(request)
    login = BilibiliLogin(settings, transport=httpx.MockTransport(handler), clock=server.clock)
    qr = await login.start()
    result = await server.poll(login, qr)
    assert result['state'] == 'failed' and '429' in result['message']
    await login.poll(qr['id'])
    assert len(server.calls) == 2 and not login.store.path.exists()
    assert_no_secrets(result)
    await login.close()


async def test_cookie_separator_injection_is_rejected(settings):
    server = LoginServer()
    def handler(request):
        if request.url.path.endswith('/poll'):
            return envelope({'code': 0, 'url': 'https://passport.bilibili.com/crossDomain?' + urlencode({'SESSDATA': SECRET + '; injected=1', 'bili_jct': CSRF, 'DedeUserID': '123'})})
        return server.handler(request)
    login = BilibiliLogin(settings, transport=httpx.MockTransport(handler), clock=server.clock)
    result = await server.poll(login, await login.start())
    assert result['state'] == 'failed' and not login.store.path.exists()
    assert_no_secrets(result)
    await login.close()


async def test_check_throttled_and_logout_disables_legacy_without_deleting_it(settings):
    settings.cookie_file = settings.data_dir / 'legacy.txt'
    settings.cookie_file.write_text(COOKIE)
    server = LoginServer()
    changes = []
    async def stop():
        changes.append(True)
    login = server.login(settings, before_change=stop)
    assert login.status()['stored']
    assert (await login.check())['state'] == 'connected'
    await login.check()
    assert len(server.calls) == 1
    server.time += 31
    server.nav = httpx.Response(200, json={'code': -101})
    assert (await login.check())['state'] == 'expired'
    assert (await login.logout())['state'] == 'signed_out'
    assert changes == [True]
    assert settings.cookie_file.read_text() == COOKIE
    assert SessionStore(settings).cookie_header() == ''
    assert SECRET.encode() not in login.store.path.read_bytes()
    assert server.login(settings).status()['state'] == 'signed_out'
    await login.close()


async def test_saved_session_read_can_be_retried_immediately_without_extra_requests(settings, monkeypatch):
    store = SessionStore(settings)
    store.save(COOKIE, ACCOUNT)
    original = store.path.read_bytes()
    read_bytes = type(store.path).read_bytes
    def temporarily_locked(path):
        if path == store.path:
            raise PermissionError("synthetic sharing violation")
        return read_bytes(path)

    server = LoginServer()
    with monkeypatch.context() as patch:
        patch.setattr(type(store.path), "read_bytes", temporarily_locked)
        login = server.login(settings)
        assert login.status()["state"] == "unavailable"
        for _ in range(2):
            status = await login.check()
            assert status["state"] == "unavailable" and status["stored"]
        assert not server.calls
    # The test clock hasn't advanced. Reading succeeds as soon as the file unlocks.
    assert (await login.check())["state"] == "connected"
    assert (await login.check())["state"] == "connected"
    assert [request.url.path for request in server.calls] == ["/x/web-interface/nav"]
    assert store.path.read_bytes() == original
    await login.close()


def test_corrupt_session_is_reported_without_contents(settings):
    store = SessionStore(settings)
    store.path.write_bytes(SECRET.encode())
    with pytest.raises(SessionError) as exc:
        store.load()
    assert SECRET not in str(exc.value)
    assert BilibiliLogin(settings).status()['state'] == 'unavailable'
    store.clear()
    assert store.cookie_header() == ''


def test_auth_api_csrf_preview_guard_and_public_status(settings):
    server = LoginServer()
    app = create_app(settings, scan_on_start=False, auth_transport=httpx.MockTransport(server.handler))
    app.state.login.clock = server.clock
    with TestClient(app) as client:
        assert client.get('/api/auth').json()['state'] == 'signed_out'
        assert client.post('/api/auth/qr').status_code == 403
        token = client.get('/api/session').json()['token']
        client.headers['X-Farida-Token'] = token
        assert client.post('/api/auth/qr', headers={'Origin': 'https://evil.example'}).status_code == 403
        assert not server.calls
        qr = client.post('/api/auth/qr').json()
        server.time += 3
        response = client.post(f"/api/auth/qr/{qr['id']}/poll")
        assert response.status_code == 200 and response.json()['state'] == 'authenticated'
        assert response.headers['cache-control'] == 'no-store'
        assert_no_secrets(response.json())
        assert_no_secrets(client.get('/api/auth').json())
        assert client.post('/api/auth/logout').json()['state'] == 'signed_out'
        assert SessionStore(settings).cookie_header() == ''
    preview = create_app(settings, scan_on_start=False, preview_mode=True, auth_transport=httpx.MockTransport(server.handler))
    with TestClient(preview) as client:
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        assert client.get('/api/auth').json()['state'] == 'preview'
        count = len(server.calls)
        for path in ['/qr', '/check', '/logout', '/qr/fake/poll', '/qr/fake/cancel']:
            assert client.post('/api/auth' + path).status_code == 409
        assert len(server.calls) == count


@pytest.mark.parametrize('status,code', [(401, None), (200, -101)])
async def test_expired_credentials_stop_collector_without_retries(settings, status, code):
    SessionStore(settings).save(COOKIE, ACCOUNT)
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, json={'code': code})
    adapter = BilibiliAdapter(settings, transport=httpx.MockTransport(handler))
    with pytest.raises(UpstreamError) as error:
        await adapter.get_video_tags('BV1br4y1R7BP')
    assert error.value.category == 'authentication' and len(calls) == 1
    await adapter.close()
