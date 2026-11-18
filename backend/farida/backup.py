"""Portable data-only backups. Login credentials and executable SQL are excluded."""
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path
from .db import Database, PLAYER_STATE_SQL, now
from .player_state import PlayerState

LEGACY_TABLES = ("sources", "videos", "parts", "memberships", "annotations", "curated_songs", "user_state", "playlists", "playlist_items", "playback_state")
TABLES = LEGACY_TABLES + ("listening_history",)
LIMIT = 64 * 1024 * 1024


def _snapshot(con):
    tables = {}
    for table in TABLES:
        query = PLAYER_STATE_SQL if table == "playback_state" else f"SELECT * FROM {table}"
        tables[table] = [dict(row) for row in con.execute(query)]
    return {"format": "farida-backup", "version": 2, "created_at": now(), "tables": tables}


def export_backup(db):
    with db.connect() as con:
        con.execute("BEGIN")
        return _snapshot(con)


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
        with candidate.connect() as con:
            _validate_catalog_fields(con)
    return data


def _validate_catalog_fields(con):
    # Scan the stored fields directly, including videos with no active parts.
    columns = {
        "sources": {"required_tags": "array"},
        "videos": {"tags": "array", "statistics": "object", "provenance": "object", "raw_metadata": "object"},
        "annotations": {"manual_fields": "array"},
    }

    def json_type(field):
        # json_valid rejects JSON5 syntax that Python and browsers cannot decode.
        return f"CASE WHEN json_valid({field}) THEN json_type({field}) ELSE 'invalid' END"

    for table, fields in columns.items():
        conditions = [f"{json_type(field)} != '{kind}'" for field, kind in fields.items()]
        if table == "sources":
            # Preserve all legacy representations of an absent source error.
            conditions.append(f"(COALESCE(last_error, '') != '' AND {json_type('last_error')} NOT IN ('object','null'))")
        if con.execute(f"SELECT 1 FROM {table} WHERE " + " OR ".join(conditions) + " LIMIT 1").fetchone():
            raise ValueError("备份中的来源、视频或片段元数据无效。")
    # A playlist item can reference an existing part whose title annotation is missing.
    # That item disappears from the playlist's display join despite passing the foreign keys.
    if con.execute("SELECT 1 FROM playlist_items i LEFT JOIN annotations a ON a.clip_id=i.clip_id "
                   "WHERE a.clip_id IS NULL LIMIT 1").fetchone():
        raise ValueError("备份中的歌单包含缺少标题记录的片段。")
    saved = con.execute("SELECT value FROM playback_state WHERE id=1").fetchone()
    if saved is not None:
        PlayerState.model_validate_json(saved["value"])


def replace_tables(db, data):
    data = _normalized_backup(data)
    with db.connect() as con:
        con.execute("BEGIN IMMEDIATE")
        _replace_tables(con, data)


def _replace_tables(con, data):
    con.execute("DELETE FROM sync_jobs")
    for table in reversed(TABLES):
        con.execute(f"DELETE FROM {table}")
    for table in TABLES:
        columns = [row[1] for row in con.execute(f"PRAGMA table_info({table})")]
        expected_fields = set(columns)
        rows = data["tables"][table]
        if not isinstance(rows, list) or any(not isinstance(row, dict) or row.keys() != expected_fields for row in rows):
            raise ValueError("备份字段不完整或格式不兼容。")
        if table == "listening_history":
            _validate_history(rows)
        placeholders = ",".join("?" for _ in columns)
        con.executemany(
            f"INSERT INTO {table}({','.join(columns)}) VALUES({placeholders})",
            (tuple(row[column] for column in columns) for row in rows),
        )
    if con.execute("PRAGMA foreign_key_check").fetchone():
        raise ValueError("备份包含无效的歌曲或歌单引用。")


def _save_recovery(con, folder):
    folder.mkdir(exist_ok=True)
    pending = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=folder, prefix="before-restore-" + now().replace(":", "-") + "-",
            suffix=".tmp", delete=False,
        ) as stream:
            pending = Path(stream.name)
            json.dump(_snapshot(con), stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        ready = pending.with_suffix(".json")
        if ready.exists():
            raise FileExistsError(ready)
        pending.rename(ready)
        return ready.name
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


def restore_backup(db, data):
    return restore_validated_backup(db, validate_backup(data))


def restore_validated_backup(db, data):
    """Install a backup returned by validate_backup after the caller pauses live work."""
    with db.connect() as con:
        # Concurrent edits either enter the recovery copy or commit after the restore.
        con.execute("BEGIN IMMEDIATE")
        filename = _save_recovery(con, db.path.parent / "backups")
        _replace_tables(con, data)
    return filename
