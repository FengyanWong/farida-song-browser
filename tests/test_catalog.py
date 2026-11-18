from copy import deepcopy

import pytest

from farida.classifier import classify
from farida.db import Database


def test_default_sources_and_pending_identity(db):
    assert {s["uid"] for s in db.sources() if s["source_type"]=="uploader"} == {"394803911","210887872","290566607","475349220"}
    assert all(s["verification_status"]=="pending" for s in db.sources())
    discovery=next(s for s in db.sources() if s['source_type'] == 'search')
    assert discovery["required_tags"] == ["法里达","直播切片"]


def test_repeat_scan_and_cross_source_dedup(db,source,video):
    db.save_video(source,video,["法里达","翻唱"])
    db.save_video(source,video,["法里达","翻唱"])
    collection=db.add_source("歌单","https://space.bilibili.com/290566607/favlist?fid=123")
    db.save_video(collection,video,["法里达","翻唱"])
    assert db.overview()["submissions"]==1
    assert db.overview()["entries"]==2
    assert len(db.clip("BV1br4y1R7BP:100")["sources"])==2
    assert db.clip("BV1br4y1R7BP:100")["uploader_uid"]=="394803911"


def test_cid_mapping_and_manual_overrides_survive(db,source,video):
    db.save_video(source,video,["法里达","翻唱"])
    identity=video["bvid"]+":100"
    db.annotate([identity],{"display_song_title":"My custom title","inclusion_status":"excluded","song_group":"Group","notes":"keep me"})
    db.bookmark(identity,True)
    video["pages"].reverse()
    for number,part in enumerate(video["pages"],1):part["page"]=number
    db.save_video(source,video,["法里达","翻唱"])
    row=db.clip(identity)
    assert row["playback_url"].endswith("?p=2")
    assert row["display_song_title"]=="My custom title"
    assert row["inclusion_status"]=="excluded"
    assert row["song_group"]=="Group" and row["notes"]=="keep me" and row["bookmarked"]==1
    assert db.clip(video["bvid"]+":200")["playback_url"].endswith("?p=1")


def test_removed_part_does_not_play_wrong_part(db,source,video):
    db.save_video(source,video,[])
    video["pages"]=video["pages"][:1]
    db.save_video(source,video,[])
    assert db.clip(video["bvid"]+":200")["playback_url"] is None
    assert db.overview()["entries"]==1


@pytest.mark.parametrize("query,expected",[("月亮",1),("夜に",1),("ＦＡＲＩＤＡ",2),("离落",2),("' OR 1=1 --",0),("%",0),("_",0)])
def test_unicode_parameterized_substring_search(db,source,video,query,expected):
    db.save_video(source,video,["法里达","直播切片"])
    assert db.clips(q=query)["total"]==expected


@pytest.mark.parametrize("performer", ["Fareeda", "法里達", "法里达", "Farida"])
def test_performer_aliases_find_original_spelling(db, source, video, performer):
    video["title"] = f"{performer} 直播翻唱"
    db.save_video(source, video, [])
    for query in ("ＦＡＲＥＥＤＡ", "Farida", "法里达", "法里達"):
        assert db.clips(q=query, status="all")["total"] == 2


def test_latin_spaces_punctuation_and_sort_entire_set(db,source,video):
    for index,title in enumerate(["Zulu","Ain't No Sunshine","Abba"],1):
        sample=deepcopy(video);sample["bvid"]=f"BV{index:010d}";sample["pages"]=sample["pages"][:1]
        sample["title"]=f"法里达翻唱《{title}》";sample["pubdate"]+=index*86400
        db.save_video(source,sample,[])
    assert db.clips(q="ain't no")["total"]==1
    assert db.clips(sort="title",page_size=1)["items"][0]["display_song_title"]=="Abba"
    assert db.clips(sort="title_desc",page_size=1)["items"][0]["display_song_title"]=="Zulu"
    assert db.clips(sort="oldest",page=2,page_size=1)["items"][0]["video_bvid"]=="BV0000000002"
    assert db.clips(after="2023-11-17")["total"]==1


