from copy import deepcopy

import pytest

from farida.config import Settings
from farida.db import Database


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path,request_interval=0,request_timeout=2,incremental_pages=1,discovery_pages=2)


@pytest.fixture
def db(settings):
    database=Database(settings.db_path)
    database.initialize()
    return database


@pytest.fixture
def source(db):
    return db.source(1)


@pytest.fixture
def video():
    # Entirely synthetic test metadata. Never seeded into the application database.
    return {"bvid":"BV1br4y1R7BP","aid":123,"title":"法里达 直播翻唱 合集", "desc":"法里达的歌唱表演", "pubdate":1700000000,"duration":300,"pic":"https://i0.hdslb.com/test.jpg","owner":{"mid":394803911,"name":"离落"},"stat":{"view":42,"like":3,"coin":-1},"pages":[{"cid":100,"page":1,"part":"《月亮代表我的心》","duration":150},{"cid":200,"page":2,"part":"夜に駆ける","duration":150}]}


def with_id(video,index):
    data=deepcopy(video)
    data["bvid"]=f"BV{index:010d}"
    return data
