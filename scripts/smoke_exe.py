"""Check the built EXE with isolated data, no Python on PATH, and no credentials."""
import argparse
import csv
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from farida import __version__


@contextmanager
def offline_proxy():
    destinations = []

    class DenyTunnel(BaseHTTPRequestHandler):
        def do_CONNECT(self):
            destinations.append(self.path)
            self.send_error(403)

        def log_message(self, format, *args):
            pass

    with HTTPServer(("127.0.0.1", 0), DenyTunnel) as proxy:
        worker = Thread(target=proxy.serve_forever)
        worker.start()
        try:
            yield f"http://127.0.0.1:{proxy.server_port}", destinations
        finally:
            proxy.shutdown()
            worker.join()


def main(proxy_url, destinations):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    args = parser.parse_args()
    binary = args.executable.read_bytes()
    pe_offset = struct.unpack_from('<I', binary, 0x3c)[0]
    assert binary[pe_offset:pe_offset + 4] == b'PE\0\0'
    assert struct.unpack_from('<H', binary, pe_offset + 24 + 68)[0] == 2, 'EXE must use the Windows GUI subsystem'
    expected = json.loads((ROOT / "data/catalog.json").read_text(encoding="utf-8"))["counts"]
    output = ROOT / ".local" / "exe-smoke"
    output.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="运行测试-", dir=output))
    program = workspace / "独立程序"
    program.mkdir()
    executable = program / "法里达.exe"
    shutil.copy2(args.executable, executable)
    data = workspace / "用户数据"
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    environment = os.environ.copy()
    for key in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "FARIDA_COOKIE_FILE", "FARIDA_DATA_DIR"):
        environment.pop(key, None)
    # Exercise the embedded TLS setup with the bundled CA files. The proxy
    # records only tunnel destinations and never connects to the internet.
    for key in ("SSL_CERT_FILE", "SSL_CERT_DIR"):
        environment.pop(key, None)
    environment.update(HTTP_PROXY=proxy_url, HTTPS_PROXY=proxy_url, ALL_PROXY=proxy_url,
                       NO_PROXY="localhost,127.0.0.1,::1")
    windows = Path(environment.get("SYSTEMROOT", "C:/Windows"))
    environment["SYSTEMROOT"] = str(windows)
    environment["WINDIR"] = str(windows)
    environment["PATH"] = str(windows / "System32")
    checks = ['EXE uses the Windows GUI subsystem (no console window)']

    def cleanup_process_tree(process):
        # A one-file PyInstaller EXE runs the Python application in a child.
        # Keep the parent alive until taskkill can identify its descendants.
        if process.poll() is None:
            taskkill = windows / "System32" / "taskkill.exe"
            subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                           capture_output=True, timeout=15, check=False)
        process.wait(timeout=15)

    local = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, body=None, method=None):
        headers = {}
        if body is not None:
            headers = {"Content-Type": "application/json", "X-Farida-Token": request.token}
            body = json.dumps(body).encode()
        with local.open(urllib.request.Request(base + path, data=body, headers=headers, method=method), timeout=10) as response:
            raw = response.read()
            return json.loads(raw) if "application/json" in response.headers.get("Content-Type", "") else raw

    request.token = ""
    for run in (1, 2):
        with (workspace / f"run-{run}.log").open("wb") as log:
            process = subprocess.Popen([str(executable), "--no-browser", "--no-startup-scan", "--port", str(port),
                                        "--data-dir", str(data)], cwd=program, env=environment, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 60
                while True:
                    if process.poll() is not None:
                        raise RuntimeError(f"EXE exited with {process.returncode}; see {workspace}")
                    try:
                        health = request("/api/health")
                        break
                    except (OSError, urllib.error.URLError):
                        if time.monotonic() > deadline:
                            raise RuntimeError(f"EXE did not start; see {workspace}")
                        time.sleep(0.25)
                assert health["version"] == __version__
                overview = request("/api/overview")
                assert overview["entries"] == expected["active_clips"]
                assert overview["included"] == expected["included_clips"]
                assert overview["jobs"] == []
                session = request("/api/session")
                request.token = session["token"]
                assert session["can_shutdown"] is True
                auth = request("/api/auth")
                assert auth["state"] == "signed_out" and auth["account"] is None
                html = request("/").decode("utf-8")
                assert "法里达" in html and 'id="page-subtitle"' not in html
                assert len(request("/assets/frida.webp")) > 100_000
                assert b"height:60px" in request("/style.css")
                all_rows = list(csv.DictReader(io.StringIO(request("/api/export?status=all").decode("utf-8-sig"))))
                assert len(all_rows) == expected["active_clips"]
                assert any(row["songlist_attribution"] == "CLANNADOR" for row in all_rows)
                clip = request("/api/clips?page_size=1")["items"][0]
                if run == 1:
                    assert overview["bookmarked"] == 0
                    assert clip["playback_url"].startswith("https://www.bilibili.com/video/BV")
                    try:
                        request("/api/sync", {})
                    except urllib.error.HTTPError as error:
                        assert error.code == 401
                    else:
                        raise AssertionError("A fresh install must require login before collection")
                    try:
                        request("/api/auth/qr", {}, method="POST")
                    except urllib.error.HTTPError as error:
                        assert error.code == 400, "QR login did not handle the offline proxy refusal"
                    else:
                        raise AssertionError("The offline proxy must deny the QR login tunnel")
                    assert destinations == ["passport.bilibili.com:443"], destinations
                    checks.append("Packaged QR login initializes its HTTPS client and reaches the loopback proxy")
                    # Only this isolated test catalog is changed.
                    request(f"/api/clips/{clip['id']}/bookmark", {"bookmarked": True}, method="PATCH")
                    checks += ["Standalone EXE starts without Python on PATH", "Chinese executable and data paths work",
                               "Bundled UI, covers layout, and Frida load", "Full public catalog and attribution are present",
                               "No inherited login, bookmarks, or jobs", "Signed-out collection is blocked"]
                    second = subprocess.Popen([str(executable), '--no-browser', '--port', str(port), '--data-dir', str(data)],
                                              cwd=program, env=environment, stdout=log, stderr=log)
                    try:
                        assert second.wait(timeout=20) == 0 and process.poll() is None
                    finally:
                        cleanup_process_tree(second)
                    assert request('/api/session')['token'] == request.token
                    checks.append('Launching again reuses the running service without replacing it')
                else:
                    assert overview["bookmarked"] == 1
                    assert clip["bookmarked"] == 1
                    checks.append("Restart preserves the existing catalog and bookmark without reseeding")
                assert request('/api/shutdown', {}, method='POST') == {'status': 'stopping'}
                assert process.wait(timeout=20) == 0
                checks.append(f'Run {run}: quit endpoint gracefully stops the EXE while signed out')
            finally:
                cleanup_process_tree(process)
    diagnostic = (data / 'launcher.log').read_text(encoding='utf-8')
    assert '法里达' in diagnostic and 'Traceback' not in diagnostic
    checks.append('Windowless output is retained in a UTF-8 local log')
    report = {"checks": checks, "catalog": expected, "executable_bytes": args.executable.stat().st_size}
    (output / "results.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    with offline_proxy() as (proxy_url, destinations):
        main(proxy_url, destinations)