def test_missing_stats_and_scope(db,source,video):
    db.save_video(source,video,[])
    row=db.clip(video["bvid"]+":100")
    assert row["statistics"]["coin"] is None and row["statistics"]["favorite"] is None
    assert row["statistics"]["view"]==42 and row["stats_scope"]=="submission"
    assert row["stats_fetched_at"] and "details" in row["provenance"]


def test_identity_and_persistence(db,source,video,settings):
    db.save_video(source,video,[])
    db.bookmark(video["bvid"]+":100",True)
    restarted=Database(settings.db_path);restarted.initialize()
    assert restarted.clips(bookmarked=True)["total"]==1
    bad=deepcopy(video);bad["owner"]["mid"]=1
    with pytest.raises(ValueError):restarted.save_video(source,bad,[])
    assert restarted.overview()["entries"]==2


def test_coauthor_membership_preserves_primary_uploader_and_user_data(db, source, video):
    coauthor = db.source(2)
    video['staff'] = [{'mid': int(coauthor['uid']), 'name': 'CLANNADOR', 'title': '导演'}]
    db.save_video(source, video, ['法里达', '翻唱'])
    clip_id = video['bvid'] + ':100'
    db.bookmark(clip_id, True)
    db.annotate([clip_id], {'display_song_title': '我的曲名'})
    original = db.one('SELECT * FROM videos WHERE bvid=?', (video['bvid'],))
    db.reuse_video(coauthor, original)
    clip = db.clip(clip_id)
    assert clip['uploader_uid'] == source['uid']
    assert clip['uploader_name'] == video['owner']['name']
    assert len(clip['sources']) == 2 and db.overview()['submissions'] == 1
    assert clip['bookmarked'] and clip['display_song_title'] == '我的曲名'
    assert clip['fetched_at'] == original['fetched_at']


@pytest.mark.parametrize('staff', [None, {'mid': 394803911}, ['394803911'], [{'name': '离落'}], [{'mid': 1}], [{'mid': True}]])
def test_union_flag_or_name_alone_cannot_verify_uploader(db, source, video, staff):
    video['owner'] = {'mid': 123, 'name': '另一位 UP 主'}
    video.update(staff=staff, is_union_video=1)
    with pytest.raises(ValueError):
        db.save_video(source, video, ['法里达'])
    assert db.overview()['submissions'] == 0


@pytest.mark.parametrize("change", ["unmark", "retarget", "remove_membership", "unverify"])
def test_reclassification_uses_current_collection_and_curated_evidence(db, video, change):
    collection = db.add_source("歌唱合集", "https://space.bilibili.com/123/lists/456", singing_collection=True)
    db.verified_source(collection["id"], {"uid": "123", "name": "歌唱合集", "method": "fixture"})
    marked = db.source(collection["id"])
    uploader = db.source(1)
    db.verified_source(1, {"uid": uploader["uid"], "name": uploader["display_name"], "method": "fixture"})
    songlist = next(s for s in db.sources() if s["source_type"] == "songlist")
    db.save_songlist(songlist, [{"id": 1, "bvid": video["bvid"], "song_title": "田间", "original_artist": "", "language": "", "style": ""}])
    video.update(title="工作室日常", desc="")
    video["pages"][0]["part"] = "现场记录"
    video["pages"][1]["part"] = "田间"
    plain, curated = [f"{video['bvid']}:{part['cid']}" for part in video["pages"]]
    db.save_video(marked, video, [])
    db.save_video(uploader, video, [])
    assert db.clip(plain)["inclusion_status"] == "included"
    if change == "unmark":
        db.update_source(marked["id"], {"singing_collection": False})
        # A caller can still hold a source dictionary from before the edit.
        db.save_video(marked, video, [])
        assert db.clip(plain)["inclusion_status"] == "needs_review"
    elif change == "retarget":
        db.update_source(marked["id"], {"url": "https://space.bilibili.com/123/lists/999"})
        db.verified_source(marked["id"], {"uid": "123", "name": "另一合集", "method": "fixture"})
    elif change == "remove_membership":
        db.execute("DELETE FROM memberships WHERE source_id=? AND video_bvid=?", (marked["id"], video["bvid"]))
    else:
        db.execute("UPDATE sources SET verification_status='pending' WHERE id=?", (marked["id"],))
    discovery = next(s for s in db.sources() if s["source_type"] == "search")
    db.save_video(discovery, video, [])
    assert db.clip(plain)["inclusion_status"] == "needs_review"
    assert db.clip(curated)["inclusion_status"] == "included" and "CLANNADOR" in db.clip(curated)["classification_reason"]


