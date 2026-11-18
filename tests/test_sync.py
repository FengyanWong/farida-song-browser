import asyncio
from copy import deepcopy

import httpx
import pytest

from farida.adapter import BilibiliAdapter, Page, UpstreamError
from farida.classifier import VERSION, classify
from farida.db import Database, encode, now
from farida.sync import Collector


class FakeAdapter:
    def __init__(self,video,pages=None,fail_at=None):
        self.video=video
        self.pages=pages or {1:Page([video["bvid"]],False,1)}
        self.fail_at=fail_at
        self.calls=[]
        self.video_calls=[]

    async def close(self):pass

    async def resolve_source(self,source):
        return {"uid":source["uid"],"name":source["display_name"],"method":"test_fixture"}

    async def list_entries(self,source,page):
        self.calls.append(page)
        if page==self.fail_at:raise UpstreamError("network","fixture connection failed")
        return self.pages[page]

    async def get_video_details(self,bvid):
        self.video_calls.append(bvid)
        data=deepcopy(self.video);data["bvid"]=bvid
        return data

    async def get_video_tags(self,bvid):return ["法里达","直播切片","翻唱"]


async def test_full_scan_and_repeat_are_idempotent(db,settings,video):
    adapter=FakeAdapter(video)
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([1],"full");await worker.task
    assert db.job(job["id"])["state"]=="completed"
    assert db.source(1)["last_complete_scan_at"]
    worker.start([1],"full");await worker.task
    assert db.overview()["entries"]==2 and db.overview()["submissions"]==1


async def test_coauthor_scan_resumes_and_reuses_verified_details(db, settings, video):
    adapter = FakeAdapter(video)
    worker = Collector(db, settings, lambda _: adapter)
    job = worker.start([2], 'full')
    await worker.task
    failed = db.job(job['id'])
    assert failed['state'] == 'failed' and failed['errors'][0]['category'] == 'video_identity'
    assert not db.source(2)['last_complete_scan_at']
    adapter.video['staff'] = [{'mid': 210887872, 'name': 'CLANNADOR', 'title': '导演'}]
    worker.resume(job['id'])
    await worker.task
    assert db.job(job['id'])['state'] == 'completed'
    assert db.source(2)['last_complete_scan_at'] and db.source(2)['last_error'] is None
    assert db.clip(video['bvid'] + ':100')['uploader_uid'] == '394803911'
    calls = len(adapter.video_calls)
    job = worker.start([2], 'incremental')
    await worker.task
    assert db.job(job['id'])['state'] == 'completed'
    assert len(adapter.video_calls) == calls


async def test_cached_unrelated_video_reports_membership_mismatch(db, settings, source, video):
    db.save_video(source, video, ['法里达'])
    worker = Collector(db, settings, lambda _: FakeAdapter(video))
    job = worker.start([2], 'incremental')
    await worker.task
    failed = db.job(job['id'])
    assert failed['state'] == 'failed' and failed['errors'][0]['category'] == 'video_identity'
    assert db.source(2)['submissions'] == 0
    assert db.source(2)['last_refresh_at'] is None


async def test_incremental_does_not_claim_full_coverage(db,settings,video):
    adapter=FakeAdapter(video,{1:Page([video["bvid"]],True,99)})
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([1],"incremental");await worker.task
    assert db.job(job["id"])["state"]=="completed"
    assert db.source(1)["last_refresh_at"] and db.source(1)["last_complete_scan_at"] is None


async def test_search_limit_never_claims_account_or_site_coverage(db,settings,video):
    source=next(s for s in db.sources() if s['source_type'] == 'search')
    adapter=FakeAdapter(video,{1:Page([video["bvid"]],True,999),2:Page(["BV0000000002"],True,999)})
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([source["id"]],"full");await worker.task
    assert db.job(job["id"])["state"]=="completed"
    assert db.source(source["id"])["last_discovery_at"] and db.source(source["id"])["last_complete_scan_at"] is None


