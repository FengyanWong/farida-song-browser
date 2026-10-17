"""Browser QA only: isolated synthetic catalog, no Bilibili network or browser opens."""
import argparse
import sys
import tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))

import uvicorn
from farida.adapter import Page
from farida.app import create_app
from farida.config import Settings
from farida.db import Database

qa_root=ROOT/'.local/browser-qa'
qa_root.mkdir(parents=True,exist_ok=True)
settings=Settings(data_dir=Path(tempfile.mkdtemp(prefix='run-',dir=qa_root)),request_interval=0)
db=Database(settings.db_path)
db.initialize()
source=db.source(1)
for index,title in enumerate(['月亮代表我的心','夜に駆ける',"Ain't No Sunshine",'后来','小幸运','红豆','晴天','慢慢喜欢你','光年之外','岁月神偷'],1):
    data={'bvid':f'BV{index:010d}','aid':index,'title':f'演示 · 法里达翻唱《{title}》','desc':'演示数据，不是真实的哔哩哔哩视频信息。SYNTHETIC TEST FIXTURE.','pic':'/assets/demo-cover.svg' if index!=8 else None,'pubdate':1770000000+index*86400,'duration':180,'owner':{'mid':394803911,'name':'离落 · 演示'},'stat':{'view':100+index,'like':10},'pages':[{'cid':index,'page':1,'part':title,'duration':180}]}
    db.save_video(source,data,['法里达','直播切片','翻唱'])
    db.annotate([f'BV{index:010d}:{index}'],{'display_song_title':f'演示 · {title}'})
db.annotate(['BV0000000010:10'],{'inclusion_status':'needs_review'})
qa_songs = [{'id': 1, 'song_title': '演示 · 月亮代表我的心', 'bvid': 'BV0000000001', 'original_artist': '演示原唱', 'language': '国语', 'style': '流行'}]
db.save_songlist(next(s for s in db.sources() if s['source_type'] == 'songlist'), qa_songs)


class OfflineAdapter:
    def __init__(self,settings):pass
    async def close(self):pass
    async def resolve_source(self,source):return {'uid':source['uid'],'name':source['display_name'],'method':'SYNTHETIC_QA_ONLY','songs':qa_songs}
    async def list_entries(self,source,page):
        import asyncio
        await asyncio.sleep(0.5)
        if source['source_type'] == 'songlist':
            return Page(['BV0000000001'],False,1)
        return Page([],False,0)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8766)
    args=parser.parse_args()
    app=create_app(settings,adapter_factory=OfflineAdapter,browser_opener=lambda url:True,preview_mode=True)
    uvicorn.run(app,host='127.0.0.1',port=args.port,access_log=False,log_level='warning')
