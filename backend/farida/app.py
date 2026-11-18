import asyncio
from collections import OrderedDict
from threading import Lock
import csv
import json
import secrets
import sqlite3
import tempfile
import webbrowser
from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.background import BackgroundTask

from .config import Settings
from . import __version__
from .resources import resource_root
from .auth import BilibiliLogin
from .db import Database, PLAYER_STATE_SQL
from .sync import Collector
from .lifetime import WindowLifetime
from .playback import Playback
from .player_state import PlayerState
from .backup import export_backup, restore_validated_backup, validate_backup, LIMIT


CatalogDate = AwareDatetime | date
CatalogSort = Literal["newest", "oldest", "title", "uploader", "discovered"]


def csv_cell(value):
    # Prefix values that a spreadsheet could interpret as a formula.
    text = str(value or "")
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else value


class CatalogCSVResponse(StreamingResponse):
    """Own the completed spool until the HTTP download finishes or disconnects."""

    def __init__(self, stream):
        self.stream = stream
        size = stream.tell()
        stream.seek(0)
        super().__init__(
            iter(lambda: stream.read(32 * 1024), ""), media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=farida-clips.csv", "Content-Length": str(size)},
        )

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.stream.close()


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceCreate(Model):
    display_name: str = Field(default="", max_length=120)
    url: str = Field(min_length=1,max_length=1000)
    singing_collection: bool = False


class SourceUpdate(Model):
    display_name: str | None = Field(default=None,min_length=1,max_length=120)
    url: str | None = Field(default=None,min_length=1,max_length=1000)
    enabled: bool | None = None
    singing_collection: bool | None = None


class Annotation(Model):
    inclusion_status: Literal["included","excluded","needs_review"] | None = None
    display_song_title: str | None = Field(default=None,min_length=1,max_length=500)
    song_group: str | None = Field(default=None,max_length=200)
    notes: str | None = Field(default=None,max_length=5000)


class BulkAnnotation(Model):
    ids: list[str] = Field(min_length=1,max_length=100)
    inclusion_status: Literal["included","excluded","needs_review"]


class Bookmark(Model):
    bookmarked: bool


class PlaylistLinks(Model):
    links: list[Annotated[str, Field(min_length=1, max_length=2048)]] = Field(min_length=1, max_length=20000)


class PlaylistCreate(Model):
    name: str = Field(min_length=1, max_length=80)
    clip_ids: list[str] = Field(default_factory=list, max_length=20000)


class PlaylistUpdate(Model):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    clip_ids: list[str] | None = Field(default=None, max_length=20000)


class PlayerProgress(Model):
    queue_key: str = Field(min_length=1, max_length=64)
    sequence: int = Field(gt=0, le=2**53-1)
    current_id: str = Field(min_length=1, max_length=100)
    position: float = Field(ge=0, le=86400, allow_inf_nan=False)
    segment: int = Field(ge=0, le=99)
    shuffle: bool
    repeat: Literal["off", "all", "one"]
    skip_unavailable: bool


class PlayerPreferences(Model):
    volume: float = Field(ge=0, le=1, allow_inf_nan=False)
    muted: bool
    compact: bool


class ListeningEvent(Model):
    clip_id: str = Field(min_length=1, max_length=100)


class SyncRequest(Model):
    source_ids: list[int] = Field(default_factory=list,max_length=100)
    mode: Literal["full","incremental"] = "incremental"