async def test_failed_scan_resumes_with_overlap_and_keeps_data(db,settings,video):
    adapter=FakeAdapter(video,{1:Page([video["bvid"]],True,2),2:Page(["BV0000000002"],False,2)},fail_at=2)
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([1],"full");await worker.task
    assert db.job(job["id"])["state"]=="failed" and not db.source(1)["last_complete_scan_at"]
    assert db.overview()["submissions"]==1
    db.bookmark(video["bvid"]+":100",True)
    adapter.fail_at=None
    worker.resume(job["id"]);await worker.task
    assert db.job(job["id"])["state"]=="completed"
    assert db.overview()["submissions"]==2 and db.overview()["bookmarked"]==1
    assert adapter.calls==[1,2,1,2]
    assert len(adapter.video_calls)==2


async def test_repeated_page_cannot_complete(db,settings,video):
    adapter=FakeAdapter(video,{1:Page([video["bvid"]],True,2),2:Page([video["bvid"]],True,2)})
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([1],"full");await worker.task
    assert db.job(job["id"])["errors"][0]["category"]=="pagination"
    assert not db.source(1)["last_complete_scan_at"]


async def test_reordered_repeated_page_still_cannot_complete(db, settings, video):
    a, b, c = 'BV0000000001', 'BV0000000002', 'BV0000000003'
    adapter = FakeAdapter(video, {1: Page([a, b, c], True, 9), 2: Page([b, a], True, 9)})
    worker = Collector(db, settings, lambda _: adapter)
    job = worker.start([1], 'full')
    await worker.task
    assert db.job(job['id'])['errors'][0]['category'] == 'pagination'
    assert not db.source(1)['last_complete_scan_at']


async def test_short_enumeration_remains_incomplete(db,settings,video):
    adapter=FakeAdapter(video,{1:Page([video["bvid"]],False,4)})
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([1],"full");await worker.task
    assert db.job(job["id"])["state"]=="failed"
    assert db.job(job["id"])["errors"][0]["category"]=="pagination"


async def test_restriction_pauses_entire_job(db,settings,video):
    adapter=FakeAdapter(video)
    async def restricted(source):raise UpstreamError("restricted","test restriction",code=-352)
    adapter.resolve_source=restricted
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([1,2,3,4],"full");await worker.task
    saved=db.job(job["id"])
    assert saved["state"]=="paused"
    assert saved["checkpoints"]["1"]["state"]=="failed"
    assert all(saved["checkpoints"][str(sid)]["state"]=="pending" and saved["checkpoints"][str(sid)]["attempted_at"] is None for sid in (2,3,4))
    assert db.source(1)["last_error"]["upstream_code"]==-352
    assert db.source(1)["verification_status"]=="pending"


async def test_cancel_then_resume_without_losing_progress(db,settings,video):
    adapter=FakeAdapter(video)
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([1],"full");worker.cancel(job["id"]);await worker.task
    assert db.job(job["id"])["state"]=="cancelled"
    worker.resume(job["id"]);await worker.task
    assert db.job(job["id"])["state"]=="completed"


async def test_one_job_at_a_time(db,settings,video):
    worker=Collector(db,settings,lambda _:FakeAdapter(video))
    worker.start([1],"full")
    with pytest.raises(ValueError):worker.start([2],"full")
    await worker.task


async def test_account_change_cancels_unstarted_job_and_allows_next(db,settings,video):
    worker=Collector(db,settings,lambda _:FakeAdapter(video))
    job=worker.start([1], 'incremental')
    await worker.stop()
    assert db.job(job['id'])['state']=='cancelled'
    assert not db.overview()['entries']
    next_job=worker.start([1], 'incremental')
    await worker.task
    assert db.job(next_job['id'])['state']=='completed'


