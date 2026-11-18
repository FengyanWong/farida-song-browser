from farida.db import encode


def add_job(db, number, ids, checkpoints=None):
    stamp = f"2026-01-01T00:00:{number:02d}+00:00"
    db.execute(
        "INSERT INTO sync_jobs(id,source_ids,mode,state,checkpoints,started_at,heartbeat) "
        "VALUES(?,?,'incremental','completed',?,?,?)",
        (str(number), encode(ids), encode(checkpoints or {}), stamp, stamp),
    )


def test_overview_uses_already_loaded_jobs_for_each_source(db, monkeypatch):
    add_job(db, 1, [1, 2], {"1": {"state": "completed", "processed": 12}})
    queries = []
    read_one = db.one

    def track_single_job_queries(query, args=()):
        if "FROM sync_jobs" in query:
            queries.append(query)
        return read_one(query, args)

    monkeypatch.setattr(db, "one", track_single_job_queries)
    sources = db.overview(compact=True)["sources"]
    statuses = {s["id"]: s["collection_status"] for s in sources}
    assert statuses[1]["processed"] == 12
    assert statuses[2]["state"] == "not_started"
    assert statuses[3]["state"] == "idle"
    assert queries == []


def test_overview_finds_an_older_job_after_the_source_url_changed(db):
    source = db.source(1)
    add_job(db, 1, [1], {"1": {"state": "completed", "source_url": source["canonical_url"]}})
    # Ten newer jobs either miss this source or refer to its prior URL.
    for number in range(2, 11):
        add_job(db, number, [2])
    add_job(db, 11, [1], {"1": {"source_url": "https://space.bilibili.com/999999"}})

    overview = db.overview(compact=True)
    assert "1" not in [job["id"] for job in overview["jobs"]]
    latest = {s["id"]: s["collection_status"]["job_id"] for s in overview["sources"]}
    assert latest[1] == "1"
    assert latest[2] == "10"
    assert latest[3] is None
