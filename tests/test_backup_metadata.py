import json

import pytest

from farida.backup import export_backup, restore_backup, validate_backup
from farida.player_state import PlayerState


@pytest.mark.parametrize(("table", "field", "invalid"), [
    ("videos", "raw_metadata", "{truncated"),
    ("videos", "raw_metadata", "{unquoted: true}"),
    ("videos", "raw_metadata", "[]"),
    ("videos", "tags", "{}"),
    ("videos", "provenance", "false"),
    ("videos", "statistics", "null"),
    ("annotations", "manual_fields", "[unfinished"),
    ("sources", "required_tags", "{}"),
    ("sources", "last_error", "[1]"),
])
def test_metadata_is_checked_even_for_archived_parts(db, source, video, table, field, invalid):
    db.save_video(source, video, [])
    db.execute("UPDATE parts SET active=0")
    original = export_backup(db)
    damaged = export_backup(db)
    damaged["tables"][table][0][field] = invalid
    with pytest.raises(ValueError):
        restore_backup(db, damaged)
    assert export_backup(db)["tables"] == original["tables"]
    assert not (db.path.parent / "backups").exists()


@pytest.mark.parametrize("invalid", ["{broken", "[]", '{"position":-1}', '{"volume":2}'])
def test_direct_restore_applies_the_player_schema(db, invalid):
    damaged = export_backup(db)
    damaged["tables"]["playback_state"] = [{"id": 1, "value": invalid}]
    with pytest.raises(ValueError):
        validate_backup(damaged)


def test_playlist_item_must_remain_visible_after_restore(db, source, video):
    db.save_video(source, video, [])
    clip_id = video["bvid"] + ":100"
    playlist = db.save_playlist("My playlist", [clip_id])
    damaged = export_backup(db)
    damaged["tables"]["annotations"] = [
        annotation for annotation in damaged["tables"]["annotations"] if annotation["clip_id"] != clip_id
    ]
    with pytest.raises(ValueError):
        restore_backup(db, damaged)
    assert db.playlist(playlist["id"])["items"][0]["id"] == clip_id


def test_legacy_playlist_and_settings_remain_readable(db, source, video):
    db.save_video(source, video, ["翻唱"])
    first, second = (video["bvid"] + suffix for suffix in (":100", ":200"))
    playlist = db.save_playlist("保留顺序", [second, first])
    supplied = export_backup(db)
    supplied["version"] = 1
    del supplied["tables"]["listening_history"]
    values = [None, "", "null", '{"category":"network","message":"重试"}']
    for row, value in zip(supplied["tables"]["sources"], values):
        row["last_error"] = value
    legacy_state = {"clip_ids": [second, first], "current_id": second, "position": 12.5}
    supplied["tables"]["playback_state"] = [{"id": 1, "value": json.dumps(legacy_state)}]

    restore_backup(db, supplied)
    result = db.playlist(playlist["id"])
    assert result["name"] == "保留顺序"
    assert [(clip["id"], clip["raw_part_title"]) for clip in result["items"]] == [
        (second, video["pages"][1]["part"]), (first, video["pages"][0]["part"]),
    ]
    saved = PlayerState.model_validate_json(db.one("SELECT value FROM playback_state")["value"])
    assert saved.current_id == second and saved.position == 12.5
    assert saved.volume == 1 and not saved.compact
    assert db.sources()[0]["last_error"] is None
