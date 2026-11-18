import importlib.util
import json
import pytest
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading
import time
from pathlib import Path

spec=importlib.util.spec_from_file_location('launcher',Path(__file__).resolve().parents[1]/'run.py')
launcher=importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def test_restart_waits_for_previous_lock(tmp_path):
    first=launcher.acquire_catalog_lock(tmp_path,lambda:False)
    def release():
        time.sleep(.4)
        first.close()
    thread=threading.Thread(target=release);thread.start()
    started=time.monotonic()
    second=launcher.acquire_catalog_lock(tmp_path,lambda:False,timeout=3)
    assert time.monotonic()-started>=.3
    second.close();thread.join()


def test_second_launch_reuses_healthy_server(tmp_path):
    first=launcher.acquire_catalog_lock(tmp_path,lambda:False)
    try: assert launcher.acquire_catalog_lock(tmp_path,lambda:True,timeout=1) is None
    finally:first.close()


def test_local_health_probe_works_without_proxy_or_certificate_files(tmp_path, monkeypatch):
    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == "/api/health"
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps(self.server.status).encode())

        def log_message(self, *args):
            pass

    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "")
    monkeypatch.setenv("SSL_CERT_FILE", str(tmp_path / "missing.pem"))
    with HTTPServer(("127.0.0.1", 0), HealthHandler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_port
            for status, expected in [
                ({"application": "farida-song-browser", "status": "ok"}, True),
                ({"application": "farida-song-browser", "status": "stopping"}, False),
                ({"application": "another-app", "status": "ok"}, False),
            ]:
                server.status = status
                assert launcher.healthy(port) is expected
        finally:
            server.shutdown()
            thread.join()


def test_remembered_port_must_be_a_local_port_number(tmp_path):
    path = tmp_path / "ui-port.txt"
    assert launcher.read_port(path) is None
    for text in ("", "8765/path", "80", "99999"):
        path.write_text(text, encoding="utf-8")
        assert launcher.read_port(path) is None
    path.write_text("8767", encoding="utf-8")
    assert launcher.read_port(path) == 8767


def test_reserved_port_is_held_until_the_server_takes_over():
    import socket

    with launcher.bind_ui_socket(0, allow_fallback=False) as first:
        port = first.getsockname()[1]
        with launcher.bind_ui_socket(port, allow_fallback=True) as second:
            assert second.getsockname()[1] != port
            with socket.socket() as client:
                client.settimeout(1)
                client.connect(("127.0.0.1", port))
            with pytest.raises(OSError):
                launcher.bind_ui_socket(port, allow_fallback=False)


def test_launch_remembers_its_reserved_port_even_at_the_end_of_the_port_range(tmp_path, monkeypatch):
    import socket
    import sys
    import uvicorn
    from farida import catalog_snapshot

    # Simulate the last numbered port being occupied without depending on whether
    # a Windows service or another test currently owns that particular port.
    real_bind = launcher.bind_ui_socket
    chosen = []

    def reserve_last(preferred, *, allow_fallback):
        assert preferred == 65535 and allow_fallback
        chosen.append(real_bind(taken.getsockname()[1], allow_fallback=True))
        return chosen[-1]

    def run_on_reserved_socket(self, sockets=None):
        assert sockets == chosen
        address = sockets[0].getsockname()
        assert self.config.port == address[1] == launcher.read_port(tmp_path / "ui-port.txt")
        assert address[0] == "127.0.0.1"
        with socket.create_connection(address, timeout=1):
            pass

    monkeypatch.setattr(sys, "argv", ["run.py", "--data-dir", str(tmp_path), "--no-browser"])
    monkeypatch.setattr(uvicorn.Server, "run", run_on_reserved_socket)
    monkeypatch.setattr(catalog_snapshot, "seed_new_catalog", lambda *args: False)
    monkeypatch.setattr(launcher, "bind_ui_socket", reserve_last)
    (tmp_path / "ui-port.txt").write_text("65535", encoding="utf-8")
    with real_bind(0, allow_fallback=False) as taken:
        assert launcher.main() == 0
    assert chosen[0].fileno() == -1
