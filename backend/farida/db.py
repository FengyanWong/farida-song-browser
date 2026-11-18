import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs

from .adapter import BVID, parse_source, validated_video, video_has_uploader
from .classifier import SINGING_COLLECTION_TYPES, classify, normalize
from .songlist import CURATOR, URL as SONGLIST_URL


VIDEO_LINK = re.compile(
    r"(?:https?://)?(?:www\.|m\.)?bilibili\.com/video/(BV[0-9A-Za-z]{10})/?"
    r"(?:\?([^#\s]*))?(?:#[^\s]*)?"
)


def video_reference(query):
    """Recognize a local catalog lookup by BV ID or standard Bilibili video URL."""
    query = query.strip()
    if BVID.fullmatch(query):
        return query, None
    match = VIDEO_LINK.fullmatch(query)
    if not match:
        return None
    bvid, query_string = match.groups()
    parts = parse_qs(query_string or "", keep_blank_values=True).get("p")
    if parts is None:
        return bvid, None
    # A malformed or conflicting part must never select a different recording.
    if len(parts) != 1 or not re.fullmatch(r"[0-9]{1,9}", parts[0]):
        return bvid, 0
    return bvid, int(parts[0])


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
 id INTEGER PRIMARY KEY, source_type TEXT NOT NULL,
 display_name TEXT NOT NULL, resolved_name TEXT, uid TEXT, verified_uid TEXT,
 collection_id TEXT, canonical_url TEXT NOT NULL UNIQUE, query TEXT,
 required_tags TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
 singing_collection INTEGER NOT NULL DEFAULT 0,
 verification_status TEXT NOT NULL DEFAULT 'pending', verification_method TEXT,
 last_complete_scan_at TEXT, last_refresh_at TEXT, last_discovery_at TEXT,
 last_error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS videos (
 bvid TEXT PRIMARY KEY, aid INTEGER, uploader_uid TEXT NOT NULL, uploader_name TEXT NOT NULL,
 raw_title TEXT NOT NULL, description TEXT NOT NULL, tags TEXT NOT NULL,
 thumbnail_url TEXT, published_at TEXT NOT NULL, duration_seconds INTEGER,
 verification_status TEXT NOT NULL DEFAULT 'verified', availability_status TEXT NOT NULL DEFAULT 'available',
 statistics TEXT NOT NULL, stats_fetched_at TEXT NOT NULL, stats_scope TEXT NOT NULL DEFAULT 'submission',
 fetched_at TEXT NOT NULL, provenance TEXT NOT NULL, raw_metadata TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parts (
 id TEXT PRIMARY KEY, video_bvid TEXT NOT NULL REFERENCES videos(bvid), cid TEXT NOT NULL,
 part_number INTEGER NOT NULL, raw_part_title TEXT NOT NULL, duration_seconds INTEGER,
 active INTEGER NOT NULL DEFAULT 1, UNIQUE(video_bvid,cid)
);
CREATE TABLE IF NOT EXISTS memberships (
 source_id INTEGER NOT NULL REFERENCES sources(id), video_bvid TEXT NOT NULL REFERENCES videos(bvid),
 first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY(source_id,video_bvid)
);
CREATE TABLE IF NOT EXISTS annotations (
 clip_id TEXT PRIMARY KEY REFERENCES parts(id), display_song_title TEXT NOT NULL,
 song_group TEXT NOT NULL DEFAULT '', inclusion_status TEXT NOT NULL,
 classification_reason TEXT NOT NULL, classification_version TEXT NOT NULL,
 manual_fields TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS user_state (
 clip_id TEXT PRIMARY KEY REFERENCES parts(id), bookmarked INTEGER NOT NULL DEFAULT 0,
 notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS playlists (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
 playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
 clip_id TEXT NOT NULL REFERENCES parts(id), position INTEGER NOT NULL,
 PRIMARY KEY(playlist_id,clip_id)
);
CREATE TABLE IF NOT EXISTS playback_state (
 id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playback_progress (
 id INTEGER PRIMARY KEY REFERENCES playback_state(id) ON DELETE CASCADE,
 queue_key TEXT NOT NULL, sequence INTEGER NOT NULL, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS listening_history (
 clip_id TEXT PRIMARY KEY REFERENCES parts(id), last_played_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listening_recent ON listening_history(last_played_at DESC);
CREATE TABLE IF NOT EXISTS sync_jobs (
 id TEXT PRIMARY KEY, source_ids TEXT NOT NULL, mode TEXT NOT NULL,
 state TEXT NOT NULL, checkpoints TEXT NOT NULL DEFAULT '{}', processed INTEGER NOT NULL DEFAULT 0,
 errors TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, finished_at TEXT,
 heartbeat TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS curated_songs (
 source_id INTEGER NOT NULL REFERENCES sources(id), id INTEGER NOT NULL,
 song_title TEXT NOT NULL, original_artist TEXT NOT NULL, language TEXT NOT NULL,
 style TEXT NOT NULL, bvid TEXT, fetched_at TEXT NOT NULL,
 PRIMARY KEY(source_id,id)
);
CREATE INDEX IF NOT EXISTS curated_song_video ON curated_songs(bvid);
CREATE INDEX IF NOT EXISTS parts_video ON parts(video_bvid);
CREATE INDEX IF NOT EXISTS videos_pubdate ON videos(published_at);
CREATE INDEX IF NOT EXISTS videos_uploader ON videos(uploader_uid);
CREATE INDEX IF NOT EXISTS annotation_status ON annotations(inclusion_status);
CREATE INDEX IF NOT EXISTS membership_video ON memberships(video_bvid);
CREATE UNIQUE INDEX IF NOT EXISTS single_active_job ON sync_jobs((1)) WHERE state IN ('queued','running');
"""

CLIP_JOINS = """ JOIN videos v ON v.bvid=p.video_bvid
 JOIN annotations a ON a.clip_id=p.id
 LEFT JOIN user_state u ON u.clip_id=p.id """
CLIP_FROM = " FROM parts p" + CLIP_JOINS

SOURCE_SELECT = """SELECT s.*, (SELECT COUNT(*) FROM memberships m WHERE m.source_id=s.id) AS submissions,
            (SELECT COUNT(*) FROM memberships m JOIN parts p ON p.video_bvid=m.video_bvid WHERE m.source_id=s.id AND p.active=1) AS entries,
            (SELECT COUNT(*) FROM curated_songs cs WHERE cs.source_id=s.id) AS listed_songs,
            (SELECT COUNT(DISTINCT bvid) FROM curated_songs cs WHERE cs.source_id=s.id) AS linked_songs,
            (SELECT MAX(fetched_at) FROM curated_songs cs WHERE cs.source_id=s.id) AS list_fetched_at
            FROM sources s"""

OVERVIEW_JOB_LIMIT = 10

PLAYABLE = "p.active=1 AND v.verification_status='verified' AND v.availability_status='available'"
PLAYBACK_URL = (f"CASE WHEN {PLAYABLE} THEN 'https://www.bilibili.com/video/' || p.video_bvid "
                "|| '/?p=' || p.part_number END AS playback_url")

# The catalog includes details and annotations; a queue needs only the player fields.
QUEUE_COLUMNS = ("p.id,p.video_bvid,p.cid,p.part_number,a.display_song_title,v.uploader_name,"
                 "p.duration_seconds,v.raw_title,p.raw_part_title," + PLAYBACK_URL)
QUEUE_SELECT = "SELECT " + QUEUE_COLUMNS + CLIP_FROM

# Only combine a long queue with its small checkpoint when a caller reads it.
PLAYER_STATE_SQL = """SELECT s.id, CASE WHEN p.id IS NULL THEN s.value
 ELSE json_patch(s.value,p.value) END AS value FROM playback_state s
 LEFT JOIN playback_progress p ON s.id=p.id WHERE s.id=1"""

CURATED_CREDIT = "EXISTS(SELECT 1 FROM curated_songs cs WHERE cs.bvid=v.bvid) AS has_curated_credit"


def songlist_credit(present):
    return (CURATOR, SONGLIST_URL) if present else ("", "")


# Both catalog views display the original upload, membership credit, and bookmark.
CATALOG_COLUMNS = """(SELECT COUNT(*) FROM parts siblings
 WHERE siblings.video_bvid=p.video_bvid AND siblings.active=1) AS part_count,
 v.uploader_uid,v.uploader_name,v.raw_title,v.thumbnail_url,v.published_at,
 a.display_song_title,a.song_group,a.inclusion_status,COALESCE(u.bookmarked,0) AS bookmarked,
 """ + CURATED_CREDIT + "," + PLAYBACK_URL
BROWSE_COLUMNS = "p.id,p.part_number,p.raw_part_title," + CATALOG_COLUMNS
DETAIL_COLUMNS = """p.*,v.description,v.tags,v.availability_status,v.verification_status,v.statistics,
 v.stats_fetched_at,v.stats_scope,v.fetched_at,v.provenance,
 a.classification_reason,a.classification_version,a.manual_fields,COALESCE(u.notes,'') AS notes,""" + CATALOG_COLUMNS
CLIP_SELECT = "SELECT " + DETAIL_COLUMNS + CLIP_FROM


def search_text(value):
    return normalize(value).replace("fareeda", "法里达").replace("farida", "法里达").replace("法里達", "法里达")


def upload_boundary(value, *, end):
    # The GUI sends precise local-day boundaries. Date-only API clients use UTC days.
    if isinstance(value, datetime):
        try:
            return value.astimezone(timezone.utc).isoformat()
        except OverflowError as exc:
            raise ValueError("上传日期超出支持范围") from exc
    if value is not None:
        return str(value) + ("T23:59:59+00:00" if end else "T00:00:00+00:00")


def clip_order(sort):
    columns = {
        "newest": "v.published_at DESC",
        "oldest": "v.published_at ASC",
        "title": "fold(a.display_song_title) ASC",
        "uploader": "fold(v.uploader_name) ASC",
        # The first source that recorded the video determines discovery for
        # all of its parts. Later refreshes or additional sources cannot move it.
        "discovered": "(SELECT MIN(julianday(m.first_seen_at)) FROM memberships m "
                      "WHERE m.video_bvid=p.video_bvid) DESC NULLS LAST, v.published_at DESC",
    }
    return columns[sort] + ", p.video_bvid, p.part_number"


class Database:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def connect(self):
        con = sqlite3.connect(self.path, timeout=15)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        con.create_function("fold", 1, normalize, deterministic=True)
        con.create_function("search_text", 1, search_text, deterministic=True)
        try:
            with con:
                yield con
        finally:
            con.close()

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as con:
            version = con.execute("PRAGMA user_version").fetchone()[0]
            if version > 1:
                raise RuntimeError("This catalog was created by a newer version of Farida Song Browser")
            con.execute("PRAGMA journal_mode=WAL")
            con.executescript(SCHEMA)
            con.execute("PRAGMA user_version=1")
            con.execute("UPDATE sync_jobs SET state='interrupted',finished_at=?,heartbeat=? WHERE state IN ('queued','running')", (now(),now()))
            for name, uid in [("离落", "394803911"), ("CLANNADOR", "210887872"), ("阿见", "290566607"), ("稻草仁尔", "475349220")]:
                con.execute("INSERT OR IGNORE INTO sources(source_type,display_name,uid,canonical_url,created_at) VALUES('uploader',?,?,?,?)", (name,uid,f"https://space.bilibili.com/{uid}",now()))
            con.execute("INSERT OR IGNORE INTO sources(source_type,display_name,canonical_url,query,required_tags,created_at) VALUES('search',?,?,?,?,?)", ("标签发现", "https://search.bilibili.com/all?keyword=%E6%B3%95%E9%87%8C%E8%BE%BE%20%E7%9B%B4%E6%92%AD%E5%88%87%E7%89%87", "法里达 直播切片", encode(["法里达", "直播切片"]),now()))
            con.execute("INSERT OR IGNORE INTO sources(source_type,display_name,canonical_url,created_at) VALUES('songlist',?,?,?)", ('CLANNADOR 歌单', SONGLIST_URL, now()))

    def one(self, sql, args=()):
        with self.connect() as con:
            row = con.execute(sql, args).fetchone()
            return dict(row) if row else None

    def all(self, sql, args=()):
        with self.connect() as con:
            return [dict(row) for row in con.execute(sql, args)]

    def execute(self, sql, args=()):
        with self.connect() as con:
            return con.execute(sql, args).lastrowid

    def sources(self, include_status=False, *, recent_jobs=None):
        with self.connect() as con:
            rows = [self._source_row(row) for row in con.execute(SOURCE_SELECT + " ORDER BY s.id")]
        if include_status:
            if recent_jobs is None:
                recent_jobs = self.jobs(OVERVIEW_JOB_LIMIT)
            for row in rows:
                row["collection_status"] = self.collection_status(row, recent_jobs)
        return rows

    def _latest_source_job(self, source, recent_jobs):
        if recent_jobs is not None:
            for job in recent_jobs:
                if source["id"] in job["source_ids"]:
                    checkpoint = job["checkpoints"].get(str(source["id"]), {})
                    if checkpoint.get("source_url") in (None, source["canonical_url"]):
                        return job
            if len(recent_jobs) < OVERVIEW_JOB_LIMIT:
                return None
        # A rarely used source can have its latest compatible task outside the overview.
        row = self.one("""SELECT * FROM sync_jobs j WHERE EXISTS
            (SELECT 1 FROM json_each(j.source_ids) WHERE value=?)
            AND (json_extract(j.checkpoints, ?) IS NULL OR json_extract(j.checkpoints, ?)=?)
            ORDER BY (state IN ('queued','running')) DESC,heartbeat DESC,rowid DESC LIMIT 1""",
            (source['id'], f'$."{source["id"]}".source_url', f'$."{source["id"]}".source_url', source['canonical_url']))
        return self.decode_job(row) if row else None

    def collection_status(self, source, recent_jobs=None):
        """Describe the latest selected task even when its source never ran."""
        job = self._latest_source_job(source, recent_jobs)
        successful = [source.get(key) for key in ('last_refresh_at','last_complete_scan_at','last_discovery_at') if source.get(key)]
        result = {'state': 'idle', 'last_success_at': max(successful) if successful else None,
                  'last_attempt_at': None, 'finished_at': None, 'processed': 0, 'added_clips': None,
                  'added_included': None, 'skipped': 0, 'error': None, 'job_id': None, 'mode': None,
                  'current_page': None, 'scope': None, 'can_resume': False, 'unavailable': []}
        if not job:
            return result
        cp = job['checkpoints'].get(str(source['id']), {})
        if cp.get('index_fetched_at'):
            result['index_fetched_at'] = cp['index_fetched_at']
        phase = cp.get('state')
        active = job['state'] in {'queued', 'running'}
        if phase == 'completed':
            state = 'completed'
        elif phase == 'running':
            state = 'running' if active else job['state']
        elif phase == 'failed':
            state = 'paused' if job['state'] == 'paused' else 'failed'
        else:
            state = 'queued' if active else 'not_started'
        error = next((item for item in reversed(job['errors']) if item.get('source_id') == source['id']), None)
        if not error and phase == 'running' and job['state'] == 'failed':
            error = next((item for item in reversed(job['errors']) if item.get('category') == 'internal'), None)
        result.update(state=state, last_attempt_at=cp.get('attempted_at', job['started_at'] if cp and phase != 'pending' else None),
                      finished_at=cp.get('finished_at') or (job.get('finished_at') if not active else None),
                      processed=cp.get('processed', 0), added_clips=cp.get('added_clips'),
                      added_included=cp.get('added_included'), skipped=len(cp.get('unavailable', [])),
                      error=error, job_id=job['id'], mode=job['mode'], current_page=cp.get('current_page'),
                      scope=cp.get('scope'), unavailable=cp.get('unavailable', []), can_resume=state != 'completed' and job['state'] in {'failed','paused','interrupted','cancelled'})
        return result

    @staticmethod
    def _source_row(row):
        row = dict(row)
        if row["source_type"] not in SINGING_COLLECTION_TYPES:
            row["singing_collection"] = 0
        row["required_tags"] = json.loads(row["required_tags"])
        row["last_error"] = json.loads(row["last_error"]) if row["last_error"] else None
        return row

    def _read_source(self, con, source_id):
        row = con.execute(SOURCE_SELECT + " WHERE s.id=?", (source_id,)).fetchone()
        return self._source_row(row) if row is not None else None

    def source(self, source_id):
        with self.connect() as con:
            return self._read_source(con, source_id)

    def add_source(self, name, url, singing_collection=False):
        fields = parse_source(url)
        if fields["source_type"] not in SINGING_COLLECTION_TYPES:
            singing_collection = False
        source_id = self.execute("INSERT INTO sources(source_type,display_name,uid,collection_id,canonical_url,singing_collection,created_at) VALUES(?,?,?,?,?,?,?)", (fields["source_type"],name or fields["uid"],fields["uid"],fields["collection_id"],fields["canonical_url"],int(singing_collection),now()))
        return self.source(source_id)

    def update_source(self, source_id, patch):
        changes = dict(patch)
        url = changes.pop("url", None)
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            current = con.execute("SELECT canonical_url,source_type,singing_collection FROM sources WHERE id=?", (source_id,)).fetchone()
            if current is None:
                raise KeyError(source_id)
            if url is not None and url.strip() != current["canonical_url"]:
                identity = parse_source(url)
                if identity["canonical_url"] != current["canonical_url"]:
                    changes.update(identity)
                    changes.update(verification_status="pending", verified_uid=None, resolved_name=None,
                                   verification_method=None, last_complete_scan_at=None, last_refresh_at=None,
                                   last_discovery_at=None, last_error=None)
                    # Other sources and local video/user data keep their original records.
                    con.execute("DELETE FROM memberships WHERE source_id=?", (source_id,))
            kind = changes.get("source_type", current["source_type"])
            if kind not in SINGING_COLLECTION_TYPES and changes.get("singing_collection", current["singing_collection"]):
                changes["singing_collection"] = 0
            if changes:
                assignments = ",".join(key + "=?" for key in changes)
                con.execute("UPDATE sources SET " + assignments + " WHERE id=?", [*changes.values(), source_id])
            return self._read_source(con, source_id)

    def verified_source(self, source_id, identity):
        self.execute("UPDATE sources SET resolved_name=?,verified_uid=?,verification_status='verified',verification_method=?,last_error=NULL WHERE id=?", (identity["name"],identity["uid"],identity["method"],source_id))

    def missing_songlist_links(self, source_id, after_id=0, limit=40):
        if not 1 <= limit <= 100 or not 0 <= after_id < 2**63:
            raise ValueError("歌单链接的分页参数无效。")
        if not 0 < source_id < 2**63:
            raise KeyError(source_id)
        items = []
        next_after_id = None
        with self.connect() as con:
            con.execute("BEGIN")
            source = con.execute("SELECT source_type FROM sources WHERE id=?", (source_id,)).fetchone()
            if source is None:
                raise KeyError(source_id)
            if source["source_type"] != "songlist":
                raise ValueError("此来源不是整理歌单。")
            rows = con.execute(
                "SELECT c.id,c.song_title,c.original_artist,c.bvid FROM curated_songs c "
                "WHERE c.source_id=? AND c.id>? AND c.bvid IS NOT NULL "
                "AND NOT EXISTS(SELECT 1 FROM videos v WHERE v.bvid=c.bvid) ORDER BY c.id",
                (source_id, after_id),
            )
            for row in rows:
                bvid = row["bvid"]
                # A restored legacy row must still be a real BV identifier before becoming a link.
                if not isinstance(bvid, str) or not BVID.fullmatch(bvid):
                    continue
                if len(items) == limit:
                    next_after_id = items[-1]["id"]
                    break
                items.append({**dict(row), "url": f"https://www.bilibili.com/video/{bvid}/"})
        return {"items": items, "next_after_id": next_after_id, "attribution": CURATOR, "source_url": SONGLIST_URL}

    def save_songlist(self, source, rows):
        stamp = now()
        with self.connect() as con:
            con.execute('DELETE FROM curated_songs WHERE source_id=?', (source['id'],))
            con.executemany('INSERT INTO curated_songs(source_id,id,song_title,original_artist,language,style,bvid,fetched_at) VALUES(?,?,?,?,?,?,?,?)',
                            [(source['id'], row['id'], row['song_title'], row['original_artist'], row['language'], row['style'], row['bvid'], stamp)
                             for row in rows])

    def save_video(self, source, data, tags, cached=None, collection_job=None):
        validated_video(data, data["bvid"])
        stamp = now()
        bvid = data["bvid"]
        if source["source_type"] == "uploader" and not video_has_uploader(data, source["uid"]):
            raise ValueError("Video owner and coauthors do not match configured UID")
        stats = {key: value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None for key in ("view","like","coin","favorite","share","reply","danmaku") for value in [data.get("stat", {}).get(key)]}
        thumbnail = data.get("pic")
        if isinstance(thumbnail, str) and thumbnail.startswith("http://"):
            thumbnail = "https://" + thumbnail[7:]
        provenance = {"details": "https://api.bilibili.com/x/web-interface/view", "tags": "https://api.bilibili.com/x/tag/archive/tags", "retrieved_at": stamp}
        fields = dict(bvid=bvid, aid=data.get("aid"), uploader_uid=str(data["owner"]["mid"]), uploader_name=data["owner"]["name"],raw_title=data["title"], description=data.get("desc", ""), tags=encode(tags), thumbnail_url=thumbnail,
                      published_at=datetime.fromtimestamp(data["pubdate"], timezone.utc).isoformat(timespec="seconds"), duration_seconds=data.get("duration"), verification_status="verified",availability_status="available", statistics=encode(stats), stats_fetched_at=stamp, stats_scope="submission", fetched_at=stamp, provenance=encode(provenance),raw_metadata=encode(data))
        if cached:
            for field in ("fetched_at", "stats_fetched_at", "provenance"):
                fields[field] = cached[field]
        with self.connect() as con:
            added_clips = added_included = 0
            existing_ids = {row[0] for row in con.execute("SELECT id FROM parts WHERE video_bvid=?", (bvid,))}
            curated = con.execute('SELECT song_title FROM curated_songs WHERE bvid=?', (bvid,)).fetchall()
            con.execute("INSERT INTO videos(" + ",".join(fields) + ") VALUES(" + ",".join("?" for _ in fields) + ") ON CONFLICT(bvid) DO UPDATE SET " + ",".join(f"{k}=excluded.{k}" for k in fields if k != "bvid"), list(fields.values()))
            con.execute("INSERT INTO memberships VALUES(?,?,?,?) ON CONFLICT(source_id,video_bvid) DO UPDATE SET last_seen_at=excluded.last_seen_at", (source["id"],bvid,stamp,stamp))
            # Old CIDs stay stored so annotations/bookmarks can survive a later reappearance.
            con.execute("UPDATE parts SET active=0 WHERE video_bvid=?", (bvid,))
            for part in data["pages"]:
                clip_id = f"{bvid}:{part['cid']}"
                con.execute("INSERT INTO parts(id,video_bvid,cid,part_number,raw_part_title,duration_seconds,active) VALUES(?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET part_number=excluded.part_number,raw_part_title=excluded.raw_part_title,duration_seconds=excluded.duration_seconds,active=1", (clip_id,bvid,str(part["cid"]),part["page"],part.get("part", ""),part.get("duration")))
                song_names = {row['song_title'] for row in curated if len(data['pages']) == 1 or normalize(part.get('part', '').strip('《》')) == normalize(row['song_title'])}
                title,status,reason,version = classify(data,part,tags,source,curated_song=next(iter(song_names)) if len(song_names) == 1 else None)
                if clip_id not in existing_ids:
                    added_clips += 1
                    added_included += int(status == "included")
                previous = con.execute("SELECT * FROM annotations WHERE clip_id=?", (clip_id,)).fetchone()
                if previous:
                    manual = json.loads(previous["manual_fields"])
                    if "display_song_title" in manual:
                        title = previous["display_song_title"]
                    if "inclusion_status" in manual:
                        status,reason = previous["inclusion_status"],previous["classification_reason"]
                    # A discovery search must not downgrade positive evidence from an uploader/collection.
                    elif source["source_type"] == "search" and previous["inclusion_status"] == "included" and status == "needs_review":
                        status,reason = previous["inclusion_status"],previous["classification_reason"]
                    con.execute("UPDATE annotations SET display_song_title=?,inclusion_status=?,classification_reason=?,classification_version=? WHERE clip_id=?", (title,status,reason,version,clip_id))
                else:
                    con.execute("INSERT INTO annotations(clip_id,display_song_title,inclusion_status,classification_reason,classification_version) VALUES(?,?,?,?,?)", (clip_id,title,status,reason,version))
            if collection_job:
                job, cp = collection_job
                next_cp, processed = self._write_video_checkpoint(con, source["id"], bvid, job, cp, added_clips, added_included)
        if collection_job:
            # The surrounding transaction has committed. A failed commit must
            # leave the live checkpoint intact for the failure handler and resume.
            cp.update(next_cp)
            job["processed"] = processed
        return len(data["pages"])

    @staticmethod
    def _write_video_checkpoint(con, source_id, bvid, job, cp, added_clips, added_included):
        seen = sorted({*cp.get("seen", ()), bvid})
        next_cp = {**cp, "seen": seen, "processed": len(seen)}
        if "added_clips" in cp:
            next_cp["added_clips"] += added_clips
            next_cp["added_included"] = cp.get("added_included", 0) + added_included
        checkpoints = {**job["checkpoints"], str(source_id): next_cp}
        processed = sum(checkpoint.get("processed", 0) for checkpoint in checkpoints.values())
        heartbeat = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        update = con.execute("UPDATE sync_jobs SET checkpoints=?,processed=?,heartbeat=? WHERE id=?",
                             (encode(checkpoints), processed, heartbeat, job["id"]))
        if update.rowcount != 1:
            raise ValueError("找不到此采集任务。")
        return next_cp, processed

    def reuse_video(self, source, video, collection_job=None):
        # Reclassification and a new membership are not a fresh upstream retrieval.
        self.save_video(source, json.loads(video["raw_metadata"]), json.loads(video["tags"]), cached=video, collection_job=collection_job)

    def filters(self, q="", status="included", source_id=None, uploader=None, after=None, before=None, bookmarked=False, **_):
        clauses, args = ["p.active=1"], []
        if status != "all":
            clauses.append("a.inclusion_status=?")
            args.append(status)
        reference = video_reference(q) if q else None
        if reference:
            bvid, part = reference
            clauses.append("v.bvid=?")
            args.append(bvid)
            if part is not None:
                clauses.append("p.part_number=?")
                args.append(part)
        elif q:
            folded = search_text(q)
            folded = folded.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            clauses.append("search_text(a.display_song_title || ' ' || a.song_group || ' ' || v.raw_title || ' ' || p.raw_part_title || ' ' || v.uploader_name || ' ' || v.tags) LIKE ? ESCAPE '\\'")
            args.append("%" + folded + "%")
        if source_id:
            clauses.append("EXISTS(SELECT 1 FROM memberships m WHERE m.video_bvid=v.bvid AND m.source_id=?)")
            args.append(source_id)
        if uploader:
            clauses.append("v.uploader_uid=?")
            args.append(uploader)
        start, end = upload_boundary(after, end=False), upload_boundary(before, end=True)
        if start and end and start > end:
            raise ValueError("起始上传日期不能晚于结束日期")
        if start:
            clauses.append("v.published_at>=?")
            args.append(start)
        if end:
            clauses.append("v.published_at<=?")
            args.append(end)
        if bookmarked:
            clauses.append("u.bookmarked=1")
        return " WHERE " + " AND ".join(clauses), args

    @staticmethod
    def clip_row(row):
        for key in ("tags","statistics","provenance","manual_fields"):
            row[key] = json.loads(row[key])
        row['songlist_attribution'], row['songlist_url'] = songlist_credit(row['has_curated_credit'])
        return row

    def clips(self, page=1, page_size=40, sort="newest", *, compact=False, **filters):
        where, args = self.filters(**filters)
        order = clip_order(sort)
        columns = BROWSE_COLUMNS if compact else DETAIL_COLUMNS
        with self.connect() as con:
            con.execute("BEGIN")
            total = con.execute("SELECT COUNT(*)" + CLIP_FROM + where, args).fetchone()[0]
            items = [dict(row) for row in con.execute(
                "SELECT " + columns + CLIP_FROM + where + f" ORDER BY {order} LIMIT ? OFFSET ?",
                [*args, page_size, (page - 1) * page_size],
            )]
        if not compact:
            for item in items:
                self.clip_row(item)
        return {"items": items, "total": total, "page": page, "page_size": page_size}

    @contextmanager
    def csv_rows(self, sort="newest", **filters):
        where, args = self.filters(**filters)
        columns = ("a.display_song_title,v.raw_title,v.uploader_name,v.published_at,"
                   "p.video_bvid,p.cid,p.part_number," + PLAYBACK_URL + ",a.inclusion_status," + CURATED_CREDIT)
        with self.connect() as con:
            # The cursor holds one read snapshot for all matching rows.
            rows = con.execute("SELECT " + columns + CLIP_FROM + where + " ORDER BY " + clip_order(sort), args)
            yield ((*row[:-1], *songlist_credit(row[-1])) for row in rows)

    def grouped_clips(self, page=1, page_size=40, sort="newest", *, compact=False, **filters):
        """Page complete song groups, retaining every matching recording."""
        where, args = self.filters(**filters)
        order = clip_order(sort)
        # Rank compact IDs first so descriptions and other metadata are only
        # loaded for recordings that belong to this page.
        group_key = "COALESCE(NULLIF(fold(a.song_group),''), NULLIF(fold(a.display_song_title),''), p.id)"
        rank = (f"SELECT p.id, {group_key} AS group_key, "
                f"ROW_NUMBER() OVER (ORDER BY {order}) AS ordinal"
                + CLIP_FROM + where)
        columns = BROWSE_COLUMNS if compact else DETAIL_COLUMNS
        page_query = ("WITH ranked AS (" + rank + "), selected AS ("
                      "SELECT group_key, MIN(ordinal) AS first_ordinal FROM ranked GROUP BY group_key "
                      "ORDER BY first_ordinal LIMIT ? OFFSET ?) "
                      + "SELECT ranked.group_key," + columns + CLIP_FROM
                      + " JOIN ranked ON ranked.id=p.id JOIN selected ON selected.group_key=ranked.group_key"
                      + " ORDER BY selected.first_ordinal, ranked.ordinal")
        with self.connect() as con:
            con.execute("BEGIN")
            counts = con.execute(f"SELECT COUNT(*) AS clips, COUNT(DISTINCT {group_key}) AS groups"
                                 + CLIP_FROM + where, args).fetchone()
            rows = con.execute(page_query, [*args, page_size, (page-1)*page_size]).fetchall()
        groups, items = {}, []
        for row in rows:
            item = dict(row)
            key = item.pop('group_key')
            group = groups.setdefault(key, {'key': key, 'title': item['song_group'].strip() or item['display_song_title'],
                                            'count': 0, 'clip_ids': []})
            group['count'] += 1
            group['clip_ids'].append(item['id'])
            items.append(item if compact else self.clip_row(item))
        return {'groups': list(groups.values()), 'items': items, 'total': counts['groups'],
                'total_clips': counts['clips'], 'page': page, 'page_size': page_size}

    def listening_history(self):
        return self.all("SELECT h.last_played_at," + QUEUE_COLUMNS + CLIP_FROM +
                        " JOIN listening_history h ON h.clip_id=p.id "
                        "ORDER BY h.last_played_at DESC,p.id LIMIT 100")

    def record_listening(self, clip_id):
        timestamp = datetime.now(timezone.utc).isoformat(timespec='microseconds')
        with self.connect() as con:
            con.execute('BEGIN IMMEDIATE')
            row = con.execute("SELECT " + PLAYBACK_URL + CLIP_FROM + " WHERE p.id=?", (clip_id,)).fetchone()
            if row is None:
                raise KeyError(clip_id)
            if not row['playback_url']:
                raise ValueError('此片段当前不可播放。')
            con.execute('INSERT INTO listening_history(clip_id,last_played_at) VALUES(?,?) '
                        'ON CONFLICT(clip_id) DO UPDATE SET last_played_at=excluded.last_played_at', (clip_id,timestamp))
            con.execute('DELETE FROM listening_history WHERE clip_id NOT IN '
                        '(SELECT clip_id FROM listening_history ORDER BY last_played_at DESC,clip_id LIMIT 100)')
        return {'saved': True}

    def clip(self, clip_id):
        row = self.one(CLIP_SELECT + " WHERE p.id=?", (clip_id,))
        if not row:
            return None
        row = self.clip_row(row)
        row["sources"] = self.all("SELECT s.id,s.display_name,s.source_type,s.canonical_url FROM sources s JOIN memberships m ON m.source_id=s.id WHERE m.video_bvid=?", (row["video_bvid"],))
        row['songlist_credits'] = self.all('SELECT cs.song_title,cs.original_artist,cs.language,cs.style,cs.fetched_at,s.canonical_url FROM curated_songs cs JOIN sources s ON s.id=cs.source_id WHERE cs.bvid=?', (row['video_bvid'],))
        return row

    def saved_queue(self, clip_ids, *, compact=False):
        if not clip_ids:
            return []
        select = QUEUE_SELECT if compact else CLIP_SELECT
        # json_each accepts the entire saved queue as one parameter, including
        # lists larger than SQLite's variable limit. Read duplicates just once.
        rows = self.all(select + f" WHERE {PLAYABLE} AND p.id IN (SELECT value FROM json_each(?))",
                        (encode(clip_ids),))
        by_id = {row['id']: row if compact else self.clip_row(row) for row in rows}
        return [by_id[clip_id] for clip_id in clip_ids if clip_id in by_id]

    def playback_queue(self, sort='newest', **filters):
        where, args = self.filters(**filters)
        order = clip_order(sort)
        return self.all(QUEUE_SELECT + where + f' ORDER BY {order}', args)

    def resolve_playlist_links(self, links):
        targets = {}
        invalid = duplicates = 0
        for link in links:
            reference = video_reference(link)
            if reference is None or reference[1] == 0:
                invalid += 1
                continue
            bvid, part = reference
            target = (bvid, part or 1)
            if target in targets:
                duplicates += 1
            else:
                targets[target] = None

        found = set()
        playable = {}
        if targets:
            # Start with the requested pairs and use the existing per-video index.
            # A previously archived CID can share a part number with its replacement.
            sql = ("SELECT requested.key AS ordinal," + QUEUE_COLUMNS
                   + " FROM json_each(?) requested CROSS JOIN parts p"
                   + " ON p.video_bvid=json_extract(requested.value,'$[0]')"
                   + " AND p.part_number=json_extract(requested.value,'$[1]')" + CLIP_JOINS)
            with self.connect() as con:
                for row in con.execute(sql, (encode(list(targets)),)):
                    ordinal = row["ordinal"]
                    found.add(ordinal)
                    if row["playback_url"]:
                        # Do not guess if an inconsistent catalog has two active CIDs.
                        if ordinal in playable:
                            playable[ordinal] = None
                        else:
                            item = dict(row)
                            del item["ordinal"]
                            playable[ordinal] = item
        items = [playable[index] for index in range(len(targets)) if playable.get(index)]
        return {"items": items, "invalid": invalid, "duplicates": duplicates,
                "missing": len(targets) - len(found), "unavailable": len(found) - len(items)}

    def playlists(self):
        return self.all('SELECT l.*,COUNT(i.clip_id) AS count FROM playlists l LEFT JOIN playlist_items i '
                        'ON i.playlist_id=l.id GROUP BY l.id ORDER BY l.updated_at DESC,l.id DESC')

    def playlist(self, playlist_id):
        result = self.one('SELECT * FROM playlists WHERE id=?', (playlist_id,))
        if not result:
            raise KeyError(playlist_id)
        result['items'] = self.all(QUEUE_SELECT +
            ' JOIN playlist_items pi ON pi.clip_id=p.id WHERE pi.playlist_id=? ORDER BY pi.position', (playlist_id,))
        return result

    def save_playlist(self, name=None, clip_ids=None, playlist_id=None):
        if name is not None:
            name = name.strip()
            if not 1 <= len(name) <= 80:
                raise ValueError('歌单名称需要 1–80 个字符。')
        with self.connect() as con:
            if playlist_id is None:
                if not name:
                    raise ValueError('请输入歌单名称。')
                playlist_id = con.execute('INSERT INTO playlists(name,created_at,updated_at) VALUES(?,?,?)',
                                          (name, now(), now())).lastrowid
            elif not con.execute('SELECT 1 FROM playlists WHERE id=?', (playlist_id,)).fetchone():
                raise KeyError(playlist_id)
            if name is not None:
                con.execute('UPDATE playlists SET name=? WHERE id=?', (name, playlist_id))
            if clip_ids is not None:
                ids = list(dict.fromkeys(clip_ids))
                missing = con.execute(
                    "SELECT 1 FROM json_each(?) requested "
                    "LEFT JOIN parts p ON p.id=requested.value WHERE p.id IS NULL LIMIT 1",
                    (encode(ids),),
                ).fetchone()
                if missing:
                    raise ValueError('歌单包含不存在的片段，请刷新列表。')
                con.execute('DELETE FROM playlist_items WHERE playlist_id=?', (playlist_id,))
                con.executemany('INSERT INTO playlist_items(playlist_id,clip_id,position) VALUES(?,?,?)',
                                [(playlist_id, clip_id, position) for position, clip_id in enumerate(ids)])
            con.execute('UPDATE playlists SET updated_at=? WHERE id=?', (now(), playlist_id))
        return self.playlist(playlist_id)

    def delete_playlist(self, playlist_id):
        with self.connect() as con:
            if not con.execute('DELETE FROM playlists WHERE id=?', (playlist_id,)).rowcount:
                raise KeyError(playlist_id)

    def annotate(self, ids, patch):
        with self.connect() as con:
            for clip_id in ids:
                previous = con.execute("SELECT manual_fields FROM annotations WHERE clip_id=?", (clip_id,)).fetchone()
                if not previous:
                    raise KeyError(clip_id)
                fields = set(json.loads(previous[0]))
                values = {k:v for k,v in patch.items() if k in {"display_song_title","inclusion_status","song_group"}}
                fields.update(values)
                if "inclusion_status" in values:
                    values["classification_reason"] = "用户手动确认"
                values["manual_fields"] = encode(sorted(fields))
                con.execute("UPDATE annotations SET " + ",".join(k + "=?" for k in values) + " WHERE clip_id=?", [*values.values(),clip_id])
                if "notes" in patch:
                    con.execute("INSERT INTO user_state(clip_id,notes) VALUES(?,?) ON CONFLICT(clip_id) DO UPDATE SET notes=excluded.notes", (clip_id,patch["notes"]))

    def bookmark(self, clip_id, value):
        if not self.clip(clip_id):
            raise KeyError(clip_id)
        self.execute("INSERT INTO user_state(clip_id,bookmarked) VALUES(?,?) ON CONFLICT(clip_id) DO UPDATE SET bookmarked=excluded.bookmarked", (clip_id,int(value)))

    def overview(self, compact=False):
        jobs = self.jobs(OVERVIEW_JOB_LIMIT)
        if compact:
            # Only the collector/resume endpoint needs the checkpoint traversal history.
            for job in jobs:
                for checkpoint in job['checkpoints'].values():
                    checkpoint.pop('seen', None)
                    checkpoint.pop('page_hashes', None)
        counts = self.one("""SELECT COUNT(*) AS entries,COUNT(DISTINCT p.video_bvid) AS submissions,
            SUM(a.inclusion_status='included') AS included,SUM(a.inclusion_status='needs_review') AS needs_review,
            SUM(a.inclusion_status='excluded') AS excluded,COUNT(DISTINCT NULLIF(a.song_group,'')) AS song_groups,
            SUM(COALESCE(u.bookmarked,0)) AS bookmarked
            FROM parts p JOIN annotations a ON p.id=a.clip_id LEFT JOIN user_state u ON p.id=u.clip_id WHERE p.active=1""")
        return {**{k: v or 0 for k,v in counts.items()}, "uploaders": self.all("SELECT uploader_uid AS uid,uploader_name AS name,COUNT(*) AS submissions FROM videos GROUP BY uploader_uid ORDER BY uploader_name"), "sources": self.sources(include_status=True, recent_jobs=jobs), "jobs": jobs}

    def job(self, job_id):
        row = self.one("SELECT * FROM sync_jobs WHERE id=?", (job_id,))
        return self.decode_job(row) if row else None

    @staticmethod
    def decode_job(row):
        for key in ("source_ids", "checkpoints", "errors"):
            row[key] = json.loads(row[key])
        return row

    def jobs(self, limit=20):
        return [self.decode_job(r) for r in self.all("SELECT * FROM sync_jobs ORDER BY (state IN ('queued','running')) DESC,heartbeat DESC,rowid DESC LIMIT ?", (limit,))]

    def save_job(self, job):
        self.execute("UPDATE sync_jobs SET state=?,checkpoints=?,processed=?,errors=?,finished_at=?,heartbeat=? WHERE id=?", (job["state"],encode(job["checkpoints"]),job["processed"],encode(job["errors"]),job.get("finished_at"),datetime.now(timezone.utc).isoformat(timespec="microseconds"),job["id"]))
