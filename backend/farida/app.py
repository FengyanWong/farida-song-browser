import asyncio
import csv
import io
import secrets
import sqlite3
import webbrowser
from contextlib import asynccontextmanager
from datetime import date
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.background import BackgroundTask

from .config import Settings
from . import __version__
from .resources import resource_root
from .auth import BilibiliLogin
from .db import Database
from .sync import Collector


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


class SyncRequest(Model):
    source_ids: list[int] = Field(default_factory=list,max_length=100)
    mode: Literal["full","incremental"] = "incremental"


def create_app(settings=None, adapter_factory=None, browser_opener=None, *, scan_on_start=True, preview_mode=False, auth_transport=None, shutdown_callback=None):
    settings = settings or Settings.from_env()
    db = Database(settings.db_path)
    collector = Collector(db,settings,adapter_factory) if adapter_factory else Collector(db,settings)
    login = BilibiliLogin(settings, transport=auth_transport, before_change=collector.stop)
    token = secrets.token_urlsafe(32)
    startup_pending = scan_on_start

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
        try:
            yield
        finally:
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
        response.headers["Content-Security-Policy"] = "default-src 'self'; img-src 'self' data: blob: https://*.hdslb.com; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
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
        return {"status":"ok","application":"farida-song-browser","version":__version__}

    @app.get("/api/session")
    def session():
        return {"token":token,"request_interval":settings.request_interval,"discovery_pages":settings.discovery_pages,"incremental_pages":settings.incremental_pages,"preview_mode":preview_mode,"can_shutdown":shutdown_callback is not None and not preview_mode}

    @app.post("/api/shutdown")
    async def shutdown():
        if shutdown_callback is None or preview_mode:
            raise HTTPException(409, "当前启动方式不支持从页面退出应用。")
        # Send the response before stopping the server. Its lifespan cleanup
        # closes the collector and login clients, keeping committed progress.
        return JSONResponse({"status": "stopping"}, background=BackgroundTask(shutdown_callback))

    @app.get("/api/overview")
    def overview():
        return db.overview()

    def real_login_only():
        if preview_mode:
            raise HTTPException(409, '当前为演示预览，请用 Start Farida.cmd 打开正式应用后登录。')

    @app.get('/api/auth')
    async def auth_status():
        if preview_mode:
            return {'state': 'preview', 'stored': False, 'account': None, 'message': '演示预览不连接账号，请在正式应用中扫码登录。'}
        return login.status()

    @app.post('/api/auth/qr')
    async def auth_start():
        real_login_only()
        return await login.start()

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
    def clips(q: str="",status: Literal["included","excluded","needs_review","all"]="included",source_id: int | None=None,uploader: str | None=None,after: date | None=None,before: date | None=None,bookmarked: bool=False,sort: Literal["newest","oldest","title","uploader"]="newest",page: int=1,page_size: int=40):
        if page < 1 or not 1 <= page_size <= 100 or len(q)>500 or (after and before and after>before):
            raise ValueError("分页、日期范围或搜索参数无效")
        return db.clips(q=q,status=status,source_id=source_id,uploader=uploader,after=after,before=before,bookmarked=bookmarked,sort=sort,page=page,page_size=page_size)

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
    def export(format: Literal["json","csv"]="csv",q: str="",status: Literal["included","excluded","needs_review","all"]="included",source_id: int | None=None,uploader: str | None=None,after: date | None=None,before: date | None=None,bookmarked: bool=False,sort: Literal["newest","oldest","title","uploader"]="newest"):
        if len(q)>500 or (after and before and after>before):
            raise ValueError("无效的筛选条件")
        # The same query covers the complete stored selection, not just the UI page.
        entries = db.clips(q=q,status=status,source_id=source_id,uploader=uploader,after=after,before=before,bookmarked=bookmarked,sort=sort,page_size=2147483647)["items"]
        if format == "json":
            return JSONResponse(entries,headers={"Content-Disposition":"attachment; filename=farida-clips.json"})
        output = io.StringIO()
        writer = csv.writer(output)
        keys = ["display_song_title","raw_title","uploader_name","published_at","video_bvid","cid","part_number","playback_url","inclusion_status","songlist_attribution","songlist_url"]
        writer.writerow(keys)
        for entry in entries:
            # Prevent spreadsheet formula execution from upstream/user titles.
            writer.writerow([("'" + str(entry.get(k) or "")) if str(entry.get(k) or "").lstrip().startswith(("=","+","-","@","\t","\r")) else entry.get(k) for k in keys])
        return Response("\ufeff"+output.getvalue(),media_type="text/csv; charset=utf-8",headers={"Content-Disposition":"attachment; filename=farida-clips.csv"})

    frontend = resource_root() / "frontend"
    app.mount("/",StaticFiles(directory=frontend,html=True),name="frontend")
    return app
