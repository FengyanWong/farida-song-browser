from copy import deepcopy
import sqlite3

import pytest
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


def make_running_job(db, source, checkpoint):
    stamp = now()
    checkpoints = {str(source['id']):checkpoint, '99':{'processed':3,'state':'completed'}}
    db.execute("""INSERT INTO sync_jobs(id,source_ids,mode,state,checkpoints,processed,started_at,heartbeat)
        VALUES('atomic',?,'full','running',?,3,?,?)""", (encode([99,source['id']]),encode(checkpoints),stamp,stamp))
    job = db.job('atomic')
    return job, job['checkpoints'][str(source['id'])]


def test_count_checkpoint_and_video_commit_together(db, source, video):
    job, cp = make_running_job(db, source, {'added_clips':0,'added_included':0})
    db.save_video(source, video, ['法里达','翻唱'], collection_job=(job,cp))
    # A fresh connection immediately sees all parts, new counters and the resume ID.
    recovered = db.job('atomic')
    assert recovered['checkpoints']['1'] == cp == {
        'added_clips':2, 'added_included':2, 'seen':[video['bvid']], 'processed':1}
    assert recovered['processed'] == job['processed'] == 4
    assert db.source(source['id'])['entries'] == 2
    # Replaying an already committed item cannot advance counts twice.
    db.save_video(source, video, ['法里达','翻唱'], collection_job=(recovered,recovered['checkpoints']['1']))
    assert db.job('atomic')['checkpoints'] == recovered['checkpoints'] == job['checkpoints']
    assert db.job('atomic')['processed'] == 4


@pytest.mark.parametrize('cached', [False, True], ids=['new-multipart', 'cached-membership'])
def test_failed_video_commit_rolls_back_catalog_and_live_progress(db, source, video, cached):
    if cached:
        db.save_video(source, video, ['法里达'])
        source = db.add_source('测试合集', 'https://space.bilibili.com/123/lists/456?type=season')
    job, cp = make_running_job(db, source, {'added_clips':0,'added_included':0,'seen':[],'processed':0})
    previous = deepcopy(job)
    # The checkpoint statement succeeds. Only COMMIT discovers this deferred
    # foreign-key error, after both the video and job updates have executed.
    db.execute("CREATE TABLE reject_commit(job TEXT REFERENCES sync_jobs(id) DEFERRABLE INITIALLY DEFERRED)")
    db.execute("""CREATE TRIGGER reject_video_progress AFTER UPDATE OF checkpoints ON sync_jobs
        WHEN NEW.processed > OLD.processed BEGIN INSERT INTO reject_commit VALUES('missing'); END""")
    def save():
        if cached:
            existing = db.one("SELECT * FROM videos WHERE bvid=?", (video['bvid'],))
            db.reuse_video(source, existing, collection_job=(job,cp))
        else:
            db.save_video(source, video, ['法里达','翻唱'], collection_job=(job,cp))

    with pytest.raises(sqlite3.IntegrityError):
        save()
    assert job == previous == db.job(job['id'])
    assert cp == previous['checkpoints'][str(source['id'])]
    assert db.source(source['id'])['submissions'] == 0
    assert bool(db.clip(video['bvid'] + ':100')) == cached
    db.execute("DROP TRIGGER reject_video_progress")
    save()
    assert db.job(job['id'])['processed'] == 4
    assert cp['seen'] == [video['bvid']] and cp['added_clips'] == (0 if cached else 2)
    assert db.source(source['id'])['entries'] == 2


def test_legacy_checkpoint_keeps_unknown_counts_and_records_cached_video(db, source, video):
    db.save_video(source, video, ['法里达','翻唱'])
    existing = db.one("SELECT * FROM videos WHERE bvid=?", (video['bvid'],))
    job, cp = make_running_job(db, source, {'state':'running','seen':[],'processed':0})
    db.reuse_video(source, existing, collection_job=(job,cp))
    recovered = db.job(job['id'])
    assert recovered['processed'] == 4
    assert recovered['checkpoints']['1'] == cp == {'state':'running', 'seen':[video['bvid']], 'processed':1}
    assert db.clip(video['bvid'] + ':100')['fetched_at'] == existing['fetched_at']


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
