"""Build the Windows x64 single-file executable and downloadable release files."""
import hashlib
import importlib.metadata as metadata
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from farida import __version__


def runtime_packages():
    return [line.split("==")[0] for line in (ROOT / "requirements-lock.txt").read_text().splitlines()
            if line and not line.startswith("#")]


def collect_licenses(destination):
    destination.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name in [*runtime_packages(), "pyinstaller", "setuptools", "packaging"]:
        dist = metadata.distribution(name)
        license_files = []
        for file in dist.files or []:
            parts = [part.lower() for part in file.parts]
            if not any("dist-info" in part for part in parts):
                continue
            if not any("license" in part or "copying" in part or part.startswith("notice") for part in parts):
                continue
            source = Path(dist.locate_file(file))
            if source.is_file():
                target = destination / name / Path(*file.parts[1:])
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                license_files.append(target.relative_to(destination).as_posix())
        if not license_files:
            raise RuntimeError(f"No license text found for {name}; inspect its distribution before publishing")
        manifest.append({"name": name, "version": dist.version, "licenses": license_files,
                         "distribution": f"https://pypi.org/project/{name}/{dist.version}/"})
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if not python_license.is_file():
        raise RuntimeError("The Python runtime LICENSE.txt is required for distribution")
    shutil.copy2(python_license, destination / "Python-LICENSE.txt")
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def make_icon(destination):
    # Render the same code-defined 法. wordmark used by the web interface.
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new("RGBA", (256, 256))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, 255, 255), radius=68, fill="#20354b")
    font_path = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyhbd.ttc"
    font = ImageFont.truetype(str(font_path), 145)
    draw.text((128, 122), "法.", font=font, anchor="mm", fill="#b2d4f8", stroke_width=1)
    image.save(destination, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def main():
    if os.name != "nt" or struct.calcsize("P") != 8:
        raise SystemExit("Build with 64-bit Python on Windows.")
    snapshot = json.loads((ROOT / "data" / "catalog.json").read_text(encoding="utf-8"))
    if snapshot.get("format") != "farida-public-catalog" or not snapshot["counts"]["videos"]:
        raise SystemExit("Export a public catalog with scripts/export_public_catalog.py before building.")
    build, dist, release = (ROOT / name for name in ("build", "dist", "release"))
    for folder in (build, dist, release):
        folder.mkdir(parents=True, exist_ok=True)
    # Fresh staging avoids stale notices and OneDrive locks from earlier builds.
    licenses = Path(tempfile.mkdtemp(prefix="licenses-", dir=build))
    work = Path(tempfile.mkdtemp(prefix="pyinstaller-", dir=build))
    collect_licenses(licenses)
    icon = build / "app.ico"
    make_icon(icon)
    version_tuple = tuple(map(int, __version__.split("."))) + (0,)
    version_file = build / "version-info.txt"
    version_file.write_text(
        "VSVersionInfo(ffi=FixedFileInfo(filevers=" + repr(version_tuple) + ", prodvers=" + repr(version_tuple) +
        ", mask=0x3f, flags=0, OS=0x40004, fileType=0x1, subtype=0, date=(0, 0)), kids=["
        "StringFileInfo([StringTable('040904B0', ["
        "StringStruct('CompanyName', 'FengyanWong'),"
        "StringStruct('FileDescription', '法里达 · 歌切收藏'),"
        f"StringStruct('FileVersion', '{__version__}'),"
        "StringStruct('ProductName', 'Farida Song Browser'),"
        f"StringStruct('ProductVersion', '{__version__}'),"
        "StringStruct('LegalCopyright', 'Copyright (C) 2026 FengyanWong. GPL-3.0-only.')"
        "])]), VarFileInfo([VarStruct('Translation', [1033, 1200])])])", encoding="utf-8")
    name = f"FaridaSongBrowser-{__version__}-windows-x64"
    command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
               "--name", name, "--icon", str(icon), "--version-file", str(version_file),
               "--paths", str(ROOT / "backend"), "--distpath", str(dist),
               "--workpath", str(work), "--specpath", str(build),
               "--collect-submodules", "uvicorn", "--hidden-import", "anyio._backends._asyncio",
               "--hidden-import", "wsproto",
               "--exclude-module", "PIL", "--exclude-module", "tkinter", "--exclude-module", "pytest"]
    for source, target in [(ROOT / "frontend", "frontend"), (ROOT / "data", "data"),
                           (ROOT / "LICENSE", "."), (ROOT / "THIRD_PARTY_NOTICES.md", "."), (licenses, "licenses")]:
        command += ["--add-data", f"{source}:{target}"]
    for package in runtime_packages():
        command += ["--copy-metadata", package]
    subprocess.run([*command, str(ROOT / "run.py")], cwd=ROOT, check=True)
    executable = release / f"{name}.exe"
    shutil.copy2(dist / executable.name, executable)
    archive = release / f"{name}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for source, target in [(executable, executable.name), (ROOT / "LICENSE", "LICENSE"),
                               (ROOT / "使用说明.txt", "使用说明.txt"), (ROOT / "Start Here.txt", "Start Here.txt"),
                               (ROOT / "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md")]:
            bundle.write(source, target)
        for directory, prefix in [(ROOT / "data", "data"), (licenses, "licenses")]:
            for source in sorted(directory.rglob("*")):
                if source.is_file():
                    bundle.write(source, f"{prefix}/{source.relative_to(directory).as_posix()}")
    downloads = [executable, archive]
    for source_name, target_name in [("bilibili-clips.csv", f"bilibili-clips-{__version__}.csv"),
                                     ("bilibili-links.txt", f"bilibili-links-{__version__}.txt"),
                                     ("catalog.json", f"catalog-{__version__}.json")]:
        target = release / target_name
        shutil.copy2(ROOT / "data" / source_name, target)
        downloads.append(target)
    all_assets = sorted(path for path in release.iterdir() if path.is_file() and f"-{__version__}" in path.name)
    (release / "SHA256SUMS.txt").write_text(
        "".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in all_assets), encoding="utf-8")
    print(json.dumps({"version": __version__, "catalog": snapshot["counts"],
                      "files": [{"name": path.name, "bytes": path.stat().st_size} for path in downloads]}, indent=2))


if __name__ == "__main__":
    main()
