"""Publishable metadata snapshots; never copy a user's database or credentials."""
import csv
import json
import os
import sqlite3
import tempfile
from datetime import datetime
from pathlib import Path

from .db import Database, encode, now
from .songlist import URL as SONGLIST_URL


# Explicit columns keep new private database fields out of future releases.
PUBLIC_COLUMNS = {
    "sources": ("id", "source_type", "display_name", "resolved_name", "uid", "verified_uid",
                "collection_id", "canonical_url", "query", "required_tags", "enabled",
                "singing_collection", "verification_status", "verification_method",
                "last_complete_scan_at", "last_refresh_at", "last_discovery_at", "created_at"),
    "videos": ("bvid", "aid", "uploader_uid", "uploader_name", "raw_title", "description", "tags",
               "thumbnail_url", "published_at", "duration_seconds", "verification_status",
               "availability_status", "statistics", "stats_fetched_at", "stats_scope", "fetched_at",
               "provenance", "raw_metadata"),
    "parts": ("id", "video_bvid", "cid", "part_number", "raw_part_title", "duration_seconds", "active"),
    "memberships": ("source_id", "video_bvid", "first_seen_at", "last_seen_at"),
    "annotations": ("clip_id", "display_song_title", "song_group", "inclusion_status",
                    "classification_reason", "classification_version", "manual_fields"),
    "curated_songs": ("source_id", "id", "song_title", "original_artist", "language", "style",
                      "bvid", "fetched_at"),
}


def public_snapshot(database_path):
    """Read one consistent, read-only snapshot; omit user state and job logs."""
    uri = Path(database_path).resolve().as_uri() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=15)
    con.row_factory = sqlite3.Row
    try:
        con.execute("BEGIN")
        tables = {
            table: [dict(row) for row in con.execute(
                f"SELECT {','.join(columns)} FROM {table} ORDER BY {columns[0]}, {columns[1]}"
            )]
            for table, columns in PUBLIC_COLUMNS.items()
        }
    finally:
        con.close()

    for video in tables["videos"]:
        original = json.loads(video["raw_metadata"])
        # Reconstruct the small public response needed by cache reuse. Do not
        # publish arbitrary fields returned to an authenticated Bilibili client.
        video["raw_metadata"] = encode({
            "bvid": video["bvid"], "aid": video["aid"], "title": video["raw_title"],
            "desc": video["description"], "pic": video["thumbnail_url"],
            "pubdate": int(datetime.fromisoformat(video["published_at"]).timestamp()),
            "duration": video["duration_seconds"],
            "owner": {"mid": int(video["uploader_uid"]), "name": video["uploader_name"]},
            "pages": [{key: part.get(key) for key in ("cid", "page", "part", "duration")}
                      for part in original["pages"]],
            "staff": [{"mid": member["mid"], "name": member.get("name", "")}
                      for member in (original.get("staff") or []) if isinstance(member, dict) and member.get("mid")],
            "stat": {key: json.loads(video["statistics"]).get(key)
                     for key in ("view", "like", "coin", "favorite", "share", "reply", "danmaku")},
        })
        video["provenance"] = encode({
            "details": "https://api.bilibili.com/x/web-interface/view",
            "tags": "https://api.bilibili.com/x/tag/archive/tags",
            "retrieved_at": video["fetched_at"],
        })
    for annotation in tables["annotations"]:
        annotation["song_group"] = ""
        annotation["manual_fields"] = "[]"

    active_ids = {part["id"] for part in tables["parts"] if part["active"]}
    videos = {video["bvid"] for video in tables["videos"]}
    references = videos | {song["bvid"] for song in tables["curated_songs"] if song["bvid"]}
    return {
        "format": "farida-public-catalog", "format_version": 1, "exported_at": now(),
        "attribution": {"songlist_author": "CLANNADOR", "songlist_url": SONGLIST_URL},
        "counts": {
            "videos": len(videos), "active_clips": len(active_ids),
            "included_clips": sum(a["clip_id"] in active_ids and a["inclusion_status"] == "included"
                                  for a in tables["annotations"]),
            "curated_songs": len(tables["curated_songs"]), "unique_bilibili_videos": len(references),
            "linked_videos_without_metadata": len(references - videos),
        },
        "tables": tables,
    }


