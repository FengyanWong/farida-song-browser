from pathlib import Path

import pytest

from scripts import release_staging


def test_successful_run_cleans_own_directory_and_preserves_history(tmp_path):
    previous = tmp_path / "pyinstaller-previous"
    previous.mkdir()
    marker = previous / "previous.log"
    marker.write_text("retained")
    with release_staging.staging_directory(tmp_path, "pyinstaller-") as current:
        (current / "intermediate.pkg").write_bytes(b"sample")
    assert not current.exists()
    assert marker.read_text() == "retained"


def test_failed_run_keeps_diagnostics(tmp_path, capsys):
    with pytest.raises(RuntimeError, match="simulated build failure"):
        with release_staging.staging_directory(tmp_path, "licenses-") as current:
            log = current / "diagnostic.log"
            log.write_text("details")
            raise RuntimeError("simulated build failure")
    assert log.read_text() == "details"
    assert str(current) in capsys.readouterr().err


def test_cleanup_error_keeps_successful_result(tmp_path, monkeypatch, capsys):
    def busy(path):
        raise PermissionError("simulated sharing violation")

    monkeypatch.setattr(release_staging.shutil, "rmtree", busy)
    with release_staging.staging_directory(tmp_path, "运行测试-") as current:
        (current / "diagnostic.log").write_text("details")
    assert current.is_dir()
    assert "simulated sharing violation" in capsys.readouterr().err


def test_retargeted_staging_path_is_never_removed(tmp_path, monkeypatch, capsys):
    sibling = tmp_path / "pyinstaller-preserve"
    sibling.mkdir()
    resolve = Path.resolve
    with release_staging.staging_directory(tmp_path, "pyinstaller-") as current:
        def changed(path, *args, **kwargs):
            return sibling if path == current else resolve(path, *args, **kwargs)

        monkeypatch.setattr(Path, "resolve", changed)
    assert sibling.is_dir() and current.is_dir()
    assert "staging path changed" in capsys.readouterr().err


def test_checksums_only_cover_named_downloads_for_one_exact_version(tmp_path):
    import hashlib

    valid = {"FaridaSongBrowser-0.0.2-windows-x64.exe": b"large" * 50000,
             "FaridaSongBrowser-0.0.2-dependency-sources.zip": b"source"}
    for name, content in valid.items():
        (tmp_path / name).write_bytes(content)
    for extra in ("FaridaSongBrowser-0.0.26-windows-x64.exe", "personal-0.0.2.txt", "SHA256SUMS.txt"):
        (tmp_path / extra).write_text("unrelated")
    release_staging.write_release_checksums(tmp_path, "0.0.2")
    assert (tmp_path / "SHA256SUMS.txt").read_text().splitlines() == [
        f"{hashlib.sha256(valid[name]).hexdigest()}  {name}" for name in sorted(valid)]
