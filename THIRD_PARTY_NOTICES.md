# Attribution and bundled components

The application source is Copyright (C) 2026 FengyanWong and is distributed under
GNU GPL version 3 only. See [LICENSE](LICENSE). It comes without any warranty.
The corresponding application source and build instructions are published at
https://github.com/FengyanWong/farida-song-browser, with each release source identified by its matching Git tag.

## Collected metadata

The song index is **小法的歌单**, compiled by **CLANNADOR**:
https://fareeda.songlist.cc/. This credit is retained in the bundled catalog,
CSV exports, source cards, and clip details. It does not replace the actual
video uploader's credit. Video titles, descriptions, artwork, and song metadata
originate from their respective creators and platforms; the software license
does not grant rights to the referenced music or videos. No audio or video files
are distributed with this app. Cover images are loaded from Bilibili when viewed.

The default Frida sprite was supplied for this project by its owner. It is included
as the optional companion at `frontend/assets/frida.webp`; its character artwork
is separate from the application source license. The app's 法. logo is rendered
from text, and no Microsoft font files are redistributed.

## Windows executable

The executable bundles Python and these runtime packages: FastAPI, Starlette,
HTTPX, HTTPCore, AnyIO, Uvicorn, Pydantic, pydantic-core, Segno, Certifi, Click,
Colorama, h11, wsproto, IDNA, annotated-doc, annotated-types, OpenTelemetry API,
typing-extensions, and typing-inspection. Exact versions are pinned in
`requirements-lock.txt`. They retain their own license terms.

The Windows ZIP includes `licenses/` with the installed distributions' license
texts, Python's license, and a manifest of exact package versions and upstream
distribution links. These notices are also embedded in the standalone executable.
Package source distributions are available from the version-specific PyPI links
in that manifest. The corresponding dependency source distributions are provided
alongside the release for rebuilding the bundled application.

PyInstaller builds the executable under its bootloader exception; its license is
included with the bundled notices. Pillow is used only to render the build icon,
and is not bundled into the application. Build-tool versions are pinned in
`requirements-build.txt`.
