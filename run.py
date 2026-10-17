"""Start the local collector and open its UI in the system default browser."""
import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))

from farida import __version__


def healthy(url):
    try:
        with urllib.request.urlopen(url + "/api/health",timeout=1) as response:
            return json.load(response).get("application") == "farida-song-browser"
    except (OSError,ValueError,urllib.error.URLError):
        return False


def open_when_ready(url):
    for _ in range(100):
        if healthy(url):
            webbrowser.open_new_tab(url)
            return
        time.sleep(0.1)


def port_available(port):
    with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as probe:
        try:
            if os.name == 'nt':
                probe.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
            probe.bind(('127.0.0.1',port))
            return True
        except OSError:
            return False


def main():
    # The standalone launcher must also print Chinese when its output is
    # redirected on an English-language Windows installation.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=f"法里达 · 歌切收藏 {__version__}")
    parser.add_argument("--port",type=int,default=None)
    parser.add_argument("--no-browser",action="store_true")
    parser.add_argument("--no-startup-scan",action="store_true",help="Skip the automatic scan for this process (for maintenance or manual resume)")
    parser.add_argument("--data-dir",type=Path)
    args = parser.parse_args()
    if args.port is not None and not 1024 <= args.port <= 65535:
        parser.error("Use a port between 1024 and 65535")
    try:
        import uvicorn
        from farida.app import create_app
        from farida.config import Settings
        from farida.catalog_snapshot import seed_new_catalog
        from farida.resources import resource_root
    except ImportError:
        print("Dependencies are not installed. Run Start Farida.cmd, or: python -m pip install -r requirements.txt")
        return 1
    settings = Settings.from_env()
    if args.data_dir:
        settings.data_dir=args.data_dir.resolve()
    settings.data_dir.mkdir(parents=True,exist_ok=True)
    remembered_port=settings.data_dir/'ui-port.txt'
    try:
        preferred=int(remembered_port.read_text(encoding='utf-8').strip())
        if not 1024<=preferred<=65535:preferred=8765
    except (OSError,ValueError):
        preferred=8765
    port=args.port if args.port is not None else preferred
    url = f"http://127.0.0.1:{port}"
    if healthy(url):
        print(f"Farida is already running: {url}")
        if not args.no_browser:
            webbrowser.open_new_tab(url)
        return 0
    if not port_available(port):
        if args.port is not None:
            print(f"Port {port} is already used by another application. Omit --port to select a free port automatically.")
            return 1
        port=next((candidate for candidate in range(port+1,min(port+51,65536)) if port_available(candidate)),None)
        if port is None:
            print('No free local port was found. Close an unused application and try again.')
            return 1
        url=f'http://127.0.0.1:{port}'
    # Hold an OS lock for the process lifetime. A crash releases it automatically.
    lock = (settings.data_dir / "collector.lock").open("a+b")
    try:
        if os.name == "nt":
            import msvcrt
            lock.seek(0);lock.write(b"0");lock.flush();lock.seek(0)
            msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("This catalog is already open in another Farida process. Close that process first.")
        lock.close()
        return 1
    remembered_port.write_text(str(port),encoding='utf-8')
    try:
        if seed_new_catalog(settings.db_path, resource_root() / "data" / "catalog.json"):
            print("已载入随应用提供的歌切目录。", flush=True)
        print(f"法里达 · 歌切收藏 {__version__}: {url}\n数据目录: {settings.data_dir}\n关闭此窗口或按 Ctrl+C 退出。",flush=True)
        if not args.no_browser:
            threading.Thread(target=open_when_ready,args=(url,),daemon=True).start()
        uvicorn.run(create_app(settings,scan_on_start=not args.no_startup_scan),host="127.0.0.1",port=port,access_log=False,log_level="warning")
    finally:
        lock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
