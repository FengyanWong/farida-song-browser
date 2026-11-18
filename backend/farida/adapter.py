"""Isolated, read-only Bilibili web metadata adapter.

These web routes are not a promise of unrestricted public API access. A risk
control or login response stops collection; no alternative-host or proxy retry.
"""
import asyncio
import hashlib
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import PurePosixPath
from urllib.parse import parse_qs, quote, urlencode, urlsplit

import httpx

from .config import Settings
from .session import SessionStore
from .songlist import URL as SONGLIST_URL, ENDPOINT as SONGLIST_ENDPOINT, parse_songlist

BVID = re.compile(r"^BV[0-9A-Za-z]{10}$")
MIXIN_ORDER = (46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13)


class UpstreamError(Exception):
    def __init__(self, category: str, message: str, *, status=None, code=None, retry_at=None):
        super().__init__(message)
        self.category, self.status, self.code = category, status, code
        self.retry_at = retry_at

    def as_dict(self):
        info = {"category": self.category, "message": str(self), "http_status": self.status, "upstream_code": self.code}
        if self.retry_at is not None:
            info["retry_at"] = self.retry_at
        return info


def retry_after(header, received):
    """Return the requested delay and a UTC timestamp suitable for a saved job."""
    if not header:
        return None, None
    value = header.strip()
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value):
        delay = float(value)
        try:
            deadline = received + timedelta(seconds=delay)
        except OverflowError:
            return delay, None
    else:
        try:
            deadline = parsedate_to_datetime(value)
            if deadline.tzinfo is None:
                return None, None
            deadline = deadline.astimezone(timezone.utc)
            delay = (deadline - received).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return None, None
    return max(0, delay), deadline.isoformat(timespec="seconds")


@dataclass
class Page:
    bvids: list[str]
    has_more: bool
    total: int | None = None
    resource_ids: list[str] | None = None


def numeric_id(value) -> str:
    text = str(value)
    if not re.fullmatch(r"[1-9][0-9]{0,19}", text):
        raise ValueError("请输入有效的数字 UID 或合集 ID")
    return text


def parse_source(value: str) -> dict:
    value = value.strip()
    if value in {SONGLIST_URL, SONGLIST_URL.rstrip('/')}:
        return {'source_type': 'songlist', 'uid': None, 'collection_id': None, 'canonical_url': SONGLIST_URL}
    if value.isdecimal():
        uid = numeric_id(value)
        return {"source_type": "uploader", "uid": uid, "collection_id": None, "canonical_url": f"https://space.bilibili.com/{uid}"}
    parsed = urlsplit(value)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port or parsed.hostname not in {"space.bilibili.com", "www.bilibili.com"}:
        raise ValueError("仅接受 HTTPS 哔哩哔哩个人空间、合集、列表或收藏夹链接")
    parts = parsed.path.strip("/").split("/")
    query = parse_qs(parsed.query)
    uid = numeric_id(parts[0]) if parsed.hostname == "space.bilibili.com" and parts else None
    kind, collection = "uploader", None
    if uid:
        if query.get("fid"):
            kind, collection = "favorites", numeric_id(query["fid"][0])
        elif query.get("sid"):
            kind = "season" if "collectiondetail" in parsed.path else "series"
            collection = numeric_id(query["sid"][0])
        elif len(parts) >= 3 and parts[1] == "lists":
            kind, collection = query.get("type", ["season"])[0], numeric_id(parts[2])
            if kind not in {"season", "series"}:
                raise ValueError("不支持此列表类型")
        elif len(parts) > 1 and parts[1] not in {"video", "upload", ""}:
            raise ValueError("请使用带有合集或收藏夹 ID 的完整链接")
    elif len(parts) == 3 and parts[:2] == ["medialist", "play"]:
        uid = numeric_id(parts[2])
        kind = {"space_series": "series", "space_collection": "season"}.get(query.get("business", [""])[0])
        collection = numeric_id(query.get("business_id", [""])[0])
        if not kind:
            raise ValueError("不支持此播放列表类型")
    else:
        raise ValueError("无法识别来源；请粘贴个人空间、合集或收藏夹链接")
    if kind == "uploader":
        url = f"https://space.bilibili.com/{uid}"
    elif kind == "favorites":
        url = f"https://space.bilibili.com/{uid}/favlist?fid={collection}"
    else:
        url = f"https://space.bilibili.com/{uid}/lists/{collection}?type={kind}"
    return {"source_type": kind, "uid": uid, "collection_id": collection, "canonical_url": url}


