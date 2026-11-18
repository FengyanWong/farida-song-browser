"""Start the local collector and open its UI in the system default browser."""
import argparse
import http.client
import json
import os
import socket
import sys
import threading
import time
import traceback
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


def healthy(port):
    # A loopback probe needs neither system proxies nor an HTTPS trust store.
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
    try:
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        if response.status != 200:
            return False
        data = json.loads(response.read(4096))
        return (isinstance(data, dict) and data.get("application") == "farida-song-browser"
                and data.get("status") == "ok")
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def read_port(path):
    try:
        port = int(path.read_text(encoding="utf-8").strip())
        if 1024 <= port <= 65535:
            return port
    except (OSError, ValueError):
        pass
    return None


def open_when_ready(port):
    for _ in range(100):
        if healthy(port):
            webbrowser.open_new_tab(f"http://127.0.0.1:{port}")
            return
        time.sleep(0.1)


def bind_ui_socket(port, *, allow_fallback):
    """Reserve the loopback listener through catalog startup and the server handoff."""
    # Port zero lets the OS select any free port when the preferred one is busy.
    candidates = (port, 0) if allow_fallback and port else (port,)
    for candidate in candidates:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if os.name == "nt":
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", candidate))
            listener.listen()
        except OSError:
            listener.close()
            if candidate == candidates[-1]:
                raise
        else:
            return listener


def acquire_catalog_lock(data_dir, on_running, timeout=30):
    """Wait for a closing server to release its lock; reuse a live instance."""
    lock = (data_dir / "collector.lock").open("a+b")
    deadline = time.monotonic() + timeout
    while True:
        try:
            if os.name == "nt":
                import msvcrt
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except OSError:
            if on_running():
                lock.close()
                return None
            if time.monotonic() >= deadline:
                lock.close()
                raise RuntimeError("上一个应用仍在退出，请稍后重新打开。")
            time.sleep(0.25)


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
    remembered_port = settings.data_dir / "ui-port.txt"
    port = args.port or read_port(remembered_port) or 8765

    def reuse_running():
        running_port = read_port(remembered_port)
        if running_port is None or not healthy(running_port):
            return False
        if not args.no_browser:
            webbrowser.open_new_tab(f"http://127.0.0.1:{running_port}")
        return True

    lock = acquire_catalog_lock(settings.data_dir, reuse_running)
    if lock is None:
        return 0
    try:
        listener = bind_ui_socket(port, allow_fallback=args.port is None)
    except OSError as error:
        lock.close()
        if args.port is not None:
            print(f"本机端口 {port} 无法使用。省略 --port 可自动选择可用端口。", file=sys.stderr)
        else:
            print(f"无法打开本机服务端口：{error}", file=sys.stderr)
        return 1
    port = listener.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    try:
        try:
            import uvicorn
            from farida.app import create_app
            from farida.catalog_snapshot import seed_new_catalog
            from farida.resources import resource_root
        except ImportError:
            print("Dependencies are not installed. Run Start Farida.cmd, or: python -m pip install -r requirements.txt")
            return 1
        remembered_port.write_text(str(port), encoding="utf-8")
        if seed_new_catalog(settings.db_path, resource_root() / "data" / "catalog.json"):
            print("已载入随应用提供的歌切目录。", flush=True)
        print(f"法里达 · 歌切收藏 {__version__}: {url}\n数据目录: {settings.data_dir}\n关闭最后一个应用网页后约 5 秒自动退出，也可在账号菜单选择“退出应用”。",flush=True)
        def shutdown():
            server.should_exit = True

        app = create_app(settings, scan_on_start=not args.no_startup_scan, shutdown_callback=shutdown,
                         browser_start_timeout=None if args.no_browser else 60)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, access_log=False,
                                             log_level="warning", use_colors=False, ws="wsproto", timeout_graceful_shutdown=5))
        if not args.no_browser:
            threading.Thread(target=open_when_ready,args=(port,),daemon=True).start()
        server.run(sockets=[listener])
    finally:
        listener.close()
        lock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(entrypoint())
