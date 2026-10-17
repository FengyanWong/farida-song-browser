"""Start the local collector and open its UI in the system default browser."""
import argparse
import json
import os
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))

from farida import __version__
from farida.config import Settings

LOG_PATH = None


def configure_output(data_dir):
    """Windowed executables have no stdout/stderr; retain local diagnostics."""
    global LOG_PATH
    packaged = os.name == "nt" and getattr(sys, "frozen", False)
    if packaged or sys.stdout is None or sys.stderr is None:
        LOG_PATH = data_dir / "launcher.log"
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 1_048_576:
            try:
                LOG_PATH.replace(data_dir / "launcher.previous.log")
            except OSError:
                # Another launch may still be using this file on Windows.
                pass
        output = LOG_PATH.open("a", encoding="utf-8", buffering=1)
        if packaged or sys.stdout is None:
            sys.stdout = output
        if packaged or sys.stderr is None:
            sys.stderr = output
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")


def entrypoint():
    windowless = os.name == "nt" and (getattr(sys, "frozen", False) or sys.stderr is None)
    try:
        result = main()
    except (Exception, SystemExit) as error:
        if not windowless:
            raise
        if isinstance(error, SystemExit) and error.code in (None, 0):
            return 0
        traceback.print_exc()
        result = 1
        message = f"应用无法继续运行：{error}"
    else:
        message = "应用未能启动。"
    if result and windowless:
        import ctypes
        if LOG_PATH:
            message += f"\n\n请查看本机日志：\n{LOG_PATH}"
        ctypes.windll.user32.MessageBoxW(None, message, "法里达 · 歌切收藏", 0x10)
    return result


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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=f"法里达 · 歌切收藏 {__version__}")
    parser.add_argument("--port",type=int,default=None)
    parser.add_argument("--no-browser",action="store_true")
    parser.add_argument("--no-startup-scan",action="store_true",help="Skip the automatic scan for this process (for maintenance or manual resume)")
    parser.add_argument("--data-dir",type=Path)
    args = parser.parse_args()
    if args.port is not None and not 1024 <= args.port <= 65535:
        parser.error("Use a port between 1024 and 65535")
    settings = Settings.from_env()
    if args.data_dir:
        settings.data_dir=args.data_dir.resolve()
    settings.data_dir.mkdir(parents=True,exist_ok=True)
    configure_output(settings.data_dir)
    try:
        import uvicorn
        from farida.app import create_app
        from farida.catalog_snapshot import seed_new_catalog
        from farida.resources import resource_root
    except ImportError:
        print("Dependencies are not installed. Run Start Farida.cmd, or: python -m pip install -r requirements.txt")
        return 1
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
        print(f"法里达 · 歌切收藏 {__version__}: {url}\n数据目录: {settings.data_dir}\n在页面右上角账号菜单中选择“退出应用”以停止后台运行。",flush=True)
        def shutdown():
            server.should_exit = True

        app = create_app(settings, scan_on_start=not args.no_startup_scan, shutdown_callback=shutdown)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, access_log=False,
                                             log_level="warning", use_colors=False, timeout_graceful_shutdown=5))
        if not args.no_browser:
            threading.Thread(target=open_when_ready,args=(url,),daemon=True).start()
        server.run()
    finally:
        lock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(entrypoint())
