from copy import deepcopy
import csv
from io import StringIO

from fastapi.testclient import TestClient
from farida.app import create_app


def test_original_video_discovery_is_stable_across_sources_and_views(settings, video):
    with TestClient(create_app(settings, scan_on_start=False)) as client:
        db = client.app.state.db
        source = db.source(1)
        # BV 1 is an older upload that the catalog found most recently.
        # BV 2 and 3 tie on both timestamps and BV 5 has no known discovery.
        uploads = [1100000000, 1500000000, 1500000000, 1200000000, 1700000000]
        discovered = ['2025-05-15', '2025-04-01', '2025-04-01', '2025-04-01', None]
        originals = []
        for index, (stamp, day) in enumerate(zip(uploads, discovered), 1):
            item = deepcopy(video)
            item['bvid'] = f'BV{index:010d}'
            item['pubdate'] = stamp
            db.save_video(source, item, [])
            originals.append(item['bvid'])
            if day is None:
                db.execute('DELETE FROM memberships WHERE video_bvid=?', (item['bvid'],))
            else:
                db.execute('UPDATE memberships SET first_seen_at=? WHERE video_bvid=?',
                           (day + 'T12:00:00+00:00', item['bvid']))
            if index in (1, 2):
                # A much later second source or scan cannot bump the original.
                db.execute('INSERT INTO memberships VALUES(2,?,?,?)',
                           (item['bvid'], '2026-01-01T10:00:00Z', '2026-02-01T10:00:00Z'))
                db.save_video(source, item, [])

        expected = [f'{bvid}:{cid}' for bvid in originals for cid in (100, 200)]
        params = {'sort': 'discovered'}
        flat = client.get('/api/clips', params=params).json()
        assert [row['id'] for row in flat['items']] == expected
        queue = client.get('/api/play-queue', params=params).json()
        assert [row['id'] for row in queue['items']] == expected
        exported = csv.DictReader(StringIO(client.get('/api/export', params=params).text.lstrip('\ufeff')))
        assert [f"{row['video_bvid']}:{row['cid']}" for row in exported] == expected
        assert client.get('/api/clips').json()['items'][0]['video_bvid'] == originals[-1]

        # Ranking uses the earliest membership across all sources even when
        # the UI only shows the newer source, whose timestamps tie.
        filtered = client.get('/api/play-queue', params={**params, 'source_id': 2}).json()
        assert [row['id'] for row in filtered['items']] == expected[:4]
        for page_number, part_index in [(1, 0), (2, 1)]:
            grouped = client.get('/api/clips', params={**params, 'grouped': 'true',
                                                        'page': page_number, 'page_size': 1}).json()
            assert grouped['total'] == 2
            assert grouped['groups'][0]['clip_ids'] == expected[part_index::2]
            assert [row['id'] for row in grouped['items']] == expected[part_index::2]