def sign_wbi(params: dict, keys: tuple[str, str], timestamp: int | None = None) -> dict:
    material = "".join(keys)
    if len(material) != 64:
        raise UpstreamError("schema", "Bilibili WBI key format changed")
    salt = "".join(material[i] for i in MIXIN_ORDER)
    clean = {k: re.sub(r"[!'()*]", "", str(v)) for k, v in {**params, "wts": timestamp or int(time.time())}.items()}
    encoded = urlencode(sorted(clean.items()), quote_via=quote)
    return {**clean, "w_rid": hashlib.md5((encoded + salt).encode()).hexdigest()}


def validated_video(data: dict, bvid: str) -> dict:
    if not isinstance(data, dict) or data.get("bvid") != bvid or not BVID.fullmatch(bvid):
        raise UpstreamError("schema", "Video identity missing or mismatched")
    owner = data.get("owner") or {}
    pages = data.get("pages")
    if not str(owner.get("mid", "")).isdigit() or not owner.get("name") or not isinstance(pages, list) or not pages:
        raise UpstreamError("schema", "Video uploader or part metadata missing")
    if not data.get("title") or not isinstance(data.get("pubdate"), int):
        raise UpstreamError("schema", "Video title or upload time missing")
    if isinstance(data.get("videos"), int) and data["videos"] > 0 and data["videos"] != len(pages):
        raise UpstreamError("schema", "Video metadata contains an incomplete part list")
    cids, numbers = set(), set()
    for part in pages:
        if type(part.get("cid")) is not int or part["cid"] <= 0 or type(part.get("page")) is not int or part["page"] < 1:
            raise UpstreamError("schema", "Invalid video part identity")
        if part["cid"] in cids or part["page"] in numbers:
            raise UpstreamError("schema", "Duplicate video part identity")
        cids.add(part["cid"])
        numbers.add(part["page"])
    return data


def video_has_uploader(data: dict, uid: str) -> bool:
    """Match the primary owner or an explicit coauthor in video-detail metadata."""
    uid = str(uid)
    if not re.fullmatch(r"[1-9][0-9]{0,19}", uid):
        return False
    owner = data.get("owner")
    if isinstance(owner, dict) and str(owner.get("mid")) == uid:
        return True
    staff = data.get("staff")
    return isinstance(staff, list) and any(
        isinstance(member, dict) and str(member.get("mid")) == uid
        for member in staff
    )


