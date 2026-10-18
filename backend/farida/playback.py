"""Account-authorized playback, streamed in memory through the local service."""
import asyncio
import hashlib
import re
import secrets
import time
from collections import OrderedDict
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask

from .adapter import BilibiliAdapter, UpstreamError
from .auth import USER_AGENT
from .session import SessionStore


def media_url(value):
    """Only accept HTTPS media hosts returned by Bilibili's playback API."""
    try:
        url = urlsplit(value)
        host = url.hostname or ''
        allowed = host.endswith(('.bilivideo.com', '.bilivideo.cn', '.bilivideo.net')) or host == 'upos-hz-mirrorakam.akamaized.net'
        if (not isinstance(value, str) or len(value) > 8192 or url.scheme != 'https'
                or not allowed or url.username or url.password or url.port
                or url.fragment or any(ord(c) < 33 or ord(c) > 126 for c in value)):
            raise ValueError()
        return value
    except (TypeError, ValueError, AttributeError):
        raise HTTPException(502, '哔哩哔哩返回了无法识别的播放地址，请打开原视频。') from None


class Playback:
    def __init__(self, settings, transport=None):
        self.settings, self.transport = settings, transport
        self.lock = asyncio.Lock()
        self.leases = OrderedDict()
        self.last_request = 0
        self.blocked_until = 0
        self.generation = 0

    def identity(self):
        cookie = SessionStore(self.settings).cookie_header()
        return hashlib.sha256(cookie.encode()).digest() if cookie else None

    async def clear(self):
        self.generation += 1
        self.leases.clear()

    async def prepare(self, clip):
        if not clip['playback_url']:
            raise HTTPException(409, '此视频或分 P 当前不可用，可以选择下一首或打开原视频。')
        async with self.lock:
            if time.monotonic() < self.blocked_until:
                raise HTTPException(429, '哔哩哔哩暂时限制了播放请求，请稍后重试。')
            identity = self.identity()
            if identity is None:
                raise HTTPException(401, '请先登录哔哩哔哩后播放。')
            adapter = BilibiliAdapter(self.settings, transport=self.transport)
            adapter.last_request = self.last_request
            try:
                data = await adapter.signed('/x/player/wbi/playurl', {
                    'bvid': clip['video_bvid'], 'cid': clip['cid'], 'qn': 64,
                    'fnval': 1, 'fnver': 0, 'platform': 'html5',
                })
            except UpstreamError as error:
                if error.category == 'restricted':
                    self.blocked_until = time.monotonic() + 60
                    raise HTTPException(429, '哔哩哔哩暂时限制了播放请求，已暂停队列，请稍后重试。') from None
                if error.category == 'authentication':
                    raise HTTPException(401, '哔哩哔哩登录已失效，请重新登录后播放。') from None
                if error.category == 'unavailable':
                    raise HTTPException(409, '此视频当前不可播放，可以选择下一首或打开原视频。') from None
                raise HTTPException(502, '暂时无法读取视频，请稍后重试或打开原视频。') from None
            finally:
                self.last_request = adapter.last_request
                await adapter.close()
            if not isinstance(data, dict) or data.get('is_preview') or data.get('is_drm'):
                raise HTTPException(409, '此视频需要在哔哩哔哩原网页中播放。')
            parts = data.get('durl')
            if not isinstance(parts, list) or not parts or len(parts) > 100 or not str(data.get('format', '')).startswith('mp4'):
                raise HTTPException(409, '此视频暂不支持页面内播放，请打开原视频。')
            # Validate the complete response before making any stream available.
            urls = [media_url(part.get('url')) if isinstance(part, dict) else media_url(None) for part in parts]
            expiry = time.monotonic() + 7200
            segments = []
            for part, url in zip(parts, urls):
                key = secrets.token_urlsafe(32)
                self.leases[key] = {'url': url, 'identity': identity, 'expires': expiry, 'generation': self.generation}
                segments.append({'url': '/api/playback/media/' + key})
            while len(self.leases) > 128:
                self.leases.popitem(last=False)
            return {'segments': segments, 'quality': data.get('quality'), 'original_url': clip['playback_url']}

    async def stream(self, key, byte_range=None):
        lease = self.leases.get(key)
        if not lease or lease['expires'] < time.monotonic() or lease['identity'] != self.identity():
            raise HTTPException(410, '播放地址已过期，请重试当前歌曲。')
        if byte_range and (len(byte_range) > 80 or not re.fullmatch(r'bytes=(?:\d+-\d*|-\d+)', byte_range)):
            raise HTTPException(416, '无效的视频读取范围。')
        headers = {'User-Agent': USER_AGENT, 'Referer': 'https://www.bilibili.com/', 'Accept-Encoding': 'identity'}
        if byte_range:
            headers['Range'] = byte_range
        # Signed CDN URLs authorize media reads; account cookies stay at api.bilibili.com.
        client = httpx.AsyncClient(timeout=httpx.Timeout(30, connect=15), follow_redirects=False, transport=self.transport)
        try:
            upstream = await client.send(client.build_request('GET', lease['url'], headers=headers), stream=True)
        except httpx.RequestError:
            await client.aclose()
            raise HTTPException(502, '视频连接失败，请重试或打开原视频。') from None

        async def close():
            await upstream.aclose()
            await client.aclose()

        if upstream.status_code not in {200, 206, 416}:
            await close()
            raise HTTPException(502, '哔哩哔哩暂时无法提供此视频，请重试或打开原视频。')
        response_headers = {'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes'}
        for name in ('content-length', 'content-range'):
            value = upstream.headers.get(name)
            if value:
                response_headers[name] = value
        if upstream.status_code == 416:
            await close()
            response_headers.pop('content-length', None)
            return Response(status_code=416, headers=response_headers)
        content_type = upstream.headers.get('content-type', '').split(';')[0].lower()
        if content_type not in {'video/mp4', 'application/octet-stream', 'binary/octet-stream'}:
            await close()
            raise HTTPException(502, '视频服务返回了异常内容，请打开原视频。')

        async def chunks():
            try:
                async for chunk in upstream.aiter_raw(128 * 1024):
                    if lease['generation'] != self.generation:
                        break
                    yield chunk
            finally:
                await close()

        return StreamingResponse(chunks(), status_code=upstream.status_code, media_type='video/mp4',
                                 headers=response_headers, background=BackgroundTask(close))
