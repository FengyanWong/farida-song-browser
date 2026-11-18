import re
import unicodedata

VERSION = "rules-3"
SINGING_COLLECTION_TYPES = frozenset({"season", "series", "favorites"})


def normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value or "").casefold().split())


def is_singing_collection(source):
    return (source["source_type"] in SINGING_COLLECTION_TYPES
            and bool(source.get("singing_collection")) and source.get("verification_status") == "verified")


def classify(video, part, tags, source, *, curated_song=None):
    title = video["title"]
    part_title = part.get("part", "")
    context = normalize(" ".join([title, video.get("desc", ""), *tags]))
    local = normalize(part_title if len(video["pages"]) > 1 else title)
    performer = any(alias in context for alias in ("法里达", "farida"))
    collection = is_singing_collection(source)
    music_pattern = r"歌切|翻唱|直播翻唱|清唱|弹唱|演唱|合唱|歌回|唱歌|纯享|cover|acoustic|歌曲|音乐合集|歌单"
    music = bool(re.search(music_pattern, normalize(title + " " + part_title + " " + " ".join(tags)))) or bool(collection)
    song = re.search(r"《([^》]{1,120})》", part_title if len(video["pages"]) > 1 else title)
    parent_song = re.search(r"《([^》]{1,120})》", title)
    negative = bool(re.search(r"杂谈|聊天|打游戏|游戏实况|整活|鬼畜|反应|reaction|meme|闲聊", local))
    title_out = curated_song or (song.group(1).strip() if song else part_title.strip() if len(video["pages"]) > 1 else title)
    if source["source_type"] == "search":
        required = {normalize(t) for t in source.get("required_tags", [])}
        if not required.issubset({normalize(t) for t in tags}):
            return title_out, "needs_review", "搜索发现；视频实际标签未同时包含所需标签", VERSION
    if negative and not (music or song):
        return title_out, "excluded", "标题表明是聊天、游戏或其他非歌唱内容", VERSION
    if negative:
        return title_out, "needs_review", "歌唱与非歌唱信号同时存在，需要人工确认", VERSION
    if curated_song:
        return curated_song, 'included', 'CLANNADOR 歌单收录；视频与分 P 已核对', VERSION
    if collection:
        return title_out, "included", "此片段属于已核对并标记为法里达歌唱合集的来源", VERSION
    if performer and (music or song or parent_song):
        return title_out, "included", "法里达身份信号与歌名／歌唱信号同时存在", VERSION
    if not performer:
        return title_out, "needs_review", "尚无足够证据确认演唱者是法里达", VERSION
    return title_out, "needs_review", "已发现法里达相关内容，尚未确认是歌唱片段", VERSION
