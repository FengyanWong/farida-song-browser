import asyncio
from copy import deepcopy

import httpx
import pytest

from farida.adapter import BilibiliAdapter, Page, UpstreamError, parse_source
from farida.db import Database
from farida.session import SessionStore
from farida.songlist import ENDPOINT, URL, parse_songlist
from farida.sync import Collector


def payload(video, *, with_link=True, name='整理后的歌名'):
    return {'code': 0, 'data': {'uid': 23263470, 'enabled': True, 'songs': [
        {'id': 1, 'name': name, 'singer': '原唱', 'language': '国语', 'style': '流行', 'video': video['bvid'] if with_link else None},
        {'id': 2, 'name': '尚无歌切', 'video': None},
    ]}}


def test_site_is_a_fixed_distinct_source_and_keeps_unlinked_songs(db, video, settings):
    source = next(s for s in db.sources() if s['source_type'] == 'songlist')
    assert parse_source(URL)['source_type'] == 'songlist' and source['uid'] is None
    rows = parse_songlist(payload(video))
    db.save_songlist(source, rows)
    assert db.source(source['id'])['listed_songs'] == 2
    assert db.source(source['id'])['linked_songs'] == 1
    assert db.overview()['entries'] == 0  # No invented video dates or covers.
    Database(settings.db_path).initialize()
    assert db.source(source['id'])['listed_songs'] == 2
    assert len([s for s in db.sources() if s['source_type'] == 'songlist']) == 1


@pytest.mark.parametrize('change', ['uid', 'disabled', 'missing', 'duplicate', 'bad_bv', 'bad_title', 'bad_singer'])
def test_changed_or_malformed_index_is_rejected(video, change):
    response = payload(video)
    data = response['data']
    if change == 'uid': data['uid'] = 210887872
    if change == 'disabled': data['enabled'] = False
    if change == 'missing': del data['songs']
    if change == 'duplicate': data['songs'].append(data['songs'][0])
    if change == 'bad_bv': data['songs'][0]['video'] = 'https://example.com/BV1br4y1R7BP'
    if change == 'bad_title': data['songs'][0]['name'] = None
    if change == 'bad_singer': data['songs'][0]['singer'] = {}
    with pytest.raises(ValueError): parse_songlist(response)


async def test_public_index_never_receives_bilibili_credentials(settings, video):
    SessionStore(settings).save('SESSDATA=offline-test; DedeUserID=123', {'uid': '123', 'name': 'Fixture'})
    requests = []
    def handler(request):
        requests.append(request)
        assert str(request.url) == ENDPOINT and request.method == 'POST'
        assert 'cookie' not in request.headers
        return httpx.Response(200, json=payload(video))
    adapter = BilibiliAdapter(settings, transport=httpx.MockTransport(handler))
    source = parse_source(URL)
    assert len((await adapter.resolve_source(source))['songs']) == 2
    page = await adapter.list_entries(source, 1)
    assert page.bvids == [video['bvid']] and page.total == 1 and not page.has_more
    assert len(requests) == 1
    await adapter.close()