def write_public_catalog(database_path, output_dir):
    """Write the seed plus a spreadsheet-friendly list and unique video URLs."""
    snapshot = public_snapshot(database_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "catalog.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tables = snapshot["tables"]
    videos = {row["bvid"]: row for row in tables["videos"]}
    annotations = {row["clip_id"]: row for row in tables["annotations"]}
    credited = {row["bvid"] for row in tables["curated_songs"] if row["bvid"]}
    fields = ["song_title", "original_title", "uploader", "uploaded_at", "bvid", "cid", "part",
              "url", "status", "active", "availability", "songlist_attribution", "songlist_url"]
    with (output_dir / "bilibili-clips.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()

        def write(row):
            # A video title is untrusted text when opened in a spreadsheet.
            writer.writerow({key: "'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")) else value
                             for key, value in row.items()})

        for part in tables["parts"]:
            video, annotation = videos[part["video_bvid"]], annotations[part["id"]]
            bvid = video["bvid"]
            write({
                "song_title": annotation["display_song_title"], "original_title": video["raw_title"],
                "uploader": video["uploader_name"], "uploaded_at": video["published_at"],
                "bvid": bvid, "cid": part["cid"], "part": part["part_number"],
                "url": f"https://www.bilibili.com/video/{bvid}/" + (f"?p={part['part_number']}" if part["active"] else ""),
                "status": annotation["inclusion_status"], "active": part["active"],
                "availability": video["availability_status"],
                "songlist_attribution": "CLANNADOR" if bvid in credited else "",
                "songlist_url": SONGLIST_URL if bvid in credited else "",
            })
        for bvid in sorted(credited - videos.keys()):
            titles = sorted({song["song_title"] for song in tables["curated_songs"] if song["bvid"] == bvid})
            write({"song_title": " / ".join(titles), "bvid": bvid,
                   "url": f"https://www.bilibili.com/video/{bvid}/", "status": "not_loaded",
                   "availability": "unknown", "songlist_attribution": "CLANNADOR", "songlist_url": SONGLIST_URL})
    (output_dir / "bilibili-links.txt").write_text(
        "".join(f"https://www.bilibili.com/video/{bvid}/\n" for bvid in sorted(videos.keys() | credited)), encoding="utf-8")
    return snapshot["counts"]


def seed_new_catalog(database_path, snapshot_path):
    """Install bundled metadata once, atomically. Never replace an existing catalog."""
    destination, snapshot_path = Path(database_path), Path(snapshot_path)
    if destination.exists() or not snapshot_path.is_file():
        return False
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    if snapshot.get("format") != "farida-public-catalog" or snapshot.get("format_version") != 1:
        raise ValueError("Unsupported bundled catalog format")
    if set(snapshot["tables"]) != set(PUBLIC_COLUMNS):
        raise ValueError("Unexpected bundled catalog tables")
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix="seed-", suffix=".sqlite3", dir=destination.parent)
    os.close(handle)
    temporary = Path(temporary)
    try:
        db = Database(temporary)
        db.initialize()
        with db.connect() as con:
            con.execute("DELETE FROM sources")
            for table, columns in PUBLIC_COLUMNS.items():
                rows = snapshot["tables"][table]
                if any(set(row) != set(columns) for row in rows):
                    raise ValueError(f"Unexpected bundled {table} fields")
                con.executemany(f"INSERT INTO {table}({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
                                [tuple(row[key] for key in columns) for row in rows])
            if con.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("Bundled catalog has broken references")
        with db.connect() as con:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            con.execute("PRAGMA journal_mode=DELETE")
            if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Bundled catalog is damaged")
        os.replace(temporary, destination)
    finally:
        for suffix in ("", "-wal", "-shm"):
            Path(str(temporary) + suffix).unlink(missing_ok=True)
    return True
