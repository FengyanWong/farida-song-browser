import httpx
import pytest

from farida.adapter import BilibiliAdapter, UpstreamError, parse_source, sign_wbi, validated_video


@pytest.mark.parametrize("url,kind",[("394803911","uploader"),("https://space.bilibili.com/394803911","uploader"),("https://space.bilibili.com/1/lists/2?type=season","season"),("https://space.bilibili.com/1/channel/seriesdetail?sid=2","series"),("https://space.bilibili.com/1/favlist?fid=2","favorites")])
def test_source_routes(url,kind):
    assert parse_source(url)["source_type"]==kind


@pytest.mark.parametrize("uid", ["UID: 394803911", "uid　394803911", "ＵＩＤ：３９４８０３９１１", "３９４８０３９１１"])
def test_labelled_uid_has_the_same_canonical_source(uid):
    assert parse_source(uid) == parse_source("394803911")


@pytest.mark.parametrize("url",["UID: 01", "UID: 1 UID: 2", "UID: https://example.com/1", "http://127.0.0.1:8000/","https://evil.com/123","https://space.bilibili.com.evil.com/123","https://user@space.bilibili.com/123","https://space.bilibili.com/123?fid=nan","file:///etc/passwd","0","-1"])
def test_source_rejects_arbitrary_destinations(url):
    with pytest.raises(ValueError):parse_source(url)


def test_wbi_reference_vector():
    result=sign_wbi({"foo":"114","bar":"514","baz":1919810},("7cd084941338484aae1ad9425b84077c","4932caff0ff746eab6f01bf08b70ac45"),1702204169)
    # Preimage: bar=514&baz=1919810&foo=114&wts=1702204169 + ea1db124af3c7062474693fa704f4ff8
    assert result["w_rid"]=="6149fdadf571698ca7e6a567265cd0ee"


@pytest.mark.parametrize("status,code",[(200,-352),(403,None),(412,None),(429,None)])
async def test_restriction_stops_without_retry(settings,status,code):
    calls=[]
    def handler(request):
        calls.append(request)
        return httpx.Response(status,json={"code":code,"message":"restricted"},headers={"Retry-After":"120"})
    adapter=BilibiliAdapter(settings,transport=httpx.MockTransport(handler))
    with pytest.raises(UpstreamError) as error:await adapter.get_video_details("BV1br4y1R7BP")
    assert error.value.category=="restricted" and len(calls)==1
    await adapter.close()


async def test_private_video_is_unavailable_but_not_an_account_restriction(settings):
    calls = []
    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={'code': 62012, 'message': '62012', 'data': None})
    adapter = BilibiliAdapter(settings, transport=httpx.MockTransport(handler))
    with pytest.raises(UpstreamError) as error:
        await adapter.get_video_details('BV1br4y1R7BP')
    assert error.value.category == 'unavailable' and error.value.code == 62012
    assert len(calls) == 1
    with pytest.raises(UpstreamError) as error:
        await adapter.get_video_tags('BV1br4y1R7BP')
    assert error.value.category == 'upstream'
    await adapter.close()


async def test_nav_can_supply_public_keys_without_login(settings):
    def handler(request):
        if request.url.path.endswith("nav"):
            return httpx.Response(200,json={"code":-101,"data":{"wbi_img":{"img_url":"https://i0.hdslb.com/bfs/wbi/"+"a"*32+".png","sub_url":"https://i0.hdslb.com/bfs/wbi/"+"b"*32+".png"}}})
        return httpx.Response(200,json={"code":0,"data":{"mid":1,"name":"test"}})
    adapter=BilibiliAdapter(settings,transport=httpx.MockTransport(handler))
    assert (await adapter.resolve_source({"source_type":"uploader","uid":"1"}))["uid"]=="1"
    await adapter.close()


def test_video_identity_and_part_validation(video):
    video["pages"][1]["cid"]=100
    with pytest.raises(UpstreamError):validated_video(video,video["bvid"])


def test_incomplete_part_list_is_rejected(video):
    video['videos']=3
    with pytest.raises(UpstreamError):validated_video(video,video['bvid'])


async def test_changed_response_is_not_empty_success(settings):
    adapter=BilibiliAdapter(settings,transport=httpx.MockTransport(lambda _:httpx.Response(200,json={"code":0,"data":{"nope":[]}})))
    with pytest.raises(UpstreamError) as error:await adapter.list_entries({"source_type":"season","uid":"1","collection_id":"2"},1)
    assert error.value.category=="schema"
    await adapter.close()


def test_retry_after_handles_seconds_dates_missing_and_unrepresentable_deadlines():
    from datetime import datetime, timezone
    from farida.adapter import retry_after

    received = datetime(2026, 9, 6, 10, 0, tzinfo=timezone.utc)
    expected = (90, '2026-09-06T10:01:30+00:00')
    assert retry_after('90', received) == expected
    assert retry_after('Sun, 06 Sep 2026 10:01:30 GMT', received) == expected
    assert retry_after('Sun, 06 Sep 2026 09:00:00 GMT', received)[0] == 0
    for invalid in (None, '', '-2', 'broken', 'nan'):
        assert retry_after(invalid, received) == (None, None)
    delay, deadline = retry_after('9' * 100, received)
    assert delay > 30 and deadline is None


@pytest.mark.parametrize('status,category', [(429,'restricted'), (503,'retry_later')])
async def test_explicit_retry_time_is_saved_without_a_second_request(settings, status, category):
    calls = []
    def limited(request):
        calls.append(request.url.path)
        return httpx.Response(status, headers={'Retry-After': 'Sun, 06 Sep 2099 10:01:30 GMT'})
    adapter = BilibiliAdapter(settings, transport=httpx.MockTransport(limited))
    try:
        with pytest.raises(UpstreamError) as error:
            await adapter.request('/test')
        details = error.value.as_dict()
        assert details['retry_at'] == '2099-09-06T10:01:30+00:00'
        assert details['category'] == category
        assert calls == ['/test']
    finally:
        await adapter.close()
