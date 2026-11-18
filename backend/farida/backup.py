"""Portable data-only backups. Login credentials and executable SQL are excluded."""
import json
import sqlite3
import secrets
import tempfile
from datetime import datetime
from pathlib import Path
from .db import Database, PLAYER_STATE_SQL, now

LEGACY_TABLES = ("sources", "videos", "parts", "memberships", "annotations", "curated_songs", "user_state", "playlists", "playlist_items", "playback_state")
TABLES = LEGACY_TABLES + ("listening_history",)
LIMIT = 64 * 1024 * 1024


def export_backup(db):
    with db.connect() as con:
        con.execute("BEGIN")
        tables = {}
        for table in TABLES:
            query = PLAYER_STATE_SQL if table == "playback_state" else f"SELECT * FROM {table}"
            tables[table] = [dict(row) for row in con.execute(query)]
    return {"format": "farida-backup", "version": 2, "created_at": now(), "tables": tables}


def _normalized_backup(data):
    if not isinstance(data, dict) or data.get("format") != "farida-backup" or type(data.get("version")) is not int:
        raise ValueError("不支持的备份格式。请选择本应用导出的备份。")
    version = data["version"]
    expected = LEGACY_TABLES if version == 1 else TABLES
    tables = data.get("tables")
    if version not in (1, 2) or not isinstance(tables, dict) or set(tables) != set(expected):
        raise ValueError("不支持的备份格式。请选择本应用导出的备份。")
    # Version 1 predates listening history. Restoring it clears current history.
    return {**data, "version": 2, "tables": {**tables, "listening_history": tables.get("listening_history", [])}}


def _validate_history(rows):
    for row in rows:
        if not isinstance(row["clip_id"], str) or not row["clip_id"]:
            raise ValueError("播放历史包含无效的歌曲引用。")
        value = row["last_played_at"]
        if not isinstance(value, str):
            raise ValueError("播放历史时间格式无效。")
        try:
            timestamp = datetime.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("播放历史时间格式无效。") from exc
        if timestamp.tzinfo is None or timestamp.utcoffset() is None:
            raise ValueError("播放历史时间必须包含时区。")


def validate_backup(data):
    data = _normalized_backup(data)
    with tempfile.TemporaryDirectory(prefix="farida-restore-") as folder:
        candidate = Database(Path(folder) / "validate.sqlite3")
        candidate.initialize()
        replace_tables(candidate, data)
        # Exercise the JSON fields consumed by the UI before accepting a file.
        candidate.overview()
        candidate.clips(status="all", page_size=2147483647)
        for row in candidate.playlists():
            candidate.playlist(row["id"])
    return data


def replace_tables(db, data):
    data = _normalized_backup(data)
    with db.connect() as con:
        con.execute("BEGIN IMMEDIATE")
        con.execute("DELETE FROM sync_jobs")
        for table in reversed(TABLES):
            con.execute(f"DELETE FROM {table}")
        for table in TABLES:
            columns = [row[1] for row in con.execute(f"PRAGMA table_info({table})")]
            rows = data["tables"][table]
            if not isinstance(rows, list) or any(not isinstance(row, dict) or set(row) != set(columns) for row in rows):
                raise ValueError("备份字段不完整或格式不兼容。")
            if table == "listening_history":
                _validate_history(rows)
            con.executemany(f"INSERT INTO {table}({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", [[row[c] for c in columns] for row in rows])
        if con.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("备份包含无效的歌曲或歌单引用。")


def restore_backup(db, data):
    data = validate_backup(data)
    folder = db.path.parent / "backups"
    folder.mkdir(exist_ok=True)
    safety = folder / ("before-restore-" + now().replace(":", "-") + "-" + secrets.token_hex(4) + ".json")
    # Exclusive creation prevents overwriting a previous recovery copy.
    with safety.open("x", encoding="utf-8") as stream:
        json.dump(export_backup(db), stream, ensure_ascii=False)
    replace_tables(db, data)
    return safety.name
