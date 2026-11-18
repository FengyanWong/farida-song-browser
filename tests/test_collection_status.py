from copy import deepcopy
from farida.adapter import Page, UpstreamError
from farida.db import Database, encode, now
from farida.sync import Collector
from test_sync import FakeAdapter


def status(db, sid=1):
    return next(s for s in db.overview()['sources'] if s['id']==sid)['collection_status']


async def test_new_counts_repeat_new_part_and_overlap(db, settings, video):
    adapter=FakeAdapter(video)
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([1],'full');await worker.task
    first=status(db)
    assert first['state']=='completed'
    assert first['added_clips']==2 and first['added_included']==2
    assert first['last_success_at'] and first['finished_at'] and not first['can_resume']
    worker.start([1],'full');await worker.task
    assert status(db)['added_clips']==0
    adapter.video['pages'].append({'cid':300,'page':3,'part':'新歌','duration':90})
    worker.start([1],'full');await worker.task
    assert status(db)['added_clips']==1
    adapter.video['staff']=[{'mid':210887872,'name':'CLANNADOR'}]
    worker.start([2],'full');await worker.task
    assert status(db,2)['added_clips']==0


async def test_partial_failure_resume_and_unattempted_source(db, settings, video):
    adapter=FakeAdapter(video,{1:Page([video['bvid']],True,2),2:Page(['BV0000000002'],False,2)},fail_at=2)
    worker=Collector(db,settings,lambda _:adapter)
    job=worker.start([1],'full');await worker.task
    partial=status(db)
    assert partial['state']=='failed' and partial['added_clips']==2
    assert partial['last_success_at'] is None and partial['error']['category']=='network'
    adapter.fail_at=None
    worker.resume(job['id']);await worker.task
    assert status(db)['state']=='completed' and status(db)['added_clips']==4
    success=status(db)['last_success_at']
    async def restricted(source): raise UpstreamError('restricted','test limit',code=-412)
    adapter.resolve_source=restricted
    worker.start([1,2],'incremental');await worker.task
    paused=status(db)
    assert paused['state']=='paused' and paused['last_success_at']==success
    assert paused['added_clips']==0 and paused['can_resume']
    skipped=status(db,2)
    assert skipped['state']=='not_started' and skipped['last_attempt_at'] is None
    assert skipped['error'] is None and skipped['added_clips']==0


def test_count_checkpoint_and_video_commit_together(db, source, video):
    stamp=now()
    db.execute("INSERT INTO sync_jobs(id,source_ids,mode,state,started_at,heartbeat) VALUES('atomic','[1]','full','running',?,?)",(stamp,stamp))
    job=db.job('atomic');cp={'added_clips':0,'added_included':0};job['checkpoints']['1']=cp
    db.save_video(source,video,['法里达','翻唱'],collection_job=(job,cp))
    # Re-read the durable job before any normal collector checkpoint: a crash
    # here must not lose the count or count the replayed video twice.
    recovered=db.job('atomic');assert recovered['checkpoints']['1']['added_clips']==2
    db.save_video(source,video,['法里达','翻唱'],collection_job=(recovered,recovered['checkpoints']['1']))
    assert db.job('atomic')['checkpoints']['1']['added_clips']==2


def test_status_beyond_history_limit_and_changed_source(db):
    stamp=now()
    cp={'1':{'state':'completed','source_url':db.source(1)['canonical_url'],'processed':12}}
    db.execute("INSERT INTO sync_jobs(id,source_ids,mode,state,checkpoints,started_at,heartbeat) VALUES('old','[1]','incremental','completed',?,?,?)",(encode(cp),stamp,stamp))
    for i in range(12):
        db.execute("INSERT INTO sync_jobs(id,source_ids,mode,state,started_at,heartbeat) VALUES(?,'[2]','incremental','completed',?,?)",(str(i),stamp,stamp))
    assert len(db.overview()['jobs'])==10
    old=status(db)
    assert old['state']=='completed' and old['processed']==12 and old['added_clips'] is None
    db.update_source(1,{'url':'https://space.bilibili.com/999999'})
    assert status(db)['state']=='idle'