async def test_account_logout_stops_inflight_requests_and_keeps_bookmarks(db,settings,video):
    from farida.auth import BilibiliLogin
    from farida.session import SessionStore
    started,closed=asyncio.Event(),asyncio.Event()
    adapter=FakeAdapter(video)
    async def blocking(source):
        started.set()
        await asyncio.Event().wait()
    async def close():closed.set()
    adapter.resolve_source=blocking;adapter.close=close
    db.save_video(db.source(1),video,[])
    db.bookmark(video['bvid']+':100',True)
    SessionStore(settings).save('SESSDATA=synthetic',{'uid':'123','name':'测试'})
    worker=Collector(db,settings,lambda _:adapter)
    login=BilibiliLogin(settings,before_change=worker.stop)
    job=worker.start([1],'incremental')
    await asyncio.wait_for(started.wait(),2)
    await login.logout()
    assert closed.is_set() and worker.task.done()
    assert db.job(job['id'])['state']=='cancelled'
    assert db.overview()['bookmarked']==1
    assert SessionStore(settings).cookie_header()==''
    await login.close()


def test_restart_marks_jobs_interrupted(db,settings):
    db.execute("INSERT INTO sync_jobs(id,source_ids,mode,state,started_at,heartbeat) VALUES('restart','[1]','full','running',?,?)",(now(),now()))
    fresh=Database(settings.db_path);fresh.initialize()
    assert fresh.job("restart")["state"]=="interrupted"


async def test_refresh_reuses_fresh_metadata_without_fake_timestamp(db,settings,video,source):
    db.save_video(source,video,["法里达","翻唱"])
    stamp=db.clip(video["bvid"]+":100")["stats_fetched_at"]
    adapter=FakeAdapter(video);worker=Collector(db,settings,lambda _:adapter)
    worker.start([1],"incremental");await worker.task
    assert not adapter.video_calls
    assert db.clip(video["bvid"]+":100")["stats_fetched_at"]==stamp


async def test_tag_failure_does_not_mark_available_video_deleted(db,settings,video,source):
    db.save_video(source,video,['法里达','翻唱'])
    adapter=FakeAdapter(video)
    async def missing_tags(bvid):raise UpstreamError('unavailable','fixture tag endpoint failure',code=-404)
    adapter.get_video_tags=missing_tags
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([1],'full');await worker.task
    assert db.job(job['id'])['state']=='failed'
    assert db.clip(video['bvid']+':100')['availability_status']=='available'
    assert db.source(1)['last_complete_scan_at'] is None


async def test_cancel_interrupts_inflight_request_and_resume_keeps_saved_clips(db, settings, video):
    first, second = video['bvid'], 'BV0000000002'
    adapter = FakeAdapter(video, {1: Page([first, second], False, 2)})
    started = asyncio.Event()
    closing = asyncio.Event()
    release = asyncio.Event()
    interrupted = asyncio.Event()
    original_details = adapter.get_video_details

    async def delayed_details(bvid):
        if bvid == second:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                interrupted.set()
        return await original_details(bvid)

    async def close():
        closing.set()
        await release.wait()

    adapter.get_video_details = delayed_details
    adapter.close = close
    collector = Collector(db, settings, lambda _: adapter)
    job_id = collector.start([1], 'incremental')['id']
    await asyncio.wait_for(started.wait(), 2)
    collector.cancel(job_id)
    try:
        await asyncio.wait_for(closing.wait(), 2)
        assert interrupted.is_set()
        collector.cancel(job_id)
        shutdown = asyncio.create_task(collector.close())
        await asyncio.sleep(0)
        assert not shutdown.done()
    finally:
        release.set()
    await asyncio.wait_for(shutdown, 2)
    saved = db.job(job_id)
    assert saved['state'] == 'cancelled'
    assert saved['checkpoints']['1']['seen'] == [first]
    adapter.get_video_details = original_details
    collector.resume(job_id)
    await collector.task
    assert db.job(job_id)['state'] == 'completed'
    assert adapter.video_calls == [first, second]
    assert db.source(1)['submissions'] == 2


