"""Short-lived work directories for building and checking a Windows release."""
import hashlib
import shutil
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path


def write_release_checksums(directory, version):
    name = f"FaridaSongBrowser-{version}"
    files = [f"{name}-windows-x64.exe", f"{name}-windows-x64.zip", f"{name}-dependency-sources.zip",
             f"bilibili-clips-{version}.csv", f"bilibili-links-{version}.txt", f"catalog-{version}.json"]
    lines = []
    for path in sorted(directory / filename for filename in files):
        if path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(128 * 1024), b""):
                    digest.update(chunk)
            lines.append(f"{digest.hexdigest()}  {path.name}\n")
    (directory / "SHA256SUMS.txt").write_text("".join(lines), encoding="utf-8")


@contextmanager
def staging_directory(parent, prefix):
    root = parent.resolve(strict=True)
    directory = Path(tempfile.mkdtemp(prefix=prefix, dir=root))
    try:
        yield directory
    except BaseException:
        print(f"Retained staging for diagnosis: {directory}", file=sys.stderr)
        raise
    try:
        resolved = directory.resolve(strict=True)
        if resolved != directory or resolved.parent != root or not resolved.name.startswith(prefix):
            raise ValueError("staging path changed")
        shutil.rmtree(resolved)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Could not clean staging at {directory}: {error}", file=sys.stderr)
