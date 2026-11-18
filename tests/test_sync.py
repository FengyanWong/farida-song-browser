import asyncio
from copy import deepcopy

from farida.adapter import Page, UpstreamError
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
    import pytest
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