async def test_each_update_rereads_index_reuses_metadata_and_keeps_manual_edits(db, settings, source, video):
    video['pages'] = video['pages'][:1]
    db.save_video(source, video, ['法里达'])
    db.execute("UPDATE videos SET fetched_at='2020-01-01T00:00:00+00:00'")
    curated = next(s for s in db.sources() if s['source_type'] == 'songlist')
    response, calls = payload(video), []
    def handler(request):
        calls.append(str(request.url))
        assert str(request.url) == ENDPOINT  # Existing videos need no upstream refresh.
        return httpx.Response(200, json=response)
    worker = Collector(db, settings, lambda _: BilibiliAdapter(settings, transport=httpx.MockTransport(handler)))
    job = worker.start([curated['id']], 'incremental')
    await worker.task
    assert db.job(job['id'])['state'] == 'completed'
    clip_id = video['bvid'] + ':100'
    row = db.clip(clip_id)
    assert row['display_song_title'] == '整理后的歌名'
    assert row['uploader_uid'] == source['uid'] and row['fetched_at'].startswith('2020-')
    assert row['has_curated_credit'] and row['songlist_credits'][0]['canonical_url'] == URL
    assert row['songlist_attribution'] == 'CLANNADOR' and row['songlist_url'] == URL
    assert len(row['sources']) == 2 and db.overview()['submissions'] == 1
    db.annotate([clip_id], {'display_song_title': '我的名称'})
    db.bookmark(clip_id, True)
    response['data']['songs'][0]['name'] = '网站的新名称'
    job = worker.start([curated['id']], 'incremental')
    await worker.task
    assert db.job(job['id'])['state'] == 'completed' and len(calls) == 2
    row = db.clip(clip_id)
    assert row['display_song_title'] == '我的名称' and row['bookmarked']
    assert row['songlist_credits'][0]['song_title'] == '网站的新名称'


async def test_update_enumerates_whole_index_and_fetches_only_new_videos(db, settings, source, video):
    response = payload(video)
    response['data']['songs'] = []
    for i in range(31):
        data = deepcopy(video)
        data['bvid'] = f'BV{i:010d}'
        if i < 30: db.save_video(source, data, ['法里达'])
        response['data']['songs'].append({'id': i+1, 'name': f'歌曲{i}', 'video': data['bvid']})
    detail_calls = []
    def handler(request):
        if str(request.url) == ENDPOINT: return httpx.Response(200, json=response)
        if request.url.path == '/x/web-interface/view':
            bvid = request.url.params['bvid'];detail_calls.append(bvid)
            return httpx.Response(200, json={'code': 0, 'data': {**video, 'bvid': bvid}})
        assert request.url.path == '/x/tag/archive/tags'
        return httpx.Response(200, json={'code': 0, 'data': [{'tag_name': '法里达'}]})
    curated = next(s for s in db.sources() if s['source_type'] == 'songlist')
    worker = Collector(db, settings, lambda _: BilibiliAdapter(settings, transport=httpx.MockTransport(handler)))
    job = worker.start([curated['id']], 'incremental')
    await worker.task
    job = db.job(job['id'])
    assert job['state'] == 'completed' and job['processed'] == 31
    assert job['checkpoints'][str(curated['id'])]['enumeration_finished']
    assert detail_calls == ['BV0000000030']


def test_curated_title_never_relabels_unrelated_parts(db, source, video):
    curated = next(s for s in db.sources() if s['source_type'] == 'songlist')
    db.save_songlist(curated, parse_songlist(payload(video, name='月亮代表我的心')))
    db.save_video(source, video, ['法里达'])
    assert db.clip(video['bvid']+':100')['display_song_title'] == '月亮代表我的心'
    assert db.clip(video['bvid']+':200')['display_song_title'] == '夜に駆ける'
    assert db.clip(video['bvid']+':200')['playback_url'].endswith('?p=2')


async def test_site_failure_preserves_previous_index_and_clips(db, settings, source, video):
    curated = next(s for s in db.sources() if s['source_type'] == 'songlist')
    db.save_songlist(curated, parse_songlist(payload(video)))
    db.save_video(source, video, ['法里达'])
    worker = Collector(db, settings, lambda _: BilibiliAdapter(settings, transport=httpx.MockTransport(lambda _: httpx.Response(503))))
    job = worker.start([curated['id']], 'incremental')
    await worker.task
    assert db.job(job['id'])['errors'][0]['category'] == 'songlist'
    assert db.source(curated['id'])['listed_songs'] == 2 and db.overview()['entries'] == 2


