import json

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from farida.app import create_app
from farida.playback import Playback, media_url
from farida.session import SessionStore


MEDIA = 'https://upos-hz-mirrorakam.akamaized.net/video.mp4?signature=example'
NAV = {'isLogin': True, 'mid': 123, 'uname': '测试账号',
       'wbi_img': {'img_url': 'https://i0.hdslb.com/' + 'a' * 32 + '.png',
                   'sub_url': 'https://i0.hdslb.com/' + 'b' * 32 + '.png'}}


class MediaBytes(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b'video'


def login(settings):
    SessionStore(settings).save('SESSDATA=offline-test; DedeUserID=123', {'uid': '123', 'name': '测试账号'})


def handler(request):
    if request.url.host == 'api.bilibili.com':
        assert 'SESSDATA=offline-test' in request.headers['cookie']
        if request.url.path.endswith('/nav'):
            return httpx.Response(200, json={'code': 0, 'data': NAV})
        assert request.url.params['cid'] == '200'
        assert request.url.params['bvid'] == 'BV1br4y1R7BP'
        assert request.url.params['w_rid']
        return httpx.Response(200, json={'code': 0, 'data': {'format': 'mp4720', 'quality': 64, 'durl': [{'url': MEDIA}]}})
    assert 'cookie' not in request.headers
    assert request.headers['range'] == 'bytes=0-4'
    return httpx.Response(206, headers={'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-4/10', 'Content-Length': '5'}, stream=MediaBytes())


def test_logged_playback_seeking_and_logout(settings, video):
    login(settings)
    transport = httpx.MockTransport(handler)
    app = create_app(settings, scan_on_start=False, auth_transport=transport, playback_transport=transport)
    with TestClient(app) as client:
        db = app.state.db
        db.save_video(db.source(1), video, [])
        endpoint = '/api/clips/' + video['bvid'] + ':200/play'
        assert client.post(endpoint).status_code == 403
        client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
        assert client.post('/api/auth/check').json()['state'] == 'connected'
        response = client.post(endpoint)
        assert response.status_code == 200
        data = response.json()
        assert 'offline-test' not in response.text and 'akamaized' not in response.text
        media = data['segments'][0]['url']
        assert client.get(media, headers={'Sec-Fetch-Site': 'cross-site'}).status_code == 403
        assert client.get(media, headers={'Range': 'bytes=0-4,6-9'}).status_code == 416
        stream = client.get(media, headers={'Range': 'bytes=0-4'})
        assert stream.status_code == 206 and stream.content == b'video'
        assert stream.headers['content-range'] == 'bytes 0-4/10'
        assert stream.headers['cache-control'] == 'no-store'
        client.post('/api/auth/logout')
        assert client.get(media).status_code == 410
        assert client.post(endpoint).status_code == 401


@pytest.mark.parametrize('url', [
    'http://upos-sz.bilivideo.com/video.mp4', 'https://evil.example/video.mp4',
    'https://evilbilivideo.com/video.mp4', 'https://upos.bilivideo.com.evil.example/video.mp4',
    'https://user:pass@upos.bilivideo.com/video.mp4', 'https://upos.bilivideo.com:8443/video.mp4',
    'https://127.0.0.1/video.mp4', 'https://another.akamaized.net/video.mp4', None,
])
def test_untrusted_media_addresses_are_rejected(url):
    with pytest.raises(HTTPException):
        media_url(url)


async def test_access_restriction_stops_requests_without_retrying(settings):
    login(settings)
    requests = []
    def restricted(request):
        requests.append(str(request.url.path))
        if request.url.path.endswith('/nav'):
            return httpx.Response(200, json={'code': 0, 'data': NAV})
        return httpx.Response(200, json={'code': -352, 'message': 'restricted'})
    playback = Playback(settings, httpx.MockTransport(restricted))
    clip = {'video_bvid': 'BV1br4y1R7BP', 'cid': '200', 'playback_url': 'https://www.bilibili.com/video/BV1br4y1R7BP/?p=2'}
    for _ in range(2):
        with pytest.raises(HTTPException) as exc:
            await playback.prepare(clip)
        assert exc.value.status_code == 429
    assert requests == ['/x/web-interface/nav', '/x/player/wbi/playurl']
    assert not playback.leases


@pytest.mark.parametrize('data', [
    {'format': 'dash', 'dash': {}},
    {'format': 'mp4720', 'durl': [{'url': MEDIA}], 'is_preview': True},
    {'format': 'mp4720', 'durl': [{'url': MEDIA}, {'url': 'https://evil.example/'}]},
])
async def test_unsupported_and_incomplete_responses_do_not_create_streams(settings, data):
    login(settings)
    def response(request):
        return httpx.Response(200, json={'code': 0, 'data': NAV if request.url.path.endswith('/nav') else data})
    playback = Playback(settings, httpx.MockTransport(response))
    with pytest.raises(HTTPException):
        await playback.prepare({'video_bvid': 'BV1br4y1R7BP', 'cid': '200', 'playback_url': 'https://www.bilibili.com/'})
    assert not playback.leases


def test_preview_and_signed_out_never_request_playback(settings):
    for preview in (True, False):
        app = create_app(settings, scan_on_start=False, preview_mode=preview)
        with TestClient(app) as client:
            client.headers['X-Farida-Token'] = client.get('/api/session').json()['token']
            assert client.post('/api/clips/anything/play').status_code == (409 if preview else 401)
