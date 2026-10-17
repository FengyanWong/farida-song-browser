"""Public Farida song index, curated by CLANNADOR; never a login destination."""
import re

URL = 'https://fareeda.songlist.cc/'
ENDPOINT = 'https://api.starlwr.com/songlist/getView'
CURATOR = 'CLANNADOR'
CURATOR_UID = '210887872'
PERFORMER_UID = '23263470'


def parse_songlist(payload):
    if not isinstance(payload, dict) or type(payload.get('code')) is not int or payload['code'] < 0:
        raise ValueError('歌单网站暂时无法返回歌单，请稍后更新。')
    data = payload.get('data')
    if not isinstance(data, dict) or data.get('enabled') is not True:
        raise ValueError('歌单暂未开放，已保留本机资料。')
    if str(data.get('uid')) != PERFORMER_UID:
        raise ValueError('歌单所属账号发生变化，已停止导入并保留本机资料。')
    songs = data.get('songs')
    if not isinstance(songs, list) or len(songs) > 20000:
        raise ValueError('歌单格式有变化，已保留本机资料。')
    rows, seen = [], set()
    for song in songs:
        if not isinstance(song, dict) or type(song.get('id')) is not int or song['id'] <= 0 or song['id'] in seen:
            raise ValueError('歌单曲目编号异常，已保留本机资料。')
        seen.add(song['id'])
        name = song.get('name')
        if not isinstance(name, str) or not name.strip() or len(name) > 500:
            raise ValueError('歌单曲名格式有变化，已保留本机资料。')
        bvid = song.get('video')
        if bvid is not None and not isinstance(bvid, str):
            raise ValueError('歌单视频编号格式有变化，已保留本机资料。')
        bvid = bvid.strip() if bvid else None
        if bvid and not re.fullmatch(r'BV[0-9A-Za-z]{10}', bvid):
            raise ValueError('歌单视频编号格式有变化，已保留本机资料。')
        row = {'id': song['id'], 'song_title': name.strip(), 'bvid': bvid or None}
        for remote, local in [('singer', 'original_artist'), ('language', 'language'), ('style', 'style')]:
            value = song.get(remote)
            if value is not None and (not isinstance(value, str) or len(value) > 500):
                raise ValueError('歌单曲目资料格式有变化，已保留本机资料。')
            row[local] = value or ''
        rows.append(row)
    return rows