async def test_shutdown_before_worker_starts_leaves_resumable_job(db, settings, video):
    adapter = FakeAdapter(video)
    collector = Collector(db, settings, lambda _: adapter)
    job_id = collector.start([1], 'incremental')['id']
    await collector.close()
    assert db.job(job_id)['state'] == 'interrupted'
    assert adapter.calls == []
    collector.resume(job_id)
    await collector.task
    assert db.job(job_id)['state'] == 'completed'


@pytest.mark.parametrize("pages, expected_state", [
    ([[{"type": 12, "id": 11}], [{"type": 24, "id": 11}], [{"type": 2, "bvid": "BV1br4y1R7BP"}]], "completed"),
    ([[{"type": 12, "id": 11}], [{"type": 12, "id": 11}]], "failed"),
    ([[{"type": 12, "id": 11}, {"type": 24, "id": 11}], [{"type": 24, "id": 11}, {"type": 12, "id": 11}], []], "failed"),
    ([[], [{"type": 2, "bvid": "BV1br4y1R7BP"}]], "failed"),
], ids=["articles-and-audio-before-video", "repeated-page", "reordered-repeated-page", "empty-page-with-more"])
async def test_favorites_cursor_uses_all_resources_but_only_collects_videos(db, settings, video, pages, expected_state):
    source = db.add_source("收藏夹", "https://space.bilibili.com/123/favlist?fid=456")
    calls = []
    def response(request):
        path = request.url.path
        calls.append(path)
        if path == "/x/web-interface/nav":
            data = {"wbi_img": {"img_url": "https://test.invalid/" + "a"*32 + ".png",
                                "sub_url": "https://test.invalid/" + "b"*32 + ".png"}}
        elif path == "/x/space/wbi/acc/info":
            data = {"mid": 123, "name": "收藏者"}
        elif path == "/x/v3/fav/resource/list":
            page = int(request.url.params["pn"])
            data = {"info": {"upper": {"mid": 123}, "id": 456, "media_count": sum(map(len, pages))},
                    "medias": pages[page-1], "has_more": page < len(pages)}
        elif path == "/x/web-interface/view":
            assert request.url.params["bvid"] == video["bvid"]
            data = video
        elif path == "/x/tag/archive/tags":
            data = [{"tag_name": "法里达"}]
        else:
            raise AssertionError(path)
        return httpx.Response(200, json={"code": 0, "data": data})

    settings.incremental_pages = 3
    collector = Collector(db, settings, lambda cfg: BilibiliAdapter(cfg, transport=httpx.MockTransport(response)))
    job_id = collector.start([source["id"]], "incremental")["id"]
    await collector.task
    job = db.job(job_id)
    assert job["state"] == expected_state
    if expected_state == "completed":
        assert calls.count("/x/v3/fav/resource/list") == 3
        assert calls.count("/x/web-interface/view") == calls.count("/x/tag/archive/tags") == 1
        assert job["checkpoints"][str(source["id"])]["seen"] == [video["bvid"]]
        assert db.source(source["id"])["submissions"] == 1
    else:
        assert job["errors"][0]["category"] == "pagination"
        assert "/x/web-interface/view" not in calls
        assert db.source(source["id"])["last_refresh_at"] is None


