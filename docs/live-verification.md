# Live acquisition verification — 2026-10-17

The explicit diagnostic used the installed Windows Python runtime and HTTPX with a minimum 2-second request interval. It made no media requests and used no user session.

| Check | Observed result |
| --- | --- |
| Public WBI signing-key retrieval | Returned sufficient key material to attempt the signed profile lookup |
| `GET /x/space/wbi/acc/info?mid=210887872` | JSON response code `-352`; classified as restricted; stopped immediately |
| Uploader submission enumeration | Not attempted after restriction |
| Multipart details and actual uploader cross-check | Not attempted after restriction |
| Structured tags | Not attempted after restriction |
| Collections, series, favorites, tag search | Implemented; no successful live validation in this environment |

The exact diagnostic is retained locally in `.local/live-diagnostics.json`. The restriction arose before bulk collection, so request rate alone has not been established as its cause. No identity was promoted to verified and no full-scan timestamp was recorded on this evidence.

A later paced recheck on the same day, requested while discussing the restriction, again received `-352` at the first profile lookup and stopped immediately. Its result is retained in `.local/live-diagnostics-followup.json`. Neither response established a cause, expiry time, account ban, or that waiting alone will restore access.

## QR login check

At **2026-10-17 03:02:09 UTC**, the real app successfully requested and displayed a genuine Bilibili QR code. One status poll at the normal three-second interval returned **waiting**. The test dialog was then closed and cancelled; no account was signed in. `.local/login-live-result.json` retains the non-secret result, with no login key, ticket, cookie, or QR image.

The live generate endpoint now returns the scan page on `https://account.bilibili.com/h5/account-h5/auth/scan-web`. The implementation accepts that exact HTTPS route as well as the older `passport.bilibili.com` scan route; both are covered by offline tests. The user's phone confirmation, issued credentials, and authenticated collection still require live verification. The real app's automatic anonymous startup scans continued to pause at the first profile request with `-352`, leaving the catalog empty.

Current crossDomain-ticket handling was independently implemented with reference to a [first-hand CLI login implementation report](https://github.com/public-clis/bilibili-cli/pull/27). The confirmed-account completion variants have passed mocked protocol tests, including account identity checks and encrypted session persistence; this is not a claim that phone-confirmed login has been exercised here.

Remaining checks for complete live integration acceptance (the successful signed-in collection observed later is recorded below):

1. Run the diagnostic under working Bilibili access. Verify account identity, at least one submission page, and the selected multipart video's uploader/CIDs/part numbers.
2. Finish one full uploader scan, then the remaining three. Check the actual display names associated with user-provided UIDs.
3. Exercise configured collection types and cross-uploader tag discovery under working access.
4. Open a verified song from the catalog and confirm the original Bilibili page selects its intended part. Automatic playback is not an acceptance requirement.

The app's offline/API tests and browser QA do not substitute for these upstream checks. No catalog is represented as all of Farida's Bilibili clips.

## Signed-in acquisition observed

At **2026-10-17 03:33:52 UTC**, the running app reported a connected user account and **401 saved clip entries from 351 submissions**, including 353 included entries. The active recent-content job had processed 423 source memberships. Sources 1, 3, and 4 had completed their bounded recent update; source 2 had a failed checkpoint; tag discovery was still running at page 11 of its configured maximum of 20. These counts were read from the local API without exposing credentials or the user's identity. They establish successful real acquisition after login, not full historical coverage or a complete all-source result.

The subsequent UI update requires verified login on opening, delays all automatic collection until verification, and moves account information to the upper-right header. Session reuse and startup gating have separate deterministic tests; further full-scan verification remains outstanding.

## Joint submission and song-list integration

The CLANNADOR failure was traced to `BV1TQvYB8Edf`. Its primary owner is UID 5092728, while the video-detail `staff` list explicitly includes CLANNADOR, UID 210887872. The profile identity was correct. Uploader membership now accepts this verified coauthor relationship while retaining the primary uploader on the video. The original failed recent-update job was resumed and **completed 90 videos without errors**; historical coverage is still not claimed.

The user-supplied [小法的歌单](https://fareeda.songlist.cc/) identifies CLANNADOR as its contact. Its public app loads `https://api.starlwr.com/songlist/getView` with the site's hostname. The independent importer uses that fixed read endpoint through a separate HTTP client, without Bilibili credentials. The observed public index has **549 songs, 486 unique BV references, and 63 songs without video links**. All index rows are retained locally; linked clips still require verified Bilibili video/part metadata before they can open.

At **2026-10-17 04:05:23 UTC**, live browser checks confirmed zero login-dialog flashes for the saved session, the successful 90-video CLANNADOR update, and the new song-list source showing 549 songs / 486 BV links. The new source had verified 8 submissions / 8 clips and was still collecting, with no errors. Source-card attribution, clip-row credit, and the detail link to CLANNADOR's original list were visible. This is a partial import snapshot, not a claim that all 486 links had completed. The sanitized result is retained in `.local/integration-live-result.json`.

Offline validation passed **122 Python tests**, **20 collection/browser checks**, and **12 login UI checks**. Regression checks cover fresh and cached joint submissions, incorrect owner rejection, quiet slow startup verification, one public index fetch per update, new-link-only metadata retrieval, full index enumeration, credential separation, deduplication, multipart naming, site failure preservation, and manual-edit precedence.

## Song-list import completed after unavailable-video handling fix

The first import stopped after processing 422 links because `BV1cU4y1z7kN` (折枝花满衣) returned **62012**. A signed-in metadata check at 11:53 UTC reproduced the response; account verification succeeded. This is the uploader-only visibility code listed in the [API research reference](https://minisheeep.github.io/bilibili-API-collect/docs/video/info.html). The adapter had treated it as an unknown fatal response. It now records that video as unavailable and continues; the classification is limited to the video-details endpoint. Authentication and request restrictions still stop collection.

Resume also needed to distinguish pages processed on an earlier attempt from repeated pages within the current pass. The song list intentionally restarts enumeration to handle reordered entries, retaining saved video IDs. That legitimate overlap no longer triggers the pagination-loop check. A regression test exercises resume beyond the first page, an unavailable video followed by more successful videos, bookmark/title preservation, and complete coverage. Reordered repeating pages still fail validation.

The original job completed at **2026-10-17 12:04:55 UTC (13:04:55 Europe/London)**. A read-only audit at 12:06 UTC confirmed all **486** BV references were accounted for: **484 available submissions imported, producing 487 clips**, and **2 unavailable links retained in the index and job record**. Compared with the previous failed job, 63 additional song-list submissions were imported or linked to existing local metadata.

| Unavailable link | Song-list title | Latest observed response |
| --- | --- | --- |
| BV16H4y1m7Xi | 云与海 | -404; checked again after completion |
| BV1cU4y1z7kN | 折枝花满衣 | 62012; uploader-only visibility |

The complete local catalog now contains **1,286 clip records: 1,037 included, 247 needing review, and 2 excluded**. These are clip counts, not unique song counts. No remaining song-list link is unexplained or pending. The two unavailable videos are not represented as successfully imported or playable.

All **54 relevant adapter, collector, and song-list regression tests** passed. Live browser checks confirmed completion, expandable skipped-video reasons on the source card and in history, no source error, mobile layout, and no JavaScript errors. Sanitized evidence is retained in `.local/songlist-final-audit.json` and `.local/import-resume-browser-result.json`.
