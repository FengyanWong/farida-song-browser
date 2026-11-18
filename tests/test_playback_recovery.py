import time

import httpx
import pytest
from fastapi import HTTPException

from farida.adapter import BilibiliAdapter, UpstreamError
from farida.playback import Playback


CLIP = {'video_bvid': 'BV1br4y1R7BP', 'cid': '200', 'playback_url': 'https://www.bilibili.com/video/BV1br4y1R7BP/'}
MEDIA = 'https://upos-hz-mirrorakam.akamaized.net/video.mp4'


def player(settings, monkeypatch, transport=None):
    result = Playback(settings, transport)
    monkeypatch.setattr(result, 'identity', lambda: b'local-test')
    return result


@pytest.mark.parametrize(('category', 'status', 'expected'), [
    ('authentication', 401, 'authentication'), ('restricted', 429, 'restricted'),
    ('retry_later', 429, 'restricted'), ('unavailable', 409, 'unavailable'),
    ('network', 502, 'network'), ('server', 502, 'network'), ('schema', 502, 'upstream'),
])
async def test_lookup_failures_are_classified_without_automatic_backend_retries(settings, monkeypatch, category, status, expected):
    requests = []
    async def fail(*args):
        requests.append(True)
        raise UpstreamError(category, 'test failure')
    monkeypatch.setattr(BilibiliAdapter, 'signed', fail)
    playback = player(settings, monkeypatch)
    with pytest.raises(HTTPException) as caught:
        await playback.prepare(CLIP)
    assert caught.value.status_code == status
    assert caught.value.headers['X-Farida-Error'] == expected
    assert len(requests) == 1
    if expected == 'restricted':
        with pytest.raises(HTTPException) as caught:
            await playback.prepare(CLIP)
        assert caught.value.headers['X-Farida-Error'] == 'restricted'
        assert len(requests) == 1


@pytest.mark.parametrize('payload', [
    {'format': 'dash', 'dash': {}},
    {'format': 'mp4720', 'durl': [{'url': MEDIA}], 'is_preview': True},
])
async def test_unsupported_media_can_be_skipped_without_being_treated_as_login_or_network(settings, monkeypatch, payload):
    async def response(*args):
        return payload
    monkeypatch.setattr(BilibiliAdapter, 'signed', response)
    playback = player(settings, monkeypatch)
    with pytest.raises(HTTPException) as caught:
        await playback.prepare(CLIP)
    assert caught.value.headers['X-Farida-Error'] == 'unsupported'
    assert not playback.leases


@pytest.mark.parametrize(('status', 'category'), [(429, 'restricted'), (403, 'network'), (404, 'network'), (500, 'network')])
async def test_media_failure_status_is_local_and_cdn_restrictions_stop_new_requests(settings, monkeypatch, status, category):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(status)
    playback = player(settings, monkeypatch, httpx.MockTransport(handler))
    playback.leases['test'] = {'url': MEDIA, 'identity': b'local-test', 'expires': time.monotonic()+60, 'generation': 0}
    with pytest.raises(HTTPException) as caught:
        await playback.stream('test')
    assert caught.value.headers['X-Farida-Error'] == category
    assert playback.failure_status('test')['category'] == category
    assert playback.failure_status('test')['category'] == category
    assert len(requests) == 1
    if category == 'restricted':
        with pytest.raises(HTTPException) as caught:
            await playback.prepare(CLIP)
        assert caught.value.status_code == 429
        with pytest.raises(HTTPException) as caught:
            await playback.stream('test')
        assert caught.value.headers['X-Farida-Error'] == 'restricted'
        assert len(requests) == 1


async def test_media_status_distinguishes_missing_lease_from_account_change(settings, monkeypatch):
    playback = player(settings, monkeypatch)
    assert playback.failure_status('missing')['category'] == 'network'
    playback.leases['test'] = {'url': MEDIA, 'identity': b'old-account', 'expires': time.monotonic()+60, 'generation': 0}
    assert playback.failure_status('test')['category'] == 'authentication'
    with pytest.raises(HTTPException) as caught:
        await playback.stream('test')
    assert caught.value.headers['X-Farida-Error'] == 'authentication'


def test_expired_media_refreshes_but_signed_out_media_pauses(settings, monkeypatch):
    playback = player(settings, monkeypatch)
    playback.leases['expired'] = {'url': MEDIA, 'identity': b'local-test', 'expires': time.monotonic()-1, 'generation': 0}
    assert playback.failure_status('expired')['category'] == 'network'
    monkeypatch.setattr(playback, 'identity', lambda: None)
    assert playback.failure_status('missing')['category'] == 'authentication'
    assert playback.failure_status('expired')['category'] == 'authentication'


@pytest.mark.parametrize('payload', [{}, {'format': 'mp4720'}, {'format': 'mp4720', 'durl': []}])
async def test_malformed_metadata_pauses_instead_of_skipping_a_video(settings, monkeypatch, payload):
    async def response(*args):
        return payload
    monkeypatch.setattr(BilibiliAdapter, 'signed', response)
    playback = player(settings, monkeypatch)
    with pytest.raises(HTTPException) as caught:
        await playback.prepare(CLIP)
    assert caught.value.headers['X-Farida-Error'] == 'upstream'