async def test_incremental_refresh_repairs_legacy_uploader_evidence_and_preserves_manual_changes(db, settings, video):
    source = db.source(1)
    db.verified_source(1, {"uid": source["uid"], "name": source["display_name"], "method": "fixture"})
    db.execute("UPDATE sources SET singing_collection=1 WHERE id=1")
    video.update(title="工作室日常记录", desc="")
    for part in video["pages"]:
        part["part"] = "现场记录"
    source = db.source(1)
    assert not source["singing_collection"] and not db.sources()[0]["singing_collection"]
    assert classify(video, video["pages"][0], [], {**source, "singing_collection": 1})[1] == "needs_review"
    db.save_video(source, video, [])
    auto, manual = [f"{video['bvid']}:{part['cid']}" for part in video["pages"]]
    db.execute("UPDATE annotations SET inclusion_status='included',classification_version='rules-1' WHERE clip_id IN (?,?)",
               (auto, manual))
    db.annotate([manual], {"inclusion_status": "included", "display_song_title": "我的曲名", "notes": "保留"})
    db.bookmark(manual, True)
    assert db.clip(auto)["inclusion_status"] == "included"

    adapter = FakeAdapter(video)
    collector = Collector(db, settings, lambda _: adapter)
    job = collector.start([1], "incremental")
    await collector.task
    assert db.job(job["id"])["state"] == "completed" and not adapter.video_calls
    automatic = db.clip(auto)
    assert automatic["inclusion_status"] == "needs_review" and automatic["classification_version"] == VERSION
    kept = db.clip(manual)
    assert (kept["inclusion_status"], kept["display_song_title"], kept["notes"], kept["bookmarked"]) == (
        "included", "我的曲名", "保留", 1)
    assert kept["classification_reason"] == "用户手动确认"
    assert db.update_source(1, {"display_name": "离落"})["singing_collection"] == 0
    assert db.one("SELECT singing_collection FROM sources WHERE id=1")["singing_collection"] == 0


@pytest.mark.parametrize("collection_first", [False, True])
async def test_shared_collection_evidence_survives_refresh_order(db, settings, video, collection_first):
    collection = db.add_source("歌唱合集", "https://space.bilibili.com/123/lists/456", singing_collection=True)
    discovery = next(s for s in db.sources() if s["source_type"] == "search")
    video.update(title="工作室现场", desc="")
    video["pages"][0]["part"] = "现场录制"
    video["pages"][1]["part"] = "闲聊"
    video["pages"].append({"cid": 300, "page": 3, "part": "个人选择", "duration": 10})
    first, mixed, manual = [f"{video['bvid']}:{part['cid']}" for part in video["pages"]]
    adapter = FakeAdapter(video)
    tag_calls = []
    async def no_tags(bvid):
        tag_calls.append(bvid)
        return []
    adapter.get_video_tags = no_tags
    worker = Collector(db, settings, lambda _: adapter)
    ids = [collection["id"], 1] if collection_first else [1, collection["id"]]
    for index, source_id in enumerate([*ids, discovery["id"]]):
        job = worker.start([source_id], "incremental")
        await worker.task
        assert db.job(job["id"])["state"] == "completed"
        if index == 0:
            assert db.clip(first)["inclusion_status"] == ("included" if collection_first else "needs_review")
            db.annotate([manual], {"display_song_title": "我的曲名", "inclusion_status": "excluded"})
        else:
            included = db.clip(first)
            assert included["inclusion_status"] == "included" and "歌唱合集" in included["classification_reason"]
            assert db.clip(mixed)["inclusion_status"] == "needs_review"
            saved = db.clip(manual)
            assert (saved["display_song_title"], saved["inclusion_status"]) == ("我的曲名", "excluded")
    assert adapter.calls == [1, 1, 1] and adapter.video_calls == tag_calls == [video["bvid"]]


async def test_first_scan_of_verified_singing_collection_classifies_with_fresh_identity(db, settings, video):
    source = db.add_source("歌唱合集", "https://space.bilibili.com/123/lists/456?type=season", singing_collection=True)
    assert source["verification_status"] == "pending"
    video.update(title="午夜录制", desc="", pages=video["pages"][:1])
    adapter = FakeAdapter(video)
    async def no_tags(bvid):
        return []
    adapter.get_video_tags = no_tags
    collector = Collector(db, settings, lambda _: adapter)
    job_id = collector.start([source["id"]], "incremental")["id"]
    await collector.task
    assert db.job(job_id)["state"] == "completed"
    assert db.source(source["id"])["verification_status"] == "verified"
    assert db.clip(video["bvid"] + ":100")["inclusion_status"] == "included"