def test_queued_and_interrupted_states(db):
    stamp=now()
    db.execute("INSERT INTO sync_jobs(id,source_ids,mode,state,started_at,heartbeat) VALUES('new','[1,2]','full','queued',?,?)",(stamp,stamp))
    assert status(db)['state']=='queued'
    job=db.job('new');job['state']='running';job['checkpoints']['1']={'state':'running','processed':3};db.save_job(job)
    fresh=Database(db.path);fresh.initialize()
    assert status(fresh)['state']=='interrupted'
    assert status(fresh,2)['state']=='not_started'


async def test_bounded_search_and_unavailable_counts(db, settings, video):
    adapter=FakeAdapter(video,{1:Page([video['bvid']],True,99)})
    worker=Collector(db,settings,lambda _:adapter)
    worker.start([1],'incremental');await worker.task
    assert status(db)['state']=='completed' and status(db)['mode']=='incremental'
    assert not db.source(1)['last_complete_scan_at']
    async def unavailable(bvid):raise UpstreamError('unavailable','removed',code=-404)
    adapter.get_video_details=unavailable
    adapter.pages={1:Page(['BV0000000002'],False,1)}
    worker.start([1],'full');await worker.task
    assert status(db)['skipped']==1 and status(db)['added_clips']==0


def test_resumed_old_job_becomes_latest_in_source_and_banner(db):
    old='2025-01-01T00:00:00+00:00';recent='2025-02-01T00:00:00+00:00'
    cp={'1':{'state':'failed','source_url':db.source(1)['canonical_url'],'processed':2,'unavailable':[{'bvid':'BV0000000001'}]}}
    db.execute("INSERT INTO sync_jobs(id,source_ids,mode,state,checkpoints,started_at,heartbeat) VALUES('old','[1]','full','failed',?,?,?)",(encode(cp),old,old))
    db.execute("INSERT INTO sync_jobs(id,source_ids,mode,state,checkpoints,started_at,heartbeat) VALUES('newer','[1]','incremental','completed',?,?,?)",(encode({'1':{'state':'completed'}}),recent,recent))
    assert status(db)['job_id']=='newer' and status(db)['unavailable']==[]
    job=db.job('old');job['state']='running';job['checkpoints']['1']['state']='running';db.save_job(job)
    assert status(db)['state']=='running' and db.jobs()[0]['id']=='old'
    job['state']='completed';job['checkpoints']['1']['state']='completed';db.save_job(job)
    assert status(db)['job_id']=='old' and db.jobs()[0]['id']=='old'
    db.update_source(1,{'url':'https://space.bilibili.com/999999'})
    # Unknown legacy checkpoint URLs can remain, but cannot resurrect old skipped items.
    assert status(db)['unavailable']==[]


async def test_changed_unattempted_source_does_not_show_old_task(db,settings,video):
    adapter=FakeAdapter(video)
    async def restricted(source):raise UpstreamError('restricted','test limit')
    adapter.resolve_source=restricted
    worker=Collector(db,settings,lambda _:adapter)
    worker.start([1,2],'full');await worker.task
    assert status(db,2)['state']=='not_started'
    db.update_source(2,{'url':'https://space.bilibili.com/999999'})
    assert status(db,2)['state']=='idle'


def test_compact_overview_preserves_resume_state(db):
    cp = {"1": {"state":"paused", "seen":["BV0000000001"], "page_hashes":{"hash":1},
                "unavailable":[{"bvid":"BV0000000001"}], "processed":1}}
    stamp = now()
    db.execute("INSERT INTO sync_jobs(id,source_ids,mode,state,checkpoints,started_at,heartbeat) "
               "VALUES('compact','[1]','full','paused',?,?,?)",(encode(cp),stamp,stamp))
    small = db.overview(compact=True)["jobs"][0]["checkpoints"]["1"]
    assert set(small) == {"state","unavailable","processed"}
    assert db.job("compact")["checkpoints"] == cp
    assert db.overview()["jobs"][0]["checkpoints"] == cp