async def test_resume_replays_completed_pages_skips_private_video_and_finishes(db, settings, video):
    response = payload(video)
    response['data']['songs'] = [{'id': i+1, 'name': f'歌曲{i}', 'video': f'BV{i:010d}'} for i in range(61)]
    blocked, calls, index_calls = True, [], []
    private, missing = 'BV0000000031', 'BV0000000034'
    def handler(request):
        if str(request.url) == ENDPOINT:
            index_calls.append(request)
            return httpx.Response(200, json=response)
        bvid = request.url.params['bvid']
        if request.url.path == '/x/web-interface/view':
            calls.append(bvid)
            if bvid == private:
                return httpx.Response(200, json={'code': -500 if blocked else 62012, 'data': None})
            if bvid == missing:
                return httpx.Response(200, json={'code': -404, 'data': None})
            return httpx.Response(200, json={'code': 0, 'data': {**video, 'bvid': bvid}})
        assert request.url.path == '/x/tag/archive/tags'
        return httpx.Response(200, json={'code': 0, 'data': [{'tag_name': '法里达'}]})
    curated = next(s for s in db.sources() if s['source_type'] == 'songlist')
    worker = Collector(db, settings, lambda _: BilibiliAdapter(settings, transport=httpx.MockTransport(handler)))
    job = worker.start([curated['id']], 'incremental')
    await worker.task
    saved = db.job(job['id'])
    assert saved['state'] == 'failed' and saved['processed'] == 31
    db.bookmark('BV0000000000:100', True)
    db.annotate(['BV0000000000:100'], {'display_song_title': '保留我的名称'})
    blocked = False
    worker.resume(job['id'])
    await worker.task
    saved = db.job(job['id'])
    cp = saved['checkpoints'][str(curated['id'])]
    assert saved['state'] == 'completed' and saved['processed'] == 61 and not saved['errors']
    assert cp['enumeration_finished'] and cp['total'] == len(cp['seen']) == 61
    assert {(e['bvid'], e['upstream_code']) for e in cp['unavailable']} == {(private, 62012), (missing, -404)}
    assert db.source(curated['id'])['submissions'] == 59 and db.source(curated['id'])['last_error'] is None
    assert db.source(curated['id'])['listed_songs'] == 61
    assert len(index_calls) == 2 and calls.count(private) == 2
    assert calls.count('BV0000000000') == 1 and calls[-1] == 'BV0000000060'
    row = db.clip('BV0000000000:100')
    assert row['bookmarked'] and row['display_song_title'] == '保留我的名称'
    assert db.clip(private + ':100') is None


async def test_all_sources_update_public_index_before_bilibili_pauses(db, settings, video):
    curated = next(source for source in db.sources() if source['source_type'] == 'songlist')
    calls = []
    def handler(request):
        calls.append(str(request.url))
        if str(request.url) == ENDPOINT:
            assert 'cookie' not in request.headers
            return httpx.Response(200, json=payload(video, name='新收录曲目'))
        assert request.url.path == '/x/web-interface/nav'
        return httpx.Response(429)

    worker = Collector(db, settings, lambda _: BilibiliAdapter(settings, transport=httpx.MockTransport(handler)))
    job_id = worker.start([], 'incremental')['id']
    await worker.task
    job = db.job(job_id)
    assert calls == [ENDPOINT, 'https://api.bilibili.com/x/web-interface/nav']
    assert job['state'] == 'paused' and job['errors'][0]['http_status'] == 429
    assert db.one("SELECT song_title FROM curated_songs WHERE source_id=? AND id=1", (curated['id'],))['song_title'] == '新收录曲目'
    assert job['checkpoints'][str(curated['id'])]['state'] == 'pending'
    assert db.source(curated['id'])['last_refresh_at'] is None
    assert db.overview()['submissions'] == 0


