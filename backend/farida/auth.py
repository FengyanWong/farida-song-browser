"""Bilibili's user-confirmed QR login. No password entry or browser-cookie extraction."""
import asyncio
import math
import re
import secrets
import time
from http.cookies import SimpleCookie, CookieError
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx
import segno

from .session import SessionError, SessionStore, validate_cookie

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
NAV = 'https://api.bilibili.com/x/web-interface/nav'
COOKIE_NAMES = {'SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4', 'b_nut', 'bili_ticket', 'bili_ticket_expires'}
TERMINAL = {'authenticated', 'saved', 'expired', 'failed', 'cancelled'}


class LoginError(ValueError):
    pass


class LoginIdentityError(LoginError):
    pass


def checked_url(value, *, qr=False):
    try:
        if not isinstance(value, str) or any(ord(c) < 33 or ord(c) > 126 for c in value):
            raise ValueError('invalid login URL')
        url = urlsplit(value)
        allowed = (url.hostname, url.path) in {
            ('passport.bilibili.com', '/h5-app/passport/login/scan'),
            ('account.bilibili.com', '/h5/account-h5/auth/scan-web'),
        } if qr else (
            url.hostname in {'passport.bilibili.com', 'passport.biligame.com'} and url.path in {'/x/passport-login/web/crossDomain', '/crossDomain'}
            or url.hostname == 'www.bilibili.com' and url.path in {'', '/'})
        if not isinstance(value, str) or len(value) > 8192 or url.scheme != 'https' or url.username or url.password or url.port or not allowed:
            raise ValueError('unexpected login URL')
        return url
    except (ValueError, TypeError, AttributeError):
        raise LoginError('哔哩哔哩返回了无法识别的登录地址，已停止登录。') from None


def cookie_value(value):
    value = validate_cookie(value)
    if not value or re.search(r'[;\s"\\]', value):
        raise SessionError('登录凭据格式异常，请重新扫码。')
    return value


def response_cookies(response):
    result = {}
    for header in response.headers.get_list('set-cookie'):
        parsed = SimpleCookie()
        try:
            parsed.load(header)
            for name, value in parsed.items():
                if name in COOKIE_NAMES and value.value:
                    result[name] = cookie_value(value.value)
        except (CookieError, SessionError):
            raise LoginError('登录凭据格式异常，请重新扫码。') from None
    return result


