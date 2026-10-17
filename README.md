# 法里达 · 歌切收藏

一个轻量的哔哩哔哩法里达歌切收藏工具。采用中文深色界面，集中显示歌切封面、
标题、UP 主和上传时间，点击标题即可在系统默认浏览器打开原视频对应分 P。
只收集链接与视频信息，不下载或播放音视频。

**[下载 Windows v0.0.1](https://github.com/FengyanWong/farida-song-browser/releases/tag/v0.0.1)**：
下载 EXE 后双击运行，无需安装 Python。使用时保持小启动窗口开启，首次扫码登录哔哩哔哩。
打开后自动检查已启用来源，并保留本地收藏和修正。

- **随附歌切目录**：1,075 个已加载视频、1,286 条片段，其中已收录 1,037 条；
  TXT 保留全部 1,077 个不同 BV 链接，包括两个尚未取得视频信息的歌单引用。
- **来源**：离落、CLANNADOR、阿见、稻草仁尔，以及「法里达」「直播切片」标签发现。
  [小法的歌单](https://fareeda.songlist.cc/)由 **CLANNADOR** 整理，每次采集更新时同步读取。
- **本地保存**：支持搜索、筛选、星标、收录确认、CSV 导出及采集断点恢复。
  发行包不包含原用户的登录信息、私人备注或收藏记录，也不会覆盖已有目录。
- **Frida 小伙伴**：默认附带宠物，支持 v1 / v2 精灵图，可隐藏或关闭动画。

软件使用 **GNU GPL 3.0 only** 开源许可。详见 [完整许可证](LICENSE)、
[中文使用说明](使用说明.txt)、[随附目录说明](data/README.md)及[第三方署名](THIRD_PARTY_NOTICES.md)。

## English overview

A small, local collector for Farida / 法里达 singing clips on Bilibili. The dark-only interface lists **video covers, clip titles, upload times, and uploaders**. Clicking a title asks Windows to open the verified original video and current part in the **system default browser**.

The app saves metadata, bookmarks, and corrections. It does not download or play audio/video. Frida is included as an optional animated companion.

## Download v0.0.1 for Windows

Download **FaridaSongBrowser-0.0.1-windows-x64.exe** from the
[GitHub release](https://github.com/FengyanWong/farida-song-browser/releases/tag/v0.0.1).
This is a standalone **Windows x64** application: no Python installation, installer,
Node.js, or database server is needed. A ZIP with the executable, instructions,
link lists, and license notices is also available. This first build is unsigned.

1. Double-click the EXE. Your default browser opens the local interface automatically.
   Keep its small launcher window open while using the app; close it to stop.
2. On a new computer, the bundled collection loads automatically: **1,286 clips from
   1,075 videos**, including **1,037 included singing clips**, 247 awaiting review,
   and 2 excluded clips. The separate link list preserves **1,077 distinct BV links**,
   including two song-list references whose video metadata could not be loaded.
3. Sign in by scanning the QR code with Bilibili's mobile app. Existing valid sessions
   are verified quietly on later launches; no repeated QR scan is needed.
4. After login verification, all enabled sources are checked once. Click any clip title
   to open its original Bilibili video and part in your default browser.

The snapshot contains public metadata only. Login sessions, bookmarks, notes, and
job logs are not distributed. Existing catalogs are preserved when upgrading.
See [the bundled collection](data/README.md), [中文使用说明](使用说明.txt), and
[third-party notices](THIRD_PARTY_NOTICES.md). The project source is licensed under
[GNU GPL version 3 only](LICENSE), without warranty.

### Run from source

Install Python 3.10 or newer and double-click **Start Farida.cmd**. The launcher creates
an environment and installs dependencies on its first run. For the exact release
runtime, use Python 3.12 with `requirements-lock.txt`.

The app uses port 8765 by default, selects a free port if needed, and remembers it.
The address is printed in the launcher window. The catalog and saved login are kept
in your own app-data directory, separate from the downloaded program.

## Use the collector

- There are only two tabs: **片段收藏** and **采集来源**.
- **片段收藏** lists included singing clips by default. Its filter menu also offers **星标收藏**, **待确认**, **全部候选**, and **已排除**. Search song titles, original titles, part titles, uploader names, tags, and the Farida alias. Search uses the local catalog; opening the app requires online login verification.
- Each clip shows its parent video's cover, using the `pic` URL already collected with video metadata. Images load lazily from Bilibili's image CDN and can use the browser cache; no extra metadata lookup is made. Missing or failed images use a placeholder, so titles remain usable offline. The local UI preview has a persistent **预览模式** notice and uses **演示** clips and a labeled demo cover, separate from the real catalog.
- Click a clip's star to bookmark it. Select **待确认** for candidates with insufficient or conflicting singing/performer evidence. Open details to include, exclude, rename, group versions, or add notes. Manual choices survive scans. Bulk actions affect only the explicitly selected rows.
- **采集来源**: configure UIDs, collections, series, and favorites; enable/disable sources, view errors, cancel a job, or resume it from its saved checkpoint. Startup updates check recent content once per app process after login verification; reloading the page or opening another tab does not trigger another scan. Disabled sources are skipped. With all sources disabled, no collection starts.
- **导出**: CSV of the complete current search/filter selection, including pages not currently visible. JSON is available at `/api/export?format=json` with the same query parameters.
- The upload-time column uses your browser's time zone. Date filters use whole UTC days and are labeled accordingly. An upload date is never treated as a performance date.
- Clicking a title uses Python's system-browser handler. If no handler is available, a visible link lets you open the original video manually. Ctrl/Cmd-click uses the ordinary link behavior of your current browser.

### Configured sources

| Source | UID | Starting status |
| --- | --- | --- |
| 离落 | 394803911 | User-supplied UID; pending live identity check |
| CLANNADOR | 210887872 | Plan's research lead; pending live identity check |
| 阿见 | 290566607 | User-supplied UID; pending live identity check |
| 稻草仁尔 | 475349220 | User-supplied UID; pending live identity check |
| 标签发现 | Search: 法里达 直播切片 | Bounded cross-uploader discovery |
| CLANNADOR 歌单 | [小法的歌单](https://fareeda.songlist.cc/) | Public song index; credited to CLANNADOR |

The song-list source reads the site's public index on every collection update, including the normal startup update. It stores song names, original artists, language, style, and BV references. Entries without a video link remain in the local index without invented clips or upload dates. The current index is fully enumerated during updates; existing available videos reuse verified local metadata, while new BV IDs receive Bilibili details, covers, upload times, and part checks. **完整重新扫描** also refreshes existing video metadata. Bilibili cookies are never sent to the song-list service. A failed site fetch preserves the previous index.

Clip rows, details, and exports credit **CLANNADOR** and retain the original song-list link. The actual video's uploader is preserved separately. Unambiguous song titles can supplement video titles; multipart videos are not all renamed from a single BV reference, and manual edits always take priority.

Uploader spaces can contain joint submissions. Membership accepts either the primary owner UID or an exact UID in the video's structured coauthor list. Names or a joint-submission flag alone are not sufficient; an unrelated video's identity still fails validation.

Tag discovery searches for candidates and then checks each video's structured tags. **Both `法里达` and `直播切片` must be present** for automatic inclusion through that source, along with singing evidence. Search matches without both tags stay in review. Discovery does not automatically enable full scans of every newly found uploader; add their profile explicitly if wanted.

Search results are ranked and limited by Bilibili. Even an exhausted search result set does not establish all-site coverage. The app records `last_discovery_at` separately from full uploader scans. Similarly, a successful recent-only update does not establish historical completeness.

You can add these source URL forms without editing code:

```text
https://space.bilibili.com/394803911
https://space.bilibili.com/<UID>/lists/<ID>?type=season
https://space.bilibili.com/<UID>/lists/<ID>?type=series
https://space.bilibili.com/<UID>/channel/collectiondetail?sid=<ID>
https://space.bilibili.com/<UID>/channel/seriesdetail?sid=<ID>
https://space.bilibili.com/<UID>/favlist?fid=<ID>
```

The **法里达歌唱合集** checkbox is an explicit content assertion for a collection you have checked, and is used only after source identity verification. Favorites owners, video uploaders, and performers remain distinct.

## Frida and custom pets

Frida's existing sprite sheet is bundled at `frontend/assets/frida.webp`; the original local pet is unchanged. Use the small settings button below Frida to load another pet, hide it, stop animation, or restore Frida.

Choose a transparent PNG/WebP sheet, optionally together with its `pet.json`:

| Layout | Exact size | Grid | Behavior |
| --- | --- | --- | --- |
| v1 | 1536 × 1872 | 8 × 9, cells 192 × 208 | Nine standard animation states |
| v2 | 1536 × 2288 | 8 × 11, cells 192 × 208 | Standard states plus 16 pointer-look directions |

Required row frame counts are **6, 8, 8, 4, 5, 8, 6, 6, 6**, then **8, 8** for v2 look rows. Extra unused cells never play. Files must be at most 20 MiB; the importer checks file signatures, dimensions, version consistency, transparency, and required nonempty cells. It does not edit or regenerate artwork or claim to validate its artistic semantics.

Frida idles, works during collection, reacts to pauses, and waits in review. Click to wave; double-click to jump. v2 looks toward the nearby pointer. The renderer respects reduced-motion preferences and stops painting hidden tabs. Custom pets are saved in this browser's IndexedDB, separate from the catalog. Clearing site data resets the imported pet but does not delete the SQLite catalog. Use the same hostname and port to keep browser-specific pet settings.

## Data, reliability, and backup

The default database lives **outside this repository and the frontend**:

- Windows: `%LOCALAPPDATA%\FaridaSongBrowser\catalog.sqlite3`
- Linux/macOS: `$XDG_DATA_HOME/farida-song-browser/catalog.sqlite3`, or `~/.local/share/farida-song-browser/catalog.sqlite3`
- Override with `FARIDA_DATA_DIR`, or `python run.py --data-dir <folder>`.

To back up or move the catalog, **close the app**, then copy the entire data folder. Do not delete it when upgrading application files. Schema version 1 is initialized additively; newer unsupported schemas fail explicitly rather than being overwritten. SQLite uses WAL and short transactions for the background writer and API readers. The launcher holds a process lock to avoid competing collectors on one catalog.

Video identity is BVID; part identity is BVID + CID. Part numbers are refreshed for playback links. Missing parts retain bookmarks/corrections but lose their play link until they reappear. Repeated scans and multiple memberships do not create duplicate clips. Different performances of a song remain separate.

The collector:

- Validates login on launch and starts one recent-content update after successful verification. Missing, expired, or unverified credentials cannot start or resume collection. A later successful login releases the pending startup update once. Startup does not automatically resume older interrupted jobs or claim historical completeness.
- Runs one job at a time with conservative pacing; default minimum interval is 2 seconds between requests. This is a starting setting, not a claimed safe rate for every network/account.
- Commits each video and its checkpoint, and replays one overlap page when resumed. Restarted running jobs become **interrupted**.
- Stops on access restrictions, detects repeated/no-progress pages and incomplete enumeration, and does not erase cached data after a failed/partial scan.
- Records unavailable individual videos (including uploader-only `62012` responses) and continues through the remaining links. Source cards and job history show expandable skipped-video counts and reasons. Login and platform-wide access restrictions still pause collection. A resumed song-list import can replay its already processed pages without being mistaken for a pagination loop.
- Retries transient network/server failures at most three times, respects `Retry-After`, and stops for long retry delays.
- Reuses fresh metadata during recent-only updates, keeping its real retrieval timestamp. Full scans refresh metadata and reconcile current part mappings.
- Stores missing statistics as null. Statistics remain attached to the parent submission and are only shown in details, never summed across its parts.

## Bilibili access and troubleshooting

These are read-only Bilibili website metadata routes, not an official unrestricted crawler API. Routes, limits, and login requirements can change. A normal browser visit may work while a programmatic metadata request is restricted. Slower requests alone are not a guaranteed fix.

Open the real app with the downloaded **EXE**, or **Start Farida.cmd** when running from source. The app checks the saved login before allowing entry. If needed, it opens the QR login screen automatically. Scan with Bilibili's mobile app and confirm on your phone. Successful verification enters the app and starts the pending startup update automatically. The upper-right account menu contains **更换账号**, **检查登录**, and **退出登录**. The demo preview intentionally cannot connect a real account.

The app uses Bilibili's QR login service; it never asks for a password or reads another browser's cookies. QR status is checked at most once every three seconds while the dialog is open. The required login screen cannot be dismissed without verification. An optional account-switch dialog can be closed while the previous login remains valid, stopping its polling. Expired QR codes require an explicit refresh. If saved credentials cannot be verified because the service is unavailable, the app waits for a successful **检查登录**; it does not start collection using unverified credentials.

Login credentials are stored in `bilibili-session.dat` in the app's data folder, outside the served frontend and catalog database. Windows encrypts the file with DPAPI for the current Windows user. On Linux/macOS it is a private file with mode `0600`. The local API returns only account name, UID, and status; credentials never reach browser storage, exports, or request logs. Account names and UIDs are stored with the session, not exported with clips. When moving the catalog to another Windows user or computer, sign in again there.

**检查登录** verifies the saved session, with a 30-second minimum between checks. **退出登录** stops any active collection and clears this app's saved credentials; it does not log you out of the Bilibili app or other browsers. Replacing an account also stops old collection requests before saving the new account. Subsequent jobs and next-launch updates use the saved login. If Bilibili expires the session, scan again; there is no automatic refresh-token process.

For `-352`, HTTP 403/412/429, or another restriction, the job pauses. Check your login in the upper-right account menu, then wait before deliberately retrying. Logging in does not guarantee the restriction will lift. Previously saved clips remain on this computer.

Advanced compatibility option: you may still provide a local text file containing your own authorized Bilibili Cookie header:

```powershell
$env:FARIDA_COOKIE_FILE = "$env:LOCALAPPDATA\FaridaSongBrowser\session.txt"
$env:FARIDA_REQUEST_INTERVAL = "3"
.\.venv\Scripts\python.exe run.py
```

Keep that file outside Git and outside `frontend/`. A managed QR login takes precedence over this legacy file. Signing out writes a local signed-out marker that also disables the legacy fallback without deleting your external file. Session configuration may still not resolve a platform restriction. No proxy rotation or challenge bypass is implemented.

If the app cannot start, keep the terminal error and run the command below to see it. The launcher handles an occupied default port automatically and saves the chosen port in the data folder's `ui-port.txt`, so browser-specific pet settings keep the same origin. You can override it with `--port 8767`. `Start Farida.cmd` reuses an already-running Farida instance. A second instance using the same data folder is blocked.

```powershell
.\.venv\Scripts\python.exe -X utf8 run.py --no-browser
```

`config.example.env` documents options. It is an example, not an automatically loaded secret file. Search discovery defaults to at most 20 pages and recent-only updates to 3 pages. A full uploader scan continues to normal pagination termination, with an explicit safety limit that cannot be reported as completeness.

For maintenance, `run.py --no-startup-scan` skips the automatic update for that process, allowing an existing saved job to be resumed manually after restart. Login verification is still required. The normal launcher always retains automatic startup updates.

## Development and validation

The small stack is **Python + FastAPI + HTTPX + SQLite**, with plain HTML/CSS/JavaScript served by the same Python process. It deliberately has no frontend framework or build step. This simplifies the initial React/Vite proposal for the user's lightweight collector-only workflow.

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -X utf8 -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -X utf8 -m pytest -q
.\.venv\Scripts\python.exe -X utf8 run.py
```

On POSIX systems use `python3`, `.venv/bin/python`, and otherwise the same commands. `run.py` always binds to `127.0.0.1`. Never expose this personal app to a public interface. Writes require a per-process token, reject cross-origin requests, and validate source destinations and identifiers.

Tests are deterministic and never require upstream availability. The live diagnostic is separate:

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\diagnose.py --uid 210887872 --bvid BV1br4y1R7BP
```

It records JSON under `.local/live-diagnostics.json`, including exact HTTP/API failure categories, and stops on explicit restrictions. A successful fixture test is not evidence of live Bilibili availability.

Key files:

- `backend/farida/adapter.py`: fixed upstream routes, source parsing, WBI signing, identity/response validation.
- `backend/farida/db.py`: schema, persistence, filtering, deduplication, corrections.
- `backend/farida/sync.py`: persisted jobs, pagination, cancellation, recovery.
- `backend/farida/classifier.py`: transparent, versioned rules.
- `backend/farida/app.py`: local API and static UI serving.
- `backend/farida/auth.py`, `session.py`: user-confirmed QR login, account status, private session storage.
- `frontend/`: dark interface, source/review tools, browser-side pet renderer.
- `scripts/diagnose.py`, `tests/`: explicit live probe and offline tests.

The [MediaCrawler Bilibili client](https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/bilibili/client.py) and its [license](https://github.com/NanmiCoder/MediaCrawler/blob/main/LICENSE) were inspected as the brief requested. Its non-commercial-learning implementation was not vendored. The adapter is an independent, compact implementation of the web protocol. WBI's permutation is protocol data. Python's [SQLite](https://docs.python.org/3/library/sqlite3.html) and [default-browser](https://docs.python.org/3/library/webbrowser.html) interfaces provide storage and opening behavior.

## Build the Windows release

Use 64-bit Python 3.12 on Windows. The release is built with PyInstaller from the same
source tree, and includes the web interface, default Frida pet, public catalog,
Python runtime, and license texts.

```powershell
py -3.12 -m venv .build-venv
.\.build-venv\Scripts\python.exe -m pip install -r requirements-build.txt
.\.build-venv\Scripts\python.exe -X utf8 scripts\build_windows.py
.\.build-venv\Scripts\python.exe -X utf8 scripts\download_dependency_sources.py
```

Artifacts and SHA-256 checksums are written to `release/`. Build environments,
executables, local databases, cookies, and session files are excluded from Git.
The build never reads a personal database. To deliberately update the public
snapshot before a later release, run `scripts/export_public_catalog.py`, inspect
`data/`, and commit the result before building.

The app source for each release is available from its Git tag, and the release also
includes an archive of the exact dependency source distributions. The dependency
archive has upstream download URLs and SHA-256 hashes in its manifest.