@pytest.mark.parametrize('index_error', [False, True])
async def test_index_fetched_once_and_video_requests_follow_selected_order(db, settings, video, index_error):
    curated = next(source for source in db.sources() if source['source_type'] == 'songlist')
    db.save_songlist(curated, parse_songlist(payload(video, name='原歌单')))
    calls = []
    def handler(request):
        if str(request.url) == ENDPOINT:
            calls.append('index')
            if index_error:
                return httpx.Response(503)
            return httpx.Response(200, json=payload(video))
        path = request.url.path
        if path == '/x/web-interface/nav':
            data = {'wbi_img': {'img_url':'https://test.invalid/'+'a'*32+'.png', 'sub_url':'https://test.invalid/'+'b'*32+'.png'}}
        elif path == '/x/space/wbi/acc/info':
            mid = request.url.params['mid']
            calls.append('profile:'+mid)
            data = {'mid':int(mid), 'name':'测试'}
        elif path == '/x/space/wbi/arc/search':
            calls.append('uploads:'+request.url.params['mid'])
            data = {'list':{'vlist':[]}, 'page':{'count':0}}
        elif path == '/x/web-interface/view':
            calls.append('video')
            data = video
        elif path == '/x/tag/archive/tags':
            calls.append('tags')
            data = [{'tag_name':'法里达'}]
        else:
            raise AssertionError(path)
        return httpx.Response(200, json={'code':0, 'data':data})

    worker = Collector(db, settings, lambda _: BilibiliAdapter(settings, transport=httpx.MockTransport(handler)))
    job_id = worker.start([2, curated['id'], 1], 'incremental')['id']
    await worker.task
    job = db.job(job_id)
    expected_calls = ['index','profile:210887872','uploads:210887872']
    if index_error:
        assert job['state'] == 'failed' and job['errors'][0]['category'] == 'songlist'
        assert db.one('SELECT song_title FROM curated_songs WHERE source_id=? AND id=1', (curated['id'],))['song_title'] == '原歌单'
    else:
        expected_calls += ['video','tags']
        assert job['state'] == 'completed' and db.source(curated['id'])['submissions'] == 1
    assert calls == expected_calls + ['profile:394803911','uploads:394803911']
    if index_error:
        index_error = False
        calls.clear()
        worker.resume(job_id)
        await worker.task
        assert db.job(job_id)['state'] == 'completed'
        assert calls == ['index', 'video', 'tags']


@pytest.mark.parametrize('patch', [{'enabled':False}, {'url':'https://space.bilibili.com/987654'}])
async def test_source_changes_after_read_skip_video_lookup(db, settings, video, patch):
    curated = next(source for source in db.sources() if source['source_type'] == 'songlist')
    adapter = BilibiliAdapter(settings, transport=httpx.MockTransport(lambda _: httpx.Response(200,json=payload(video))))
    resolve = adapter.resolve_source
    listed = []
    async def resolve_source(source):
        if source['id'] == curated['id']:
            return await resolve(source)
        db.update_source(curated['id'], dict(patch))
        return {'uid':source['uid'], 'name':'测试', 'method':'fixture'}
    async def list_entries(source, page):
        listed.append(source['id'])
        return Page([],False,0)
    adapter.resolve_source = resolve_source
    adapter.list_entries = list_entries
    worker = Collector(db, settings, lambda _: adapter)
    job_id = worker.start([1, curated['id']], 'incremental')['id']
    await worker.task
    job = db.job(job_id)
    assert job['errors'][0]['category'] == 'source_changed' and job['state'] == 'failed'
    assert listed == [1] and db.source(curated['id'])['last_error'] is None


async def test_cancel_during_public_fetch_preserves_the_previous_index(db, settings, video):
    curated = next(source for source in db.sources() if source['source_type'] == 'songlist')
    db.save_songlist(curated, parse_songlist(payload(video, name='原歌单')))
    started = asyncio.Event()
    calls = []
    async def handler(request):
        calls.append(str(request.url))
        started.set()
        await asyncio.Event().wait()

    worker = Collector(db, settings, lambda _: BilibiliAdapter(settings, transport=httpx.MockTransport(handler)))
    job_id = worker.start([], 'incremental')['id']
    await asyncio.wait_for(started.wait(), 2)
    worker.cancel(job_id)
    await worker.task
    assert calls == [ENDPOINT]
    assert db.job(job_id)['state'] == 'cancelled'
    assert db.one('SELECT song_title FROM curated_songs WHERE id=1')['song_title'] == '原歌单'
