import os
from dataclasses import dataclass
from pathlib import Path


def data_directory() -> Path:
    if os.getenv("FARIDA_DATA_DIR"):
        return Path(os.environ["FARIDA_DATA_DIR"]).expanduser()
    if os.name == "nt":
        return Path(os.getenv("LOCALAPPDATA", str(Path.home()))) / "FaridaSongBrowser"
    return Path(os.getenv("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "farida-song-browser"


@dataclass
class Settings:
    data_dir: Path
    request_interval: float = 2.0
    request_timeout: float = 20.0
    discovery_pages: int = 20
    incremental_pages: int = 3
    stale_hours: float = 24.0
    cookie_file: Path | None = None

    @classmethod
    def from_env(cls):
        cookie = os.getenv("FARIDA_COOKIE_FILE")
        return cls(
            data_dir=data_directory(),
            request_interval=max(0.5, float(os.getenv("FARIDA_REQUEST_INTERVAL", "2"))),
            request_timeout=max(3, float(os.getenv("FARIDA_REQUEST_TIMEOUT", "20"))),
            discovery_pages=max(1, min(50, int(os.getenv("FARIDA_DISCOVERY_PAGES", "20")))),
            incremental_pages=max(1, min(20, int(os.getenv("FARIDA_INCREMENTAL_PAGES", "3")))),
            stale_hours=max(1, float(os.getenv("FARIDA_STALE_HOURS", "24"))),
            cookie_file=Path(cookie).expanduser() if cookie else None,
        )

    @property
    def db_path(self):
        return self.data_dir / "catalog.sqlite3"
