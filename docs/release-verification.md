# v0.0.1 release verification — 2026-10-17

- **130 offline Python tests passed**. The added snapshot tests cover exclusion of
  private response fields, notes and bookmarks; preservation of parts, memberships
  and CLANNADOR attribution; ordinary cache reuse after importing the snapshot;
  preserving existing catalogs; and atomic cleanup after a failed import.
- The final snapshot tests were repeated after the export cleanup: **5 passed**.
- Built the single-file **Windows x64 EXE** with Python 3.12.14, PyInstaller 6.22.3,
  and pinned runtime/build dependencies. Executable size: **19,147,982 bytes**.
- Launched a copy of the EXE from a folder containing no application source files,
  with Python removed from `PATH` and no Python/home/credential environment overrides.
  The executable and data directories both used Chinese names.
- Checked the actual packaged HTTP service, version 0.0.1, Chinese interface assets,
  compact row styles, Frida sprite, and complete CSV export. The fresh catalog held
  **1,286 clips, 1,075 loaded videos, and 1,037 included clips**.
- Confirmed a fresh installation had **no saved account, bookmarks or job history**,
  and collection returned HTTP 401 while signed out. No production account was used.
- Added a bookmark only in the isolated test catalog, closed that executable's
  process tree, and started it again. The bookmark and counts persisted without
  reseeding or duplication. The real user's catalog was not changed by this test.
- Audited the public snapshot and binary ZIP for excluded private fields/files.
  The ZIP includes the EXE, Chinese/English instructions, public catalog/link exports,
  project license, third-party notices, and **40 license/manifest files**.
- Verified all release asset SHA-256 checksums. The **27** upstream dependency/build
  source archives were verified against their PyPI SHA-256 manifests.

The executable is unsigned. Tests establish packaging and local behavior; they do
not guarantee that Bilibili will accept requests from every network or account.
No claim of a complete historical scan or all-site coverage is made.

To repeat the packaged integration check on Windows:

```powershell
.\.build-venv\Scripts\python.exe -X utf8 scripts\smoke_exe.py release\FaridaSongBrowser-0.0.1-windows-x64.exe
```

The checker creates only isolated folders under `.local/exe-smoke/` and stops only
the executable process tree that it starts.
