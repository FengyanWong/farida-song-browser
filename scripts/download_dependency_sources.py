"""Archive the exact upstream dependency sources alongside a GPL binary release."""
import concurrent.futures
import hashlib
import json
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from farida import __version__


def download_source(requirement):
    name, version = requirement.split("==", 1)
    with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=30) as response:
        release = json.load(response)
    source = next(file for file in release["urls"] if file["packagetype"] == "sdist")
    url = urllib.parse.urlsplit(source["url"])
    if url.scheme != "https" or url.hostname != "files.pythonhosted.org":
        raise ValueError("Unexpected source distribution host")
    filename = source["filename"]
    if Path(filename).name != filename:
        raise ValueError("Invalid source distribution filename")
    with urllib.request.urlopen(source["url"], timeout=60) as response:
        content = response.read()
    digest = hashlib.sha256(content).hexdigest()
    if digest != source["digests"]["sha256"]:
        raise ValueError(f"Source checksum mismatch: {name}")
    return {"name": name, "version": version, "filename": filename,
            "upstream_url": source["url"], "sha256": digest}, content


def main():
    requirements = [line.strip() for line in (ROOT / "requirements-lock.txt").read_text().splitlines()
                    if line.strip() and not line.startswith("#")]
    requirements += [line.strip() for line in (ROOT / "requirements-build.txt").read_text().splitlines()
                     if "==" in line and not line.startswith("#")]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        sources = list(executor.map(download_source, requirements))
    destination = ROOT / "release"
    destination.mkdir(parents=True, exist_ok=True)
    output = destination / f"FaridaSongBrowser-{__version__}-dependency-sources.zip"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for entry, content in sources:
            archive.writestr(entry["filename"], content)
        archive.writestr("manifest.json", json.dumps([entry for entry, _ in sources], indent=2) + "\n")
        archive.writestr("README.txt", "Exact runtime and build-tool source distributions for Farida Song Browser "
                        + __version__ + ".\nEach upstream archive retains its original license notices.\n"
                        "Application source and build instructions: https://github.com/FengyanWong/farida-song-browser/tree/v"
                        + __version__ + "\nThe Python runtime is distributed under the Python Software Foundation license; "
                        "the binary ZIP contains its full license notices.\n")
    assets = sorted(path for path in destination.iterdir() if path.is_file() and f"-{__version__}" in path.name)
    (destination / "SHA256SUMS.txt").write_text(
        "".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in assets), encoding="utf-8")
    print(json.dumps({"source_distributions": len(sources), "archive": output.name,
                      "bytes": output.stat().st_size}, indent=2))


if __name__ == "__main__":
    main()
