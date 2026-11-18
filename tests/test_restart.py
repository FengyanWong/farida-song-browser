import importlib.util
import json
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
