import asyncio
import threading

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from farida.app import create_app
from farida.lifetime import WindowLifetime


async def test_last_window_closes_only_after_refresh_grace():
    stopped = asyncio.Event()
    lifetime = WindowLifetime(stopped.set, grace_seconds=.1)
    first, second = lifetime.connect(), lifetime.connect()
    lifetime.disconnect(first)
    await asyncio.sleep(.15)
    assert not stopped.is_set()
    lifetime.disconnect(second)
    # A reload replaces the document's connection during the grace period.
    refreshed = lifetime.connect()
    await asyncio.sleep(.15)
    assert not stopped.is_set()
    lifetime.disconnect(refreshed)
    assert not stopped.is_set()
    await asyncio.wait_for(stopped.wait(), 1)
    assert lifetime.connect() is None
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
    window = lifetime.connect()
    await asyncio.sleep(.08)
    assert calls == []
    lifetime.disconnect(window)
    await lifetime.close()
    await asyncio.sleep(.08)
    assert calls == []


async def test_manual_exit_is_once_even_with_open_windows():
    calls = []
    lifetime = WindowLifetime(lambda: calls.append(True), grace_seconds=.01)
    window = lifetime.connect()
    await lifetime.shutdown()
    lifetime.disconnect(window)
    await lifetime.shutdown()
    await asyncio.sleep(.03)
    assert calls == [True]
    await lifetime.close()


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