def create_app(settings=None, adapter_factory=None, browser_opener=None, *, scan_on_start=True, preview_mode=False, auth_transport=None, playback_transport=None, shutdown_callback=None, window_grace_seconds=5.0, browser_start_timeout=None):
    settings = settings or Settings.from_env()
    db = Database(settings.db_path)
    collector = Collector(db,settings,adapter_factory) if adapter_factory else Collector(db,settings)
    playback = Playback(settings, transport=playback_transport)
    async def before_account_change():
        await playback.clear()
        await collector.stop()
    login = BilibiliLogin(settings, transport=auth_transport, before_change=before_account_change)
    token = secrets.token_urlsafe(32)
    # Active page IDs bound reordered unload writes and are revoked on restore.
    preference_writers = OrderedDict()
    preference_lock = Lock()
    startup_pending = scan_on_start
    lifetime = WindowLifetime(shutdown_callback, grace_seconds=window_grace_seconds,
                              startup_timeout=browser_start_timeout) if shutdown_callback and not preview_mode else None

    def start_update_locked():
        # Called under login.lock. A successful login releases exactly one
        # startup update, even when multiple tabs confirm or check together.
        nonlocal startup_pending
        if not startup_pending or (not preview_mode and login.status()['state'] != 'connected'):
            return
        startup_pending = False
        if any(source['enabled'] for source in db.sources()):
            collector.start([], 'incremental')

    async def initialize_account():
        async with login.lock:
            if not preview_mode:
                await login.check_locked()
            start_update_locked()

    async def release_startup_update():
        async with login.lock:
            start_update_locked()

    async def require_login_locked():
        if not preview_mode and (await login.check_locked())['state'] != 'connected':
            raise HTTPException(401, '请先登录哔哩哔哩并验证登录状态，再开始采集。')

    @asynccontextmanager
    async def lifespan(app):
        db.initialize()
        # Keep the UI available while validating a saved session. No source
        # request is made until login has been verified.
        startup = app.state.startup_task = asyncio.create_task(initialize_account())
        if lifetime:
            lifetime.start()
        try:
            yield
        finally:
            await playback.clear()
            if lifetime:
                await lifetime.close()
            startup.cancel()
            try:
                await startup
            except asyncio.CancelledError:
                pass
            await collector.close()
            await login.close()

    app = FastAPI(title="法里达 · 歌切收藏", version=__version__, lifespan=lifespan)
    app.state.db,app.state.collector = db,collector
    app.state.login = login
    app.state.playback = playback
    app.state.window_lifetime = lifetime
    app.add_middleware(TrustedHostMiddleware,allowed_hosts=["127.0.0.1","localhost","[::1]","testserver"])

    @app.middleware("http")
    async def local_access(request: Request, call_next):
        if request.method in {"POST","PATCH","PUT","DELETE"}:
            origin = request.headers.get("origin")
            if origin and urlsplit(origin).netloc != request.headers.get("host"):
                return JSONResponse({"detail":"不允许其他网站修改本地数据"},status_code=403)
            if request.headers.get("x-farida-token") != token:
                return JSONResponse({"detail":"本地服务已重启，请刷新页面后再操作"},status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        socket_origin = f"{'wss' if request.url.scheme == 'https' else 'ws'}://{request.url.netloc}"
        response.headers["Content-Security-Policy"] = f"default-src 'self'; img-src 'self' data: blob: https://*.hdslb.com; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' {socket_origin}; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(ValueError)
    async def value_error(request,exc):
        return JSONResponse({"detail":str(exc)},status_code=400)

    @app.exception_handler(KeyError)
    async def missing(request,exc):
        return JSONResponse({"detail":"未找到此记录"},status_code=404)

    @app.exception_handler(sqlite3.IntegrityError)
    async def conflict(request,exc):
        return JSONResponse({"detail":"此来源已存在，或另一个采集任务正在运行"},status_code=409)

    @app.get("/api/health")
    def health():
        return {"status":"stopping" if lifetime and lifetime.stopped else "ok","application":"farida-song-browser","version":__version__}

    @app.get("/api/session")
    def session():
        return {"token":token,"request_interval":settings.request_interval,"discovery_pages":settings.discovery_pages,"incremental_pages":settings.incremental_pages,"preview_mode":preview_mode,"can_shutdown":lifetime is not None,"close_with_page":lifetime is not None,"close_grace_seconds":window_grace_seconds}

    @app.websocket('/api/window')
    async def app_window(websocket: WebSocket):
        origin = urlsplit(websocket.headers.get('origin', ''))
        expected_scheme = 'https' if websocket.url.scheme == 'wss' else 'http'
        if not lifetime or origin.scheme != expected_scheme or origin.netloc != websocket.headers.get('host'):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        window = None
        try:
            # Keep the local token out of URLs and accept only same-origin
            # app documents. This endpoint also works on the login screen.
            hello = await asyncio.wait_for(websocket.receive_json(), timeout=5)
            supplied = hello.get('token') if isinstance(hello, dict) else None
            if not isinstance(supplied, str) or not secrets.compare_digest(supplied.encode(), token.encode()):
                await websocket.close(code=1008)
                return
            window = lifetime.connect()
            if window is None:
                await websocket.close(code=1001)
                return
            await websocket.send_json({'state': 'connected'})
            while (await websocket.receive())['type'] != 'websocket.disconnect':
                pass
        except WebSocketDisconnect:
            pass
        except asyncio.TimeoutError:
            await websocket.close(code=1008)
        except (ValueError, KeyError, TypeError):
            await websocket.close(code=1008)
        finally:
            if window is not None:
                lifetime.disconnect(window)

    @app.post("/api/shutdown")
    async def shutdown():
        if lifetime is None:
            raise HTTPException(409, "当前启动方式不支持从页面退出应用。")
        # Send the response before stopping the server. Its lifespan cleanup
        # closes the collector and login clients, keeping committed progress.
        return JSONResponse({"status": "stopping"}, background=BackgroundTask(lifetime.shutdown))

    @app.get("/api/overview")
    def overview(compact: bool=False):
        return db.overview(compact=compact)

    def real_login_only():
        if preview_mode:
            raise HTTPException(409, '当前为演示预览，请用 Start Farida.cmd 打开正式应用后登录。')

    @app.get('/api/auth')
    async def auth_status():
        if preview_mode:
            return {'state': 'preview', 'stored': False, 'account': None, 'message': '演示预览不连接账号，请在正式应用中扫码登录。'}
        return login.status()

    @app.post('/api/auth/qr')
    async def auth_start(observer: UUID | None=None):
        real_login_only()
        return await login.start(observer)

    @app.post('/api/auth/qr/{attempt_id}/poll')
    async def auth_poll(attempt_id: str):
        real_login_only()
        result = await login.poll(attempt_id)
        await release_startup_update()
        return result

    @app.post('/api/auth/qr/{attempt_id}/cancel')
    async def auth_cancel(attempt_id: str):
        real_login_only()
        return await login.cancel(attempt_id)

    @app.post('/api/auth/check')
    async def auth_check():
        real_login_only()
        result = await login.check()
        await release_startup_update()
        return result

    @app.post('/api/auth/logout')
    async def auth_logout():
        real_login_only()
        return await login.logout()

    @app.get("/api/clips")
    def clips(q: str="",status: Literal["included","excluded","needs_review","all"]="included",source_id: int | None=None,uploader: str | None=None,after: CatalogDate | None=None,before: CatalogDate | None=None,bookmarked: bool=False,sort: CatalogSort="newest",page: int=1,page_size: int=40,grouped: bool=False,compact: bool=False):
        if page < 1 or not 1 <= page_size <= 100 or len(q)>500:
            raise ValueError("分页、日期范围或搜索参数无效")
        query = db.grouped_clips if grouped else db.clips
        return query(q=q,status=status,source_id=source_id,uploader=uploader,after=after,before=before,bookmarked=bookmarked,sort=sort,page=page,page_size=page_size,compact=compact)

    @app.get('/api/play-queue')
    def play_queue(q: str='', status: Literal['included','excluded','needs_review','all']='included', source_id: int | None=None,
                   uploader: str | None=None, after: CatalogDate | None=None, before: CatalogDate | None=None, bookmarked: bool=False,
                   sort: CatalogSort='newest'):
        if len(q) > 500:
            raise ValueError('日期范围或搜索参数无效')
        return {'items': db.playback_queue(q=q, status=status, source_id=source_id, uploader=uploader,
                                          after=after, before=before, bookmarked=bookmarked, sort=sort)}

    @app.get('/api/listening-history')
    def listening_history():
        return {'items': db.listening_history()}

    @app.post('/api/listening-history')
    def record_listening(body: ListeningEvent):
        return db.record_listening(body.clip_id)

    @app.delete('/api/listening-history')
    def clear_listening_history():
        db.execute('DELETE FROM listening_history')
        return {'cleared': True}

    @app.get('/api/playlists')
    def playlists():
        return {'items': db.playlists()}

    @app.post('/api/playlists', status_code=201)
    def create_playlist(body: PlaylistCreate):
        return db.save_playlist(body.name, body.clip_ids)

    @app.post('/api/playlists/resolve-links')
    def resolve_playlist_links(body: PlaylistLinks):
        return db.resolve_playlist_links(body.links)

    @app.get('/api/playlists/{playlist_id}')
    def get_playlist(playlist_id: int):
        return db.playlist(playlist_id)

    @app.patch('/api/playlists/{playlist_id}')
    def edit_playlist(playlist_id: int, body: PlaylistUpdate):
        return db.save_playlist(body.name, body.clip_ids, playlist_id)

    @app.delete('/api/playlists/{playlist_id}')
    def remove_playlist(playlist_id: int):
        db.delete_playlist(playlist_id)
        return {'deleted': True}

    @app.post('/api/clips/{clip_id}/play')
    async def play_clip(clip_id: str, request: Request):
        if preview_mode:
            raise HTTPException(409, '预览数据仅作演示，请打开正式应用播放已采集的视频。')
        async with login.lock:
            if await request.is_disconnected():
                return Response(status_code=499)
            if login.status()['state'] != 'connected':
                raise HTTPException(401, '请先验证哔哩哔哩登录后播放。', headers={'X-Farida-Error': 'authentication'})
            clip = db.clip(clip_id)
            if not clip:
                raise KeyError(clip_id)
            return await playback.prepare(clip)

    @app.get('/api/playback/status/{key}')
    def playback_failure_status(key: str):
        return playback.failure_status(key)

    @app.get('/api/playback/media/{key}')
    async def play_media(key: str, request: Request):
        origin = request.headers.get('origin')
        if request.headers.get('sec-fetch-site') == 'cross-site' or (origin and origin != str(request.base_url).rstrip('/')):
            raise HTTPException(403, '请在应用页面内播放。')
        return await playback.stream(key, request.headers.get('range'))

    @app.get("/api/clips/{clip_id}")
    def clip(clip_id: str):
        result = db.clip(clip_id)
        if not result:
            raise KeyError(clip_id)
        return result

    @app.patch("/api/clips/{clip_id}/annotation")
    def annotation(clip_id: str, body: Annotation):
        db.annotate([clip_id],body.model_dump(exclude_none=True))
        return db.clip(clip_id)

    @app.patch("/api/review/bulk")
    def bulk_annotation(body: BulkAnnotation):
        db.annotate(body.ids,{"inclusion_status":body.inclusion_status})
        return {"updated":len(body.ids)}

    @app.patch("/api/clips/{clip_id}/bookmark")
    def bookmark(clip_id: str, body: Bookmark):
        db.bookmark(clip_id,body.bookmarked)
        return {"bookmarked":body.bookmarked}

    @app.post("/api/clips/{clip_id}/open")
    async def open_clip(clip_id: str):
        entry = db.clip(clip_id)
        if not entry:
            raise KeyError(clip_id)
        if not entry["playback_url"]:
            raise HTTPException(409,"此视频或分 P 当前不可用，请刷新来源")
        opener = browser_opener or webbrowser.open_new_tab
        try:
            opened = await asyncio.to_thread(opener,entry["playback_url"])
        except Exception:
            opened = False
        return {"opened":bool(opened),"url":entry["playback_url"]}

    @app.get("/api/sources")
    def sources():
        return db.sources()

    @app.get("/api/sources/{source_id}/missing-links")
    def missing_links(source_id: int, after_id: int=0, limit: int=40):
        return db.missing_songlist_links(source_id, after_id, limit)

    @app.post("/api/sources",status_code=201)
    def add_source(body: SourceCreate):
        return db.add_source(body.display_name,body.url,body.singing_collection)

    @app.patch("/api/sources/{source_id}")
    def update_source(source_id: int,body: SourceUpdate):
        if any(job["state"] in {"queued","running"} and source_id in job["source_ids"] for job in db.jobs()):
            raise HTTPException(409,"请先取消此来源的采集任务，再修改设置")
        return db.update_source(source_id,body.model_dump(exclude_none=True))

    @app.post("/api/sync",status_code=202)
    async def sync(body: SyncRequest):
        nonlocal startup_pending
        async with login.lock:
            await require_login_locked()
            job = collector.start(body.source_ids,body.mode)
            startup_pending = False
            return job

    @app.get("/api/sync")
    def jobs():
        return db.jobs()

    @app.get("/api/sync/{job_id}")
    def job(job_id: str):
        result = db.job(job_id)
        if not result:
            raise KeyError(job_id)
        return result

    @app.post("/api/sync/{job_id}/cancel")
    async def cancel(job_id: str):
        return collector.cancel(job_id)

    @app.post("/api/sync/{job_id}/resume",status_code=202)
    async def resume(job_id: str):
        nonlocal startup_pending
        async with login.lock:
            await require_login_locked()
            job = collector.resume(job_id)
            startup_pending = False
            return job

    @app.get("/api/export")
    def export(format: Literal["json","csv"]="csv",q: str="",status: Literal["included","excluded","needs_review","all"]="included",source_id: int | None=None,uploader: str | None=None,after: CatalogDate | None=None,before: CatalogDate | None=None,bookmarked: bool=False,sort: CatalogSort="newest"):
        if len(q)>500:
            raise ValueError("无效的筛选条件")
        filters = dict(q=q, status=status, source_id=source_id, uploader=uploader,
                       after=after, before=before, bookmarked=bookmarked, sort=sort)
        if format == "json":
            entries = db.clips(**filters, page_size=2147483647)["items"]
            return JSONResponse(entries,headers={"Content-Disposition":"attachment; filename=farida-clips.json"})
        stream = tempfile.SpooledTemporaryFile(max_size=256 * 1024, mode="w+", encoding="utf-8", newline="")
        try:
            stream.write("\ufeff")
            writer = csv.writer(stream)
            writer.writerow(("display_song_title", "raw_title", "uploader_name", "published_at", "video_bvid",
                             "cid", "part_number", "playback_url", "inclusion_status", "songlist_attribution",
                             "songlist_url"))
            with db.csv_rows(**filters) as rows:
                for row in rows:
                    writer.writerow(csv_cell(value) for value in row)
            return CatalogCSVResponse(stream)
        except BaseException:
            stream.close()
            raise

    @app.get("/api/player-state")
    def player_state(compact: bool = False):
        with preference_lock:
            row = db.one(PLAYER_STATE_SQL)
            writer = None
            if compact:
                writer = secrets.token_urlsafe(16)
                preference_writers[writer] = {}
                if len(preference_writers) > 512:
                    preference_writers.popitem(last=False)
        saved = PlayerState.model_validate_json(row["value"]) if row else PlayerState()
        result = {**saved.model_dump(), "items": db.saved_queue(saved.clip_ids, compact=compact)}
        if writer:
            result["preference_writer"] = writer
        return result

    @app.put("/api/player-state")
    def save_player_state(body: PlayerState, request: Request):
        queue_key = secrets.token_urlsafe(16)
        writer = request.headers.get("X-Farida-Preference-Writer")
        with preference_lock, db.connect() as con:
            if writer is not None:
                if writer not in preference_writers:
                    raise HTTPException(409, "本机数据已恢复或页面已过期，请刷新页面。")
                # This page sends preferences separately. A delayed initial queue
                # write must preserve a newer compact/volume change, even across tabs.
                con.execute("BEGIN IMMEDIATE")
                row = con.execute("SELECT value FROM playback_state WHERE id=1").fetchone()
                latest = PlayerState.model_validate_json(row['value']) if row else PlayerState()
                body = body.model_copy(update=latest.model_dump(include={'volume','muted','compact'}))
            con.execute("INSERT INTO playback_state(id,value) VALUES(1,?) "
                        "ON CONFLICT(id) DO UPDATE SET value=excluded.value", (body.model_dump_json(),))
            con.execute("INSERT OR REPLACE INTO playback_progress(id,queue_key,sequence,value) "
                        "VALUES(1,?,0,'{}')", (queue_key,))
        return {"saved": True, "queue_key": queue_key}

    @app.patch('/api/player-state')
    def save_player_progress(body: PlayerProgress):
        checkpoint = body.model_dump_json(exclude={'queue_key', 'sequence'})
        # A delayed page-close request must not replace a newer checkpoint or another queue.
        with db.connect() as con:
            result = con.execute("UPDATE playback_progress SET sequence=?,value=? "
                                 "WHERE id=1 AND queue_key=? AND sequence<?",
                                 (body.sequence, checkpoint, body.queue_key, body.sequence))
            return {'saved': result.rowcount == 1}

    @app.patch('/api/player-preferences')
    def save_player_preferences(body: PlayerPreferences, request: Request):
        writer = request.headers.get('X-Farida-Preference-Writer')
        sequence = request.headers.get('X-Farida-Preference-Sequence', '')
        if writer is not None and not (sequence.isascii() and sequence.isdigit() and 1 <= len(sequence) <= 16):
            raise HTTPException(422, '无效的播放器设置序号。')
        values = body.model_dump()
        if writer is not None:
            fields = set(request.headers.get('X-Farida-Preference-Fields', 'volume,muted,compact').split(','))
            if not fields.issubset(values):
                raise HTTPException(422, '无效的播放器设置字段。')
        with preference_lock:
            if writer is not None:
                revisions = preference_writers.get(writer)
                if revisions is None:
                    return {'saved': False}
                values = {key: values[key] for key in fields if int(sequence) > revisions.get(key, 0)}
                if not values:
                    return {'saved': False}
            with db.connect() as con:
                con.execute('BEGIN IMMEDIATE')
                row = con.execute('SELECT value FROM playback_state WHERE id=1').fetchone()
                saved = PlayerState.model_validate_json(row['value']) if row else PlayerState()
                updated = saved.model_copy(update=values)
                con.execute('INSERT INTO playback_state(id,value) VALUES(1,?) '
                            'ON CONFLICT(id) DO UPDATE SET value=excluded.value', (updated.model_dump_json(),))
            if writer is not None:
                revisions.update(dict.fromkeys(values, int(sequence)))
                preference_writers.move_to_end(writer)
        return {'saved': True}

    @app.get("/api/backup")
    def backup():
        return JSONResponse(export_backup(db), headers={"Content-Disposition": "attachment; filename=farida-backup.json"})

    @app.post("/api/restore")
    async def restore(request: Request):
        nonlocal startup_pending
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > LIMIT:
                raise HTTPException(413, "备份超过 64 MB。")
            raw.extend(chunk)
        try:
            data = json.loads(raw)
            del raw
            # Keep the current collection and playback active during the offline import check.
            data = await asyncio.to_thread(validate_backup, data)
            async with login.lock:
                startup_pending = False
                await collector.stop()
                await playback.clear()
                with preference_lock:
                    safety = restore_validated_backup(db, data)
                    preference_writers.clear()
            return {"restored": True, "safety_backup": safety}
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError, sqlite3.DatabaseError) as error:
            raise HTTPException(400, "备份无效，未恢复数据。请检查文件格式。") from error

    frontend = resource_root() / "frontend"
    app.mount("/",StaticFiles(directory=frontend,html=True),name="frontend")
    return app