class BilibiliLogin:
    def __init__(self, settings, *, transport=None, before_change=None, clock=time.monotonic, poll_interval=3.0):
        self.settings, self.transport = settings, transport
        self.store = SessionStore(settings)
        self.before_change = before_change
        self.clock, self.poll_interval = clock, poll_interval
        self.lock = asyncio.Lock()
        self.pending = None
        self.last_start = float('-inf')
        self.last_check = float('-inf')
        try:
            record = self.store.load()
            self.account = {'state': 'saved' if record['cookie'] else 'signed_out', 'stored': bool(record['cookie']), 'account': record.get('account'), 'message': ''}
        except SessionError as exc:
            self.account = {'state': 'unavailable', 'stored': True, 'account': None, 'message': str(exc)}

    def client(self, cookie=''):
        headers = {'User-Agent': USER_AGENT, 'Referer': 'https://www.bilibili.com/'}
        if cookie:
            headers['Cookie'] = validate_cookie(cookie)
        return httpx.AsyncClient(headers=headers, timeout=self.settings.request_timeout,
                                 follow_redirects=False, transport=self.transport)

    def status(self):
        return dict(self.account)

    async def request(self, client, url, params=None, *, redirects=False):
        try:
            response = await client.get(url, params=params)
        except httpx.RequestError:
            raise LoginError('暂时无法连接哔哩哔哩，请稍后重试。') from None
        if response.status_code in {401, 403, 412, 429}:
            raise LoginError(f'哔哩哔哩暂时限制登录请求（HTTP {response.status_code}），请稍后再试。')
        if response.status_code != 200 and not (redirects and response.is_redirect):
            raise LoginError('哔哩哔哩登录服务暂时不可用，请稍后再试。')
        return response

    @staticmethod
    def payload(response, *, allow_logged_out=False):
        try:
            payload = response.json()
            code = payload['code']
            if allow_logged_out and code == -101:
                return {'isLogin': False}
            if code != 0:
                suffix = f'（{code}）' if type(code) is int else ''
                raise LoginError(f'哔哩哔哩未接受登录请求{suffix}，请稍后重试。')
            if not isinstance(payload['data'], dict):
                raise ValueError('missing data')
            return payload['data']
        except LoginError:
            raise
        except (ValueError, TypeError, KeyError):
            raise LoginError('哔哩哔哩登录响应格式有变化，请稍后重试。') from None

    def attempt_result(self, include_image=False):
        pending = self.pending
        result = {'id': pending['id'], 'state': pending['state'], 'expires_in': max(0, math.ceil(pending['expires'] - self.clock())), 'poll_after_ms': max(3000, math.ceil(self.poll_interval * 1000)), 'message': pending.get('message', '')}
        if include_image and pending.get('image'):
            result['qr_image'] = pending['image']
        if pending['state'] in {'authenticated', 'saved'}:
            result['auth'] = self.status()
        return result

    async def discard_client(self):
        if self.pending and self.pending.get('client'):
            await self.pending['client'].aclose()
            self.pending['client'] = None
        if self.pending:
            self.pending['key'] = None
            self.pending['image'] = None

    async def start(self):
        async with self.lock:
            if self.pending and self.pending['state'] not in TERMINAL and self.clock() < self.pending['expires']:
                return self.attempt_result(include_image=True)
            if self.clock() - self.last_start < 5:
                raise LoginError('请稍候几秒，再刷新登录二维码。')
            self.last_start = self.clock()
            await self.discard_client()
            client = self.client()
            try:
                data = self.payload(await self.request(client, GENERATE))
                key = data.get('qrcode_key')
                if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', key):
                    raise LoginError('哔哩哔哩没有返回有效二维码，请稍后重试。')
                url = checked_url(data.get('url'), qr=True)
                if parse_qs(url.query).get('qrcode_key') != [key]:
                    raise LoginError('登录二维码信息不一致，请重新获取。')
                image = segno.make(data['url'], micro=False, error='m').png_data_uri(scale=5, border=4)
            except Exception:
                await client.aclose()
                raise
            self.pending = {'id': secrets.token_urlsafe(24), 'key': key, 'image': image, 'client': client,
                            'state': 'waiting', 'expires': self.clock() + 180, 'next_poll': self.clock() + self.poll_interval}
            return self.attempt_result(include_image=True)

    async def credentials(self, client, response, data):
        cookies = {cookie.name: cookie_value(cookie.value) for cookie in client.cookies.jar if cookie.name in COOKIE_NAMES and not cookie.is_expired()}
        cookies.update(response_cookies(response))
        url = data.get('url')
        if url:
            parsed = checked_url(url)
            query = parse_qs(parsed.query)
            for name in COOKIE_NAMES:
                if query.get(name):
                    cookies.setdefault(name, cookie_value(query[name][0]))
        # The current login flow may issue a one-use crossDomain ticket instead of
        # putting credentials in the poll response. Only follow these fixed hosts.
        for _ in range(4):
            if cookies.get('SESSDATA') and cookies.get('bili_jct') and re.fullmatch(r'[1-9][0-9]{0,19}', cookies.get('DedeUserID', '')):
                return validate_cookie('; '.join(f'{name}={value}' for name, value in cookies.items())), {'uid': cookies['DedeUserID'], 'name': ''}
            if not url:
                break
            checked_url(url)
            result = await self.request(client, url, redirects=True)
            cookies.update(response_cookies(result))
            url = urljoin(url, result.headers['location']) if result.is_redirect and result.headers.get('location') else None
        raise LoginError('已确认扫码，但没有收到完整登录信息，请重新扫码。')

    async def verify_cookie(self, cookie, account):
        async with self.client(cookie) as client:
            data = self.payload(await self.request(client, NAV), allow_logged_out=True)
        if data.get('isLogin') is False:
            return {'state': 'expired', 'stored': True, 'account': account, 'message': '登录已失效，请重新扫码登录。'}
        if data.get('isLogin') is not True:
            raise LoginError('无法核对登录状态，请稍后检查。')
        uid, name = str(data.get('mid', '')), data.get('uname')
        if not re.fullmatch(r'[1-9][0-9]{0,19}', uid) or not isinstance(name, str) or not name:
            raise LoginError('无法核对登录账号，请重新检查登录状态。')
        if account and account['uid'] != uid:
            raise LoginIdentityError('登录账号信息不一致，请重新扫码。')
        return {'state': 'connected', 'stored': True, 'account': {'uid': uid, 'name': name[:120]}, 'message': ''}

    async def poll(self, attempt_id):
        async with self.lock:
            if not self.pending or not secrets.compare_digest(self.pending['id'], attempt_id):
                raise LoginError('此二维码已关闭，请重新扫码登录。')
            pending = self.pending
            if pending['state'] in TERMINAL:
                return self.attempt_result()
            if self.clock() >= pending['expires']:
                pending['state'] = 'expired'
                await self.discard_client()
                return self.attempt_result()
            if self.clock() < pending['next_poll']:
                return self.attempt_result()
            pending['next_poll'] = self.clock() + self.poll_interval
            try:
                response = await self.request(pending['client'], POLL, {'qrcode_key': pending['key']})
                data = self.payload(response)
                code = data.get('code')
                if code in {86101, 86090, 86038}:
                    pending['state'] = {86101: 'waiting', 86090: 'scanned', 86038: 'expired'}[code]
                    if code == 86038:
                        await self.discard_client()
                elif code == 0:
                    cookie, account = await self.credentials(pending['client'], response, data)
                    try:
                        status = await self.verify_cookie(cookie, account)
                    except LoginIdentityError:
                        raise
                    except LoginError:
                        status = {'state': 'saved', 'stored': True, 'account': account, 'message': '登录信息已保存，暂时无法验证状态。请检查登录，验证成功后再采集。'}
                    if status['state'] == 'expired':
                        raise LoginError('登录验证未通过，请重新扫码登录。')
                    if self.before_change:
                        await self.before_change()
                    self.store.save(cookie, status['account'])
                    self.account = status
                    self.last_check = self.clock()
                    pending['state'] = 'authenticated' if status['state'] == 'connected' else 'saved'
                    await self.discard_client()
                else:
                    raise LoginError('登录未完成，请重新获取二维码。')
            except (LoginError, SessionError) as exc:
                pending['state'], pending['message'] = 'failed', str(exc)
                await self.discard_client()
            return self.attempt_result()

    async def check(self):
        async with self.lock:
            return await self.check_locked()

    async def check_locked(self):
        """Check while the caller holds lock, so starting a job cannot race logout."""
        if self.clock() - self.last_check < 30:
            return self.status()
        self.last_check = self.clock()
        try:
            record = self.store.load()
        except SessionError as exc:
            self.account = {'state': 'unavailable', 'stored': True, 'account': None, 'message': str(exc)}
            return self.status()
        if not record['cookie']:
            self.account = {'state': 'signed_out', 'stored': False, 'account': None, 'message': ''}
        else:
            try:
                self.account = await self.verify_cookie(record['cookie'], record.get('account'))
            except LoginError as exc:
                self.account = {'state': 'unknown', 'stored': True, 'account': record.get('account'), 'message': str(exc)}
        return self.status()

    async def cancel(self, attempt_id):
        async with self.lock:
            if self.pending and secrets.compare_digest(self.pending['id'], attempt_id) and self.pending['state'] not in TERMINAL:
                self.pending['state'] = 'cancelled'
                await self.discard_client()
            return {'cancelled': True}

    async def logout(self):
        async with self.lock:
            if self.before_change:
                await self.before_change()
            await self.discard_client()
            self.pending = None
            self.store.clear()
            self.account = {'state': 'signed_out', 'stored': False, 'account': None, 'message': ''}
            self.last_check = float('-inf')
            return self.status()

    async def close(self):
        async with self.lock:
            await self.discard_client()