class BilibiliAdapter:
    def __init__(self, settings: Settings, transport=None):
        self.settings = settings
        self.transport, self.songlist = transport, None
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Referer": "https://www.bilibili.com/"}
        cookie = SessionStore(settings).cookie_header()
        if cookie:
            headers["Cookie"] = cookie
        self.client = httpx.AsyncClient(base_url="https://api.bilibili.com", headers=headers, timeout=settings.request_timeout, follow_redirects=False, transport=transport)
        self.last_request = 0.0
        self.keys = None

    async def close(self):
        await self.client.aclose()

    async def request(self, path: str, params=None, *, allow_nav=False):
        for attempt in range(3):
            await asyncio.sleep(max(0, self.settings.request_interval - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            try:
                response = await self.client.get(path, params=params)
            except httpx.RequestError as exc:
                if attempt < 2:
                    await asyncio.sleep(2 ** attempt)
                    continue
                raise UpstreamError("network", f"Network request failed ({type(exc).__name__})") from None
            if response.status_code in {401,403,412,429} or response.status_code >= 500:
                delay, retry_at = retry_after(response.headers.get("Retry-After"), datetime.now(timezone.utc))
                if response.status_code < 500:
                    category = "authentication" if response.status_code == 401 else "restricted"
                    raise UpstreamError(category, f"Bilibili restricted access (HTTP {response.status_code})",
                                        status=response.status_code, retry_at=retry_at)
                if delay is not None and delay > 30:
                    raise UpstreamError("retry_later", "Bilibili requested a later retry; collection stopped",
                                        status=response.status_code, retry_at=retry_at)
                if attempt < 2:
                    await asyncio.sleep(2 ** attempt if delay is None else delay)
                    continue
                raise UpstreamError("server", "Bilibili server unavailable after 3 attempts",
                                    status=response.status_code, retry_at=retry_at)
            if response.status_code != 200:
                raise UpstreamError("http", f"Unexpected Bilibili HTTP {response.status_code}", status=response.status_code)
            try:
                payload = response.json()
            except ValueError:
                raise UpstreamError("schema", "Bilibili returned non-JSON metadata", status=response.status_code) from None
            if not isinstance(payload, dict) or "code" not in payload:
                raise UpstreamError("schema", "Bilibili response envelope changed")
            code = payload["code"]
            if allow_nav and code == -101 and isinstance(payload.get("data"), dict) and payload["data"].get("wbi_img"):
                return payload["data"]
            if code != 0:
                # This is a per-video visibility status, not a request-rate or
                # login failure. Do not generalize the code to other endpoints.
                if code == 62012 and path == '/x/web-interface/view':
                    raise UpstreamError('unavailable', '视频仅 UP 主自己可见', code=code)
                category = "authentication" if code == -101 else "unavailable" if code in {-404,62002,62004} else "restricted" if code in {-111,-352,-401,-403,-412,-509,86038} else "upstream"
                raise UpstreamError(category, f"Bilibili response code {code}; collection stopped", code=code)
            if payload.get("data") is None:
                raise UpstreamError("schema", "Bilibili response has no metadata")
            return payload["data"]
        raise AssertionError("Retry loop exhausted")

    async def signed(self, path, params):
        if self.keys is None:
            nav = await self.request("/x/web-interface/nav", allow_nav=True)
            try:
                self.keys = tuple(PurePosixPath(urlsplit(nav["wbi_img"][k]).path).stem for k in ("img_url", "sub_url"))
            except (KeyError, TypeError):
                raise UpstreamError("schema", "WBI signing keys unavailable") from None
        return await self.request(path, sign_wbi(params, self.keys))

    async def resolve_source(self, source):
        if source['source_type'] == 'songlist':
            return {'name': 'CLANNADOR 歌单', 'uid': None, 'method': 'public_curated_songlist', 'songs': await self.get_songlist()}
        if source["source_type"] == "search":
            return {"name": source["display_name"], "uid": None, "method": "configured_tag_search"}
        uid = str(source["uid"])
        data = await self.signed("/x/space/wbi/acc/info", {"mid": uid})
        if str(data.get("mid")) != uid or not data.get("name"):
            raise UpstreamError("identity", "Profile UID does not match configured source")
        if source["source_type"] == "series":
            series = await self.request("/x/series/series", {"series_id": source["collection_id"]})
            meta = series.get("meta", {})
            if str(meta.get("mid")) != uid or str(meta.get("series_id")) != str(source["collection_id"]):
                raise UpstreamError("identity", "Series owner or ID mismatch")
        return {"name": data["name"], "uid": uid, "method": "profile_metadata"}

    async def get_songlist(self):
        if self.songlist is None:
            # Separate client: never forward Bilibili cookies to the song site.
            try:
                async with httpx.AsyncClient(timeout=self.settings.request_timeout, follow_redirects=False, transport=self.transport) as client:
                    response = await client.post(SONGLIST_ENDPOINT, json={'url': 'fareeda.songlist.cc', 'uid': 0},
                                                 headers={'Origin': SONGLIST_URL.rstrip('/'), 'Referer': SONGLIST_URL})
                response.raise_for_status()
                self.songlist = parse_songlist(response.json())
            except httpx.HTTPError:
                raise UpstreamError('songlist', '歌单网站暂时无法连接，已保留本机资料，请稍后更新。') from None
            except ValueError as exc:
                message = str(exc) if type(exc) is ValueError else '歌单响应格式有变化，已保留本机资料。'
                raise UpstreamError('songlist', message) from None
        return self.songlist

    async def get_video_details(self, bvid):
        if not BVID.fullmatch(bvid):
            raise ValueError("Invalid BVID")
        return validated_video(await self.request("/x/web-interface/view", {"bvid": bvid}), bvid)

    async def get_video_tags(self, bvid):
        tags = await self.request("/x/tag/archive/tags", {"bvid": bvid})
        if not isinstance(tags, list) or any(not isinstance(t, dict) or not isinstance(t.get("tag_name"), str) for t in tags):
            raise UpstreamError("schema", "Video tag response format changed")
        return [t["tag_name"] for t in tags]

    async def list_entries(self, source, page):
        kind = source["source_type"]
        uid, collection = source.get("uid"), source.get("collection_id")
        size = 30
        resource_ids = None
        try:
            if kind == 'songlist':
                bvids = list(dict.fromkeys(row['bvid'] for row in await self.get_songlist() if row['bvid']))
                return Page(bvids[(page-1)*size:page*size], page*size < len(bvids), len(bvids))
            elif kind == "uploader":
                data = await self.signed("/x/space/wbi/arc/search", {"mid": uid, "pn": page, "ps": size, "order": "pubdate"})
                rows, total = data["list"]["vlist"], int(data["page"]["count"])
                more = page * size < total
            elif kind == "season":
                data = await self.request("/x/polymer/web-space/seasons_archives_list", {"mid": uid, "season_id": collection, "page_num": page, "page_size": size, "sort_reverse": "false"})
                meta = data["meta"]
                if str(meta.get("mid")) != str(uid) or str(meta.get("season_id")) != str(collection):
                    raise UpstreamError("identity", "Collection owner or season ID mismatch")
                rows, total = data["archives"], int(data["page"]["total"])
                more = page * size < total
            elif kind == "series":
                data = await self.request("/x/series/archives", {"mid": uid, "series_id": collection, "pn": page, "ps": size, "only_normal": "true", "sort": "desc"})
                rows, total = data["archives"], int(data["page"]["total"])
                more = page * size < total
            elif kind == "favorites":
                data = await self.request("/x/v3/fav/resource/list", {"media_id": collection, "pn": page, "ps": 20, "order": "mtime", "platform": "web"})
                info = data["info"]
                if str(info["upper"]["mid"]) != str(uid) or str(info["id"]) != str(collection):
                    raise UpstreamError("identity", "Favorites owner or ID mismatch")
                # A page of articles or audio advances the folder cursor too.
                # Keep its resource IDs for loop detection; only collect videos.
                entries = data.get("medias")
                if entries is None:
                    entries = []
                if not isinstance(entries, list):
                    raise UpstreamError("schema", "Favorites media list format changed")
                rows, resource_ids = [], []
                for entry in entries:
                    if not isinstance(entry, dict) or type(entry.get("type")) is not int:
                        raise UpstreamError("schema", "Favorites media type missing")
                    if entry["type"] == 2:
                        rows.append(entry)
                        resource_ids.append(entry["bvid"])
                    else:
                        resource_ids.append(f"{entry['type']}:{numeric_id(entry.get('id'))}")
                resource_ids = list(dict.fromkeys(resource_ids))
                total, more = int(info["media_count"]), bool(data["has_more"])
            elif kind == "search":
                data = await self.signed("/x/web-interface/wbi/search/type", {"search_type": "video", "keyword": source["query"], "page": page, "page_size": 20, "order": "pubdate"})
                if data.get("v_voucher"):
                    raise UpstreamError("restricted", "Search requires Bilibili access verification")
                rows, total = data.get("result") or [], int(data["numResults"])
                more = page < int(data["numPages"])
            else:
                raise ValueError("Unsupported source type")
            if not isinstance(rows, list) or any(not BVID.fullmatch(str(r.get("bvid", ""))) for r in rows):
                raise UpstreamError("schema", "Enumeration returned invalid video identities")
            return Page(list(dict.fromkeys(r["bvid"] for r in rows)), more, total, resource_ids)
        except (KeyError, TypeError, ValueError) as exc:
            raise UpstreamError("schema", f"{kind} pagination format changed ({type(exc).__name__})") from None
