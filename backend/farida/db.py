import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .adapter import parse_source, validated_video, video_has_uploader
from .classifier import classify, normalize
from .songlist import URL as SONGLIST_URL


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

CLIP_SELECT = """SELECT p.*,(SELECT COUNT(*) FROM parts siblings WHERE siblings.video_bvid=p.video_bvid AND siblings.active=1) AS part_count,
 v.uploader_uid,v.uploader_name,v.raw_title,v.description,v.tags,
 v.thumbnail_url,v.published_at,v.availability_status,v.verification_status,v.statistics,
 v.stats_fetched_at,v.stats_scope,v.fetched_at,v.provenance,
 a.display_song_title,a.song_group,a.inclusion_status,a.classification_reason,a.classification_version,a.manual_fields,
 COALESCE(u.bookmarked,0) AS bookmarked,COALESCE(u.notes,'') AS notes,
 EXISTS(SELECT 1 FROM curated_songs cs WHERE cs.bvid=v.bvid) AS has_curated_credit
 FROM parts p JOIN videos v ON v.bvid=p.video_bvid JOIN annotations a ON a.clip_id=p.id
 LEFT JOIN user_state u ON u.clip_id=p.id """


class Database:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def connect(self):
        con = sqlite3.connect(self.path, timeout=15)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        con.create_function("fold", 1, normalize, deterministic=True)
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

    def sources(self):
        rows = self.all("""SELECT s.*, (SELECT COUNT(*) FROM memberships m WHERE m.source_id=s.id) AS submissions,
            (SELECT COUNT(*) FROM memberships m JOIN parts p ON p.video_bvid=m.video_bvid WHERE m.source_id=s.id AND p.active=1) AS entries,
            (SELECT COUNT(*) FROM curated_songs cs WHERE cs.source_id=s.id) AS listed_songs,
            (SELECT COUNT(DISTINCT bvid) FROM curated_songs cs WHERE cs.source_id=s.id) AS linked_songs,
            (SELECT MAX(fetched_at) FROM curated_songs cs WHERE cs.source_id=s.id) AS list_fetched_at
            FROM sources s ORDER BY s.id""")
        for row in rows:
            row["required_tags"] = json.loads(row["required_tags"])
            row["last_error"] = json.loads(row["last_error"]) if row["last_error"] else None
        return rows

    def source(self, source_id):
        return next((s for s in self.sources() if s["id"] == source_id), None)

    def add_source(self, name, url, singing_collection=False):
        fields = parse_source(url)
        if fields["source_type"] == "uploader":
            singing_collection = False
        source_id = self.execute("INSERT INTO sources(source_type,display_name,uid,collection_id,canonical_url,singing_collection,created_at) VALUES(?,?,?,?,?,?,?)", (fields["source_type"],name or fields["uid"],fields["uid"],fields["collection_id"],fields["canonical_url"],int(singing_collection),now()))
        return self.source(source_id)

    def update_source(self, source_id, patch):
        source = self.source(source_id)
        if not source:
            raise KeyError(source_id)
        if "url" in patch:
            fields = parse_source(patch.pop("url"))
            patch.update(fields)
            patch.update(verification_status="pending", verified_uid=None, resolved_name=None, verification_method=None,
                         last_complete_scan_at=None, last_refresh_at=None, last_discovery_at=None, last_error=None)
            # A changed source retains cached video/user data but gets fresh memberships.
            with self.connect() as con:
                con.execute("DELETE FROM memberships WHERE source_id=?", (source_id,))
                con.execute("UPDATE sources SET " + ",".join(k + "=?" for k in patch) + " WHERE id=?", [*patch.values(),source_id])
        elif patch:
            self.execute("UPDATE sources SET " + ",".join(k + "=?" for k in patch) + " WHERE id=?", [*patch.values(),source_id])
        return self.source(source_id)

    def verified_source(self, source_id, identity):
        self.execute("UPDATE sources SET resolved_name=?,verified_uid=?,verification_status='verified',verification_method=?,last_error=NULL WHERE id=?", (identity["name"],identity["uid"],identity["method"],source_id))

    def save_songlist(self, source, rows):
        stamp = now()
        with self.connect() as con:
            con.execute('DELETE FROM curated_songs WHERE source_id=?', (source['id'],))
            con.executemany('INSERT INTO curated_songs(source_id,id,song_title,original_artist,language,style,bvid,fetched_at) VALUES(?,?,?,?,?,?,?,?)',
                            [(source['id'], row['id'], row['song_title'], row['original_artist'], row['language'], row['style'], row['bvid'], stamp)
                             for row in rows])

    def save_video(self, source, data, tags, cached=None):
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
        return len(data["pages"])

    def reuse_video(self, source, video):
        # Reclassification and a new membership are not a fresh upstream retrieval.
        self.save_video(source, json.loads(video["raw_metadata"]), json.loads(video["tags"]), cached=video)

    def filters(self, q="", status="included", source_id=None, uploader=None, after=None, before=None, bookmarked=False, **_):
        clauses, args = ["p.active=1"], []
        if status != "all":
            clauses.append("a.inclusion_status=?")
            args.append(status)
        if q:
            folded = normalize(q).replace("farida", "法里达")
            folded = folded.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            clauses.append("replace(fold(a.display_song_title || ' ' || a.song_group || ' ' || v.raw_title || ' ' || p.raw_part_title || ' ' || v.uploader_name || ' ' || v.tags),'farida','法里达') LIKE ? ESCAPE '\\'")
            args.append("%" + folded + "%")
        if source_id:
            clauses.append("EXISTS(SELECT 1 FROM memberships m WHERE m.video_bvid=v.bvid AND m.source_id=?)")
            args.append(source_id)
        if uploader:
            clauses.append("v.uploader_uid=?")
            args.append(uploader)
        if after:
            clauses.append("v.published_at>=?")
            args.append(str(after) + "T00:00:00+00:00")
        if before:
            clauses.append("v.published_at<=?")
            args.append(str(before) + "T23:59:59+00:00")
        if bookmarked:
            clauses.append("u.bookmarked=1")
        return " WHERE " + " AND ".join(clauses), args

    @staticmethod
    def clip_row(row):
        for key in ("tags","statistics","provenance","manual_fields"):
            row[key] = json.loads(row[key])
        row["playback_url"] = f"https://www.bilibili.com/video/{row['video_bvid']}/?p={row['part_number']}" if row["active"] and row["verification_status"] == "verified" and row["availability_status"] == "available" else None
        row['songlist_attribution'] = 'CLANNADOR' if row['has_curated_credit'] else ''
        row['songlist_url'] = SONGLIST_URL if row['has_curated_credit'] else ''
        return row

    def clips(self, page=1, page_size=40, sort="newest", **filters):
        where,args = self.filters(**filters)
        order = {"newest": "v.published_at DESC", "oldest": "v.published_at ASC", "title": "fold(a.display_song_title) ASC", "uploader": "fold(v.uploader_name) ASC"}[sort]
        with self.connect() as con:
            total = con.execute("SELECT COUNT(*) FROM (" + CLIP_SELECT + where + ")", args).fetchone()[0]
            rows = con.execute(CLIP_SELECT + where + f" ORDER BY {order},p.video_bvid,p.part_number LIMIT ? OFFSET ?", [*args,page_size,(page-1)*page_size]).fetchall()
        return {"items": [self.clip_row(dict(row)) for row in rows], "total": total, "page": page, "page_size": page_size}

    def clip(self, clip_id):
        row = self.one(CLIP_SELECT + " WHERE p.id=?", (clip_id,))
        if not row:
            return None
        row = self.clip_row(row)
        row["sources"] = self.all("SELECT s.id,s.display_name,s.source_type,s.canonical_url FROM sources s JOIN memberships m ON m.source_id=s.id WHERE m.video_bvid=?", (row["video_bvid"],))
        row['songlist_credits'] = self.all('SELECT cs.song_title,cs.original_artist,cs.language,cs.style,cs.fetched_at,s.canonical_url FROM curated_songs cs JOIN sources s ON s.id=cs.source_id WHERE cs.bvid=?', (row['video_bvid'],))
        return row

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

    def overview(self):
        counts = self.one("""SELECT COUNT(*) AS entries,COUNT(DISTINCT p.video_bvid) AS submissions,
            SUM(a.inclusion_status='included') AS included,SUM(a.inclusion_status='needs_review') AS needs_review,
            SUM(a.inclusion_status='excluded') AS excluded,COUNT(DISTINCT NULLIF(a.song_group,'')) AS song_groups,
            SUM(COALESCE(u.bookmarked,0)) AS bookmarked
            FROM parts p JOIN annotations a ON p.id=a.clip_id LEFT JOIN user_state u ON p.id=u.clip_id WHERE p.active=1""")
        return {**{k: v or 0 for k,v in counts.items()}, "uploaders": self.all("SELECT uploader_uid AS uid,uploader_name AS name,COUNT(*) AS submissions FROM videos GROUP BY uploader_uid ORDER BY uploader_name"), "sources": self.sources(), "jobs": self.jobs(10)}

    def job(self, job_id):
        row = self.one("SELECT * FROM sync_jobs WHERE id=?", (job_id,))
        return self.decode_job(row) if row else None

    @staticmethod
    def decode_job(row):
        for key in ("source_ids", "checkpoints", "errors"):
            row[key] = json.loads(row[key])
        return row

    def jobs(self, limit=20):
        return [self.decode_job(r) for r in self.all("SELECT * FROM sync_jobs ORDER BY started_at DESC,rowid DESC LIMIT ?", (limit,))]

    def save_job(self, job):
        self.execute("UPDATE sync_jobs SET state=?,checkpoints=?,processed=?,errors=?,finished_at=?,heartbeat=? WHERE id=?", (job["state"],encode(job["checkpoints"]),job["processed"],encode(job["errors"]),job.get("finished_at"),now(),job["id"]))
