import asyncio
import json
import threading
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from farida.app import create_app
from farida.lifetime import WindowLifetime


async def test_last_window_closes_only_after_refresh_grace():
    stopped = asyncio.Event()
    lifetime = WindowLifetime(stopped.set, grace_seconds=.1)
    first, second = AsyncMock(), AsyncMock()
    assert lifetime.connect(first) and lifetime.connect(second)
    lifetime.disconnect(first)
    await asyncio.sleep(.15)
    assert not stopped.is_set()
    lifetime.disconnect(second)
    # A reload replaces the document's connection during the grace period.
    refreshed = AsyncMock()
    assert lifetime.connect(refreshed)
    await asyncio.sleep(.15)
    assert not stopped.is_set()
    lifetime.disconnect(refreshed)
    assert not stopped.is_set()
    await asyncio.wait_for(stopped.wait(), 1)
    assert not lifetime.connect(AsyncMock())
    for window in (first, second, refreshed):
        window.assert_not_awaited()
    await lifetime.close()


async def test_browser_start_timeout_and_headless_launch():
    stopped = asyncio.Event()
    lifetime = WindowLifetime(stopped.set, startup_timeout=.03)
    lifetime.start()
    await asyncio.wait_for(stopped.wait(), 1)
    await lifetime.close()

    stopped.clear()
    headless = WindowLifetime(stopped.set)
    headless.start()
    await asyncio.sleep(.08)
    assert not stopped.is_set()
    await headless.close()


async def test_connect_cancels_start_timeout_and_cleanup_cancels_exit():
    calls = []
    lifetime = WindowLifetime(lambda: calls.append(True), grace_seconds=.03, startup_timeout=.03)
    lifetime.start()
    window = AsyncMock()
    assert lifetime.connect(window)
    await asyncio.sleep(.08)
    assert calls == []
    lifetime.disconnect(window)
    await lifetime.close()
    await asyncio.sleep(.08)
    assert calls == []


async def test_manual_exit_is_once_even_with_open_windows():
    calls = []
    lifetime = WindowLifetime(lambda: calls.append(True), grace_seconds=.01)
    window = AsyncMock()
    assert lifetime.connect(window)
    await lifetime.shutdown()
    window.assert_awaited_once_with("stopping")
    lifetime.disconnect(window)
    await lifetime.shutdown()
    await asyncio.sleep(.03)
    assert calls == [True]
    await lifetime.close()


async def test_quit_shares_a_deadline_and_attempts_every_open_window():
    events = []
    release = asyncio.Event()
    entered = asyncio.Event()
    finished = asyncio.Event()
    lifetime = WindowLifetime(lambda: events.append('shutdown'))

    async def slow(state):
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            # Even a transport that is slow to cancel cannot hold up exit.
            await release.wait()
        finally:
            finished.set()

    async def disconnected(state):
        raise OSError('window closed')

    async def responsive(state):
        events.append(state)

    for window in (slow, disconnected, responsive):
        assert lifetime.connect(window)
    quit_task = asyncio.create_task(lifetime.shutdown())
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert not lifetime.connect(AsyncMock())
        await lifetime.shutdown()
        await asyncio.wait_for(asyncio.shield(quit_task), 2)
        assert events == ['stopping', 'shutdown']
        assert not finished.is_set()
    finally:
        release.set()
        await quit_task
        await asyncio.wait_for(finished.wait(), 1)
        await lifetime.close()


def test_explicit_quit_notifies_authenticated_windows_before_shutdown(settings):
    delivered = []
    at_shutdown = []
    app = create_app(settings, scan_on_start=False,
                     shutdown_callback=lambda: at_shutdown.append(sorted(delivered)))

    async def record_frames(scope, receive, send):
        if scope['type'] != 'websocket':
            return await app(scope, receive, send)

        async def record(message):
            await send(message)
            if message['type'] == 'websocket.send' and json.loads(message['text']) == {'state': 'stopping'}:
                delivered.append(scope['query_string'])

        await app(scope, receive, record)

    origin = {'Origin': 'http://testserver'}
    with TestClient(record_frames) as client:
        token = client.get('/api/session').json()['token']
        with client.websocket_connect('/api/window?first', headers=origin) as first:
            first.send_json({'token': token})
            assert first.receive_json() == {'state': 'connected'}
            with client.websocket_connect('/api/window?second', headers=origin) as second:
                second.send_json({'token': token})
                assert second.receive_json() == {'state': 'connected'}
                with client.websocket_connect('/api/window?opening', headers=origin) as opening:
                    response = client.post('/api/shutdown', headers={'X-Farida-Token': token})
                    assert response.json() == {'status': 'stopping'}
                    assert at_shutdown == [[b'first', b'second']]
                    assert first.receive_json() == second.receive_json() == {'state': 'stopping'}
                    # An accepted socket authenticating after quit sees the terminal state first.
                    opening.send_json({'token': token})
                    assert opening.receive_json() == {'state': 'stopping'}
                    with pytest.raises(WebSocketDisconnect) as stopped:
                        opening.receive_json()
                    assert stopped.value.code == 1001
                with client.websocket_connect('/api/window?invalid', headers=origin) as invalid:
                    invalid.send_json({'token': 'wrong'})
                    with pytest.raises(WebSocketDisconnect) as denied:
                        invalid.receive_json()
                    assert denied.value.code == 1008
        assert sorted(delivered) == [b'first', b'opening', b'second']
        assert len(at_shutdown) == 1


def test_authenticated_window_connection_works_before_bilibili_login(settings):
    stopped = threading.Event()
    app = create_app(settings, scan_on_start=False, shutdown_callback=stopped.set, window_grace_seconds=.1)
    with TestClient(app) as client:
        session = client.get('/api/session').json()
        assert session['close_with_page'] is True
        assert client.get('/api/auth').json()['state'] == 'signed_out'
        with client.websocket_connect('/api/window', headers={'Origin': 'http://testserver'}) as first:
            first.send_json({'token': session['token']})
            assert first.receive_json() == {'state': 'connected'}
            with client.websocket_connect('/api/window', headers={'Origin': 'http://testserver'}) as second:
                second.send_json({'token': session['token']})
                assert second.receive_json() == {'state': 'connected'}
            assert not stopped.wait(.15)
        assert stopped.wait(1)


@pytest.mark.parametrize('origin,hello', [
    ('https://evil.example', {'token': 'correct'}),
    ('', {'token': 'correct'}),
    ('http://testserver', {'token': 'wrong'}),
    ('http://testserver', {'token': '非 ASCII'}),
    ('http://testserver', []),
])
def test_foreign_or_invalid_connections_cannot_control_lifetime(settings, origin, hello):
    stopped = threading.Event()
    app = create_app(settings, scan_on_start=False, shutdown_callback=stopped.set, window_grace_seconds=.02)
    with TestClient(app) as client:
        if isinstance(hello, dict) and hello.get('token') == 'correct':
            hello = {'token': client.get('/api/session').json()['token']}
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/api/window', headers={'Origin': origin}) as socket:
                socket.send_json(hello)
                socket.receive_json()
        assert not stopped.wait(.05)


def test_preview_does_not_enable_window_tracking(settings):
    app = create_app(settings, scan_on_start=False, preview_mode=True, shutdown_callback=lambda: None)
    with TestClient(app) as client:
        assert client.get('/api/session').json()['close_with_page'] is False
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/api/window', headers={'Origin': 'http://testserver'}):
                pass
