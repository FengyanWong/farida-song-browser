import asyncio
import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone

from .adapter import BilibiliAdapter, UpstreamError, video_has_uploader
from .db import encode, now


class Cancelled(Exception):
    pass


class Collector:
    """One worker globally. Every verified video and checkpoint is committed separately."""
    def __init__(self, db, settings, adapter_factory=BilibiliAdapter):
        self.db, self.settings, self.adapter_factory = db, settings, adapter_factory
        self.task = None
        self._interruptible_job = None

    def start(self, source_ids, mode):
        if self.task and not self.task.done():
            raise ValueError("已有采集任务正在运行")
        if not source_ids:
            source_ids = [s["id"] for s in self.db.sources() if s["enabled"]]
        source_ids = list(dict.fromkeys(source_ids))
        if not source_ids:
            raise ValueError("请先启用至少一个来源")
        for source_id in source_ids:
            source = self.db.source(source_id)
            if not source or not source["enabled"]:
                raise ValueError("所选来源不存在或已停用")
        checkpoints = {str(sid): {"page":1,"seen":[],"page_hashes":{},"state":"pending",
                       "processed":0,"unavailable":[],"source_url":self.db.source(sid)["canonical_url"],
                       "added_clips":0,"added_included":0,"attempted_at":None} for sid in source_ids}
        job_id = uuid.uuid4().hex
        try:
            self.db.execute("INSERT INTO sync_jobs(id,source_ids,mode,state,checkpoints,started_at,heartbeat) VALUES(?,?,?,'queued',?,?,?)", (job_id,encode(source_ids),mode,encode(checkpoints),now(),now()))
        except sqlite3.IntegrityError:
            raise ValueError("已有采集任务正在运行") from None
        return self._schedule(job_id)

    def resume(self, job_id):
        if self.task and not self.task.done():
            raise ValueError("已有采集任务正在运行")
        job = self.db.job(job_id)
        if not job or job["state"] not in {"failed","paused","interrupted","cancelled"}:
            raise ValueError("此任务不能继续")
        for sid in job["source_ids"]:
            if not self.db.source(sid) or not self.db.source(sid)["enabled"]:
                raise ValueError("请先重新启用任务中的来源")
        for key, cp in job["checkpoints"].items():
            source = self.db.source(int(key))
            if cp.get("source_url") and cp["source_url"] != source["canonical_url"]:
                raise ValueError("来源地址已更改，请新建扫描任务")
            if cp.get("state") != "completed":
                cp["state"] = "pending"
                cp.pop("index_fetched_at", None)
        job.update(state="queued", errors=[], finished_at=None)
        try:
            self.db.save_job(job)
        except sqlite3.IntegrityError:
            raise ValueError("已有采集任务正在运行") from None
        self.db.execute("UPDATE sync_jobs SET cancel_requested=0 WHERE id=?", (job_id,))
        return self._schedule(job_id)

    def _schedule(self, job_id):
        self._interruptible_job = job_id
        self.task = asyncio.create_task(self.run(job_id))
        return self.db.job(job_id)

    def _interrupt(self, job_id):
        if self._interruptible_job == job_id:
            self._interruptible_job = None
            self.task.cancel()

    def cancel(self, job_id):
        self.db.execute("""UPDATE sync_jobs SET cancel_requested=1 WHERE id=?
            AND state IN ('queued','running')""", (job_id,))
        job = self.db.job(job_id)
        if not job:
            raise KeyError(job_id)
        # A queued task observes the flag before its first upstream request.
        if job["state"] == "running":
            self._interrupt(job_id)
        return job

    def check_cancel(self, job):
        if self.db.one("SELECT cancel_requested FROM sync_jobs WHERE id=?", (job["id"],))["cancel_requested"]:
            raise Cancelled()

    async def close(self):
        if self.task and not self.task.done():
            job_id = self._interruptible_job
            if job_id is not None:
                self._interrupt(job_id)
            try:
                await self.task
            except asyncio.CancelledError:
                # A task cancelled before its coroutine starts has no finally block.
                if job_id is not None:
                    self.db.execute("""UPDATE sync_jobs SET state=CASE WHEN cancel_requested=1
                        THEN 'cancelled' ELSE 'interrupted' END,finished_at=?,heartbeat=?
                        WHERE id=? AND state='queued'""", (now(), now(), job_id))

    async def stop(self):
        """Finish active work before replacing or forgetting login credentials."""
        active = self.db.all("SELECT id FROM sync_jobs WHERE state IN ('queued','running')")
        for job in active:
            self.cancel(job['id'])
        await self.close()

    async def heartbeat(self, job_id):
        while True:
            await asyncio.sleep(10)
            self.db.execute("UPDATE sync_jobs SET heartbeat=? WHERE id=? AND state='running'", (now(),job_id))

    def _selected_source(self, source_id, expected_url):
        source = self.db.source(source_id)
        if not source or not source["enabled"]:
            raise UpstreamError("source_changed", "采集来源已停用或不存在。")
        if expected_url and source["canonical_url"] != expected_url:
            raise UpstreamError("source_changed", "采集来源地址已更改，请重新更新。")
        return source

    def _save_public_index(self, source, songs, job, cp):
        self.db.save_songlist(source, songs)
        # The public index can be reordered between attempts. Replay its current
        # BV list when this source reaches its normal turn for video metadata.
        current_ids = {row["bvid"] for row in songs if row["bvid"]}
        seen = sorted(set(cp["seen"]) & current_ids)
        cp.update(page=1, page_hashes={}, seen=seen, processed=len(seen), state="pending", index_fetched_at=now())
        job["processed"] = sum(checkpoint.get("processed", 0) for checkpoint in job["checkpoints"].values())

    async def run(self, job_id):
        job = self.db.job(job_id)
        job["state"] = "running"
        self.db.save_job(job)
        adapter = None
        pulse = asyncio.create_task(self.heartbeat(job_id))
        try:
            adapter = self.adapter_factory(self.settings)
            # The independently hosted song index can update even if an uploader
            # later hits a Bilibili limit. Keep all BV lookups in the chosen order.
            public_ids = {row["id"] for row in self.db.all("SELECT id FROM sources WHERE source_type='songlist'")}
            stages = [(sid, True) for sid in job["source_ids"] if sid in public_ids]
            stages.extend((sid, False) for sid in job["source_ids"])
            for source_id, index_only in stages:
                self.check_cancel(job)
                cp = job["checkpoints"].setdefault(str(source_id), {"page":1,"seen":[],"page_hashes":{},"state":"pending","processed":0,"unavailable":[],"added_clips":0,"added_included":0})
                if cp["state"] in {"completed", "failed"}:
                    continue
                cp["state"] = "running"
                cp["attempted_at"] = now()
                cp.pop("finished_at", None)
                self.db.save_job(job)
                try:
                    source = self._selected_source(source_id, cp.get("source_url"))
                    cp.setdefault("source_url", source["canonical_url"])
                    if (source["source_type"] == "songlist") != (source_id in public_ids):
                        raise UpstreamError("source_changed", "采集来源类型已更改，请重新更新。")
                    if index_only or source_id not in public_ids:
                        identity = await adapter.resolve_source(source)
                        self.check_cancel(job)
                        if not self.db.one("SELECT id FROM sources WHERE id=? AND canonical_url=? AND enabled=1",
                                           (source_id, cp["source_url"])):
                            raise UpstreamError("source_changed", "采集来源已更改或停用，请重新更新。")
                        if index_only:
                            self._save_public_index(source, identity["songs"], job, cp)
                        self.db.verified_source(source_id, identity)
                        if not index_only:
                            # Classification uses the freshly verified collection identity.
                            source = self._selected_source(source_id, cp["source_url"])
                    if not index_only:
                        await self.scan_source(adapter, source, job, cp)
                except UpstreamError as exc:
                    cp["state"] = "failed"
                    cp["finished_at"] = now()
                    error = {"source_id":source_id, **exc.as_dict()}
                    self.db.execute("UPDATE sources SET last_error=? WHERE id=? AND canonical_url=? AND enabled=1",
                                    (encode(error), source_id, cp.get("source_url")))
                    if not index_only and exc.category in {"restricted","retry_later","authentication"}:
                        job["errors"].insert(0, error)
                        job["state"] = "paused"
                        break
                    job["errors"].append(error)
                self.db.save_job(job)
            if job["state"] == "running":
                job["state"] = "failed" if job["errors"] else "completed"
        except Cancelled:
            job["state"] = "cancelled"
        except asyncio.CancelledError:
            job["state"] = "cancelled" if self.db.job(job_id)['cancel_requested'] else "interrupted"
        except Exception as exc:
            job["state"] = "failed"
            # Exception details may contain local paths/credentials; retain only a category.
            job["errors"].append({"category":"internal", "message":f"Local collector error ({type(exc).__name__}); committed data is preserved"})
        finally:
            # Repeated cancel, shutdown or logout must allow cleanup to finish.
            self._interruptible_job = None
            pulse.cancel()
            try:
                await pulse
            except asyncio.CancelledError:
                pass
            if adapter:
                await adapter.close()
            job["finished_at"] = now()
            self.db.save_job(job)

    async def scan_source(self, adapter, source, job, cp):
        # Replay one page on resume; fingerprints distinguish overlap from a pagination loop.
        page_number = max(1, cp["page"] - 1)
        seen = set(cp["seen"])
        enumerated = set()
        kind = source["source_type"]
        limit = self.settings.discovery_pages if kind == "search" else 10000 if kind == 'songlist' else self.settings.incremental_pages if job["mode"] == "incremental" else 10000
        while page_number <= limit:
            self.check_cancel(job)
            page = await adapter.list_entries(source, page_number)
            self.check_cancel(job)
            cp["total"] = page.total
            cp["current_page"] = page_number
            cp["scope"] = "discovery" if kind == "search" else job["mode"]
            resource_ids = page.resource_ids if page.resource_ids is not None else page.bvids
            fingerprint = hashlib.sha256(encode(resource_ids).encode()).hexdigest()
            previous_page = cp["page_hashes"].get(fingerprint)
            if resource_ids and previous_page is not None and previous_page != page_number:
                raise UpstreamError("pagination", "Repeated page detected; source coverage remains incomplete")
            # Seen clips from an earlier attempt are valid resume overlap.
            # Only pages that repeat within this pass indicate no progress.
            if resource_ids and page.has_more and previous_page != page_number and all(key in enumerated for key in resource_ids):
                raise UpstreamError("pagination", "Pagination made no progress; source coverage remains incomplete")
            if not resource_ids and page.has_more:
                raise UpstreamError("pagination", "Empty page with more results; source coverage remains incomplete")
            cp["page_hashes"][fingerprint] = page_number
            enumerated.update(resource_ids)
            self.db.save_job(job)
            for bvid in page.bvids:
                self.check_cancel(job)
                if bvid in seen:
                    continue
                existing = self.db.one("SELECT * FROM videos WHERE bvid=?", (bvid,))
                try:
                    fresh = existing and existing["availability_status"] == "available" and (datetime.now(timezone.utc) - datetime.fromisoformat(existing["fetched_at"])).total_seconds() < self.settings.stale_hours * 3600
                    if kind == 'songlist' and existing and existing['availability_status'] == 'available':
                        # A refreshed public index can reuse verified BV/CID metadata;
                        # only its new links need Bilibili calls during an update.
                        fresh = True
                    use_cached = (job["mode"] == "incremental" and fresh) or (existing and existing["availability_status"] == "available" and existing["fetched_at"] >= job["started_at"] and any(bvid in checkpoint.get("seen", []) for key, checkpoint in job["checkpoints"].items() if key != str(source["id"])))
                    data = json.loads(existing["raw_metadata"]) if use_cached else await adapter.get_video_details(bvid)
                    if kind == "uploader" and not video_has_uploader(data, source["uid"]):
                        raise UpstreamError("video_identity", f"Video {bvid} has no owner or coauthor matching source UID {source['uid']}")
                    if use_cached:
                        self.db.reuse_video(source, existing, collection_job=(job, cp))
                    else:
                        try:
                            tags = await adapter.get_video_tags(bvid)
                        except UpstreamError as exc:
                            if exc.category == "unavailable":
                                raise UpstreamError("schema", "Video is available, but its tag metadata is unavailable; scan remains incomplete", status=exc.status, code=exc.code) from None
                            raise
                        self.check_cancel(job)
                        self.db.save_video(source, data, tags, collection_job=(job, cp))
                except UpstreamError as exc:
                    if exc.category != "unavailable":
                        raise
                    cp["unavailable"].append({"bvid":bvid,**exc.as_dict()})
                    if existing:
                        self.db.execute("UPDATE videos SET availability_status='unavailable' WHERE bvid=?", (bvid,))
                seen.add(bvid)
                cp["seen"] = sorted(seen)
                cp["processed"] = len(seen)
                job["processed"] = sum(c.get("processed",0) for c in job["checkpoints"].values())
                # Save after the video transaction; replay is idempotent if interrupted in between.
                self.db.save_job(job)
                await asyncio.sleep(0)
            cp["page"] = page_number + 1
            self.db.save_job(job)
            if not page.has_more:
                # A short or overlapping pagination response cannot establish full coverage.
                if kind in {"uploader","season","series","songlist"} and (job["mode"] == "full" or kind == 'songlist') and page.total is not None and len(seen) < page.total:
                    raise UpstreamError("pagination", "Enumeration ended before all advertised submissions were found")
                cp["enumeration_finished"] = True
                break
            page_number += 1
        else:
            cp["enumeration_finished"] = False
            if kind != "search" and job["mode"] == "full":
                raise UpstreamError("pagination", "Full scan reached the safety page limit")
        self.check_cancel(job)
        cp["state"] = "completed"
        cp["finished_at"] = now()
        if kind == "search":
            # Search is always bounded discovery, even if its visible result pages terminate.
            self.db.execute("UPDATE sources SET last_discovery_at=?,last_error=NULL WHERE id=?", (now(),source["id"]))
        elif job["mode"] == "full":
            self.db.execute("UPDATE sources SET last_complete_scan_at=?,last_refresh_at=?,last_error=NULL WHERE id=?", (now(),now(),source["id"]))
        else:
            self.db.execute("UPDATE sources SET last_refresh_at=?,last_error=NULL WHERE id=?", (now(),source["id"]))
