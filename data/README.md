# 随附歌切目录 / Bundled collection

Snapshot exported on **2026-10-17** from the collected local catalog:

| Contents | Count |
| --- | ---: |
| Loaded original videos | 1,075 |
| Active clips / video parts | 1,286 |
| Included singing clips | 1,037 |
| Clips awaiting review | 247 |
| Excluded clips | 2 |
| CLANNADOR song-index entries | 549 |
| Unique Bilibili video links, including uncached references | 1,077 |

- `catalog.json`: the metadata snapshot loaded automatically when a new catalog is created.
- `bilibili-clips.csv`: every stored clip, its title, uploader, upload time, part-specific
  Bilibili link, review status, and song-list attribution. Two additional song-list
  references without video metadata are marked `not_loaded`.
- `bilibili-links.txt`: one canonical Bilibili link for each distinct BV ID.

The 2 unimported video references remain listed; this snapshot does not invent their
upload dates or claim they are available. It also retains index entries without
video links. Collection is a snapshot, not a claim of complete Bilibili coverage.

**歌单整理：CLANNADOR · [小法的歌单](https://fareeda.songlist.cc/)**.
The actual uploader is credited separately. No login sessions, cookies, personal
bookmarks, notes, or job logs are included. Existing user catalogs are never
overwritten by the bundled snapshot.

Re-export explicitly before a later release:

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\export_public_catalog.py
```

The exporter reads the catalog in a consistent, read-only transaction and writes
only an explicit set of public fields. See `THIRD_PARTY_NOTICES.md` for attribution.