def test_discovery_only_rechecks_required_tags_without_reusing_previous_decision(db, video):
    discovery = next(s for s in db.sources() if s["source_type"] == "search")
    clip_id = video["bvid"] + ":100"
    for tags, status in [(["法里达"], "needs_review"), (["法里达", "直播切片"], "included"), (["直播切片"], "needs_review")]:
        db.save_video(discovery, video, tags)
        assert db.clip(clip_id)["inclusion_status"] == status


def test_classifier_ambiguity_and_search_tags(video,source):
    talking=deepcopy(video);talking["title"]="法里达 聊天《月亮代表我的心》";talking["pages"]=talking["pages"][:1]
    assert classify(talking,talking["pages"][0],[],source)[1]=="needs_review"
    assert classify(video,video["pages"][1],[],source)[1]=="included"
    other=deepcopy(video);other["title"]="另一个人翻唱";other["desc"]=""
    assert classify(other,other["pages"][1],[],source)[1]=="needs_review"
    discovery={**source,"source_type":"search","required_tags":["法里达","直播切片"]}
    assert classify(video,video["pages"][0],["法里达"],discovery)[1]=="needs_review"
    assert classify(video,video["pages"][0],["法里达","直播切片"],discovery)[1]=="included"


def test_title_override_does_not_freeze_classifier(db,source,video):
    db.save_video(source,video,[])
    db.annotate([video["bvid"]+":100"],{"display_song_title":"Personal"})
    video["title"]="another performer";video["desc"]=""
    db.save_video(source,video,[])
    assert db.clip(video["bvid"]+":100")["inclusion_status"]=="needs_review"


def test_bulk_is_atomic(db,source,video):
    db.save_video(source,video,[])
    with pytest.raises(KeyError):db.annotate([video["bvid"]+":100","missing"],{"inclusion_status":"excluded"})
    assert db.clip(video["bvid"]+":100")["inclusion_status"]=="included"


def test_multipart_parent_song_does_not_replace_other_parts(db,source,video):
    video['title']='法里达翻唱《月亮代表我的心》以及其他歌曲'
    db.save_video(source,video,[])
    assert db.clip(video['bvid']+':200')['display_song_title']=='夜に駆ける'


def test_english_performer_alias_matches_both_scripts(db,source,video):
    video['title']='Farida acoustic cover';video['desc']=''
    db.save_video(source,video,[])
    assert db.clips(q='法里达')['total']==2
    assert db.clips(q='farida')['total']==2


@pytest.mark.parametrize("query,expected_parts", [
    ("BV1br4y1R7BP", [1, 2]),
    (" https://www.bilibili.com/video/BV1br4y1R7BP/?p=2&from=share ", [2]),
    ("https://m.bilibili.com/video/BV1br4y1R7BP?share_source=copy#details", [1, 2]),
    ("https://www.bilibili.com/video/BV1br4y1R7BP?p=0", []),
    ("https://www.bilibili.com/video/BV1br4y1R7BP?p=1&p=2", []),
    ("https://example.com/video/BV1br4y1R7BP", []),
    ("BV1BR4Y1R7BP", []),
])
def test_search_bv_and_shared_part_links(db, source, video, query, expected_parts):
    db.save_video(source, video, [])
    plain = db.clips(q=query)["items"]
    grouped = db.grouped_clips(q=query)["items"]
    queue = db.playback_queue(q=query)
    for items in (plain, grouped, queue):
        assert sorted(item["part_number"] for item in items) == expected_parts
    assert db.clips(q=query, bookmarked=True)["total"] == 0
