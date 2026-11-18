// Exercise multipart re-collection against an isolated real database and browser UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {chromium} = require(process.argv[2] || process.env.FARIDA_PLAYWRIGHT_PATH || 'playwright');
const python = path.resolve('.venv/Scripts/python.exe');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'farida-multipart-copy-'));
const bvid = 'BV0000000001';
const original = part => 'https://www.bilibili.com/video/'+bvid+'/?p='+part;
function collect(reordered) {
  const script = `
import sys
from pathlib import Path
sys.path.insert(0, 'backend')
from farida.db import Database
db = Database(Path(sys.argv[1]) / 'catalog.sqlite3')
db.initialize()
changed = sys.argv[2] == 'yes'
parts = [(200,'乙歌'),(400,'丁歌'),(100,'甲歌')] if changed else [(100,'甲歌'),(200,'乙歌'),(300,'丙歌')]
video = {'bvid':'BV0000000001','aid':1,'title':'法里达 直播翻唱 合集','desc':'离线测试','duration':600,
         'pubdate':1700000000,'owner':{'mid':394803911,'name':'离落'},'stat':{},
         'pages':[{'page':i,'part':title,'cid':cid,'duration':120} for i,(cid,title) in enumerate(parts,1)]}
db.save_video(db.source(1),video,['翻唱'])
for cid,title in parts:
    db.annotate([video['bvid']+':'+str(cid)],{'display_song_title':title,'inclusion_status':'included'})
if not changed:
    print(db.save_playlist('分P歌单',[video['bvid']+':'+str(cid) for cid in (100,300,200)])['id'])
`;
  const run = spawnSync(python,['-B','-X','utf8','-c',script,dataDir,reordered?'yes':'no'],{encoding:'utf8',windowsHide:true});
  assert.equal(run.status,0,run.stderr);
  return run.stdout.trim();
}
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const listId=collect(false);
  const socket=net.createServer();
  await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  const base='http://127.0.0.1:'+port, executable=process.argv[3];
  const args=[...(executable?[]:['-X','utf8',path.resolve('run.py')]),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',dataDir];
  const service=spawn(executable || python,args,{stdio:'ignore',windowsHide:true});
  let browser;
  try {
    for (let i=0;i<200;i++) {
      assert.equal(service.exitCode,null);
      if (await fetch(base+'/api/health').then(r=>r.ok,()=>false)) break;
      await delay(100);
    }
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext();
    const errors=[], clipboardRequests=[];
    context.on('page',page=>{
      page.on('pageerror',error=>errors.push(error.message));
      page.on('dialog',dialog=>dialog.accept());
    });
    let holdNext, release, failNext=false;
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==base)return route.abort();
      if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'离线测试'},message:''}});
      if(url.pathname.startsWith('/api/sync'))return route.fulfill({status:409,json:{detail:'离线测试'}});
      if(url.pathname==='/api/playlists/copy-links'){
        clipboardRequests.push(route.request().postDataJSON().clip_ids);
        if(holdNext){const entered=holdNext;holdNext=null;await new Promise(resolve=>{release=resolve;entered();});}
        if(failNext){failNext=false;return route.fulfill({status:503,json:{detail:'读取本机歌单失败，请重试。'}});}
      }
      return route.continue();
    });
    await context.addInitScript(()=>{
      window.copies=[];
      window.clipboardCalls=[];
      Object.defineProperty(navigator,'clipboard',{value:{
        write:async items=>{
          window.clipboardCalls.push(navigator.userActivation.isActive);
          if(window.denyClipboard)throw Error('denied');
          const blob=await items[0].getType('text/plain');
          window.copies.push(await blob.text());
        },
        writeText:async text=>{
          if(window.denyClipboard)throw Error('denied');
          window.copies.push(text);
        }
      }});
    });
    const editor=await context.newPage(),detail=await context.newPage(),archived=await context.newPage();
    await Promise.all([editor,detail,archived].map(page=>page.goto(base)));
    await editor.locator('#playlist-select option[value="'+listId+'"]').waitFor({state:'attached'});
    await editor.locator('#playlist-select').selectOption(listId);
    await editor.locator('#playlist-edit').click();
    await editor.locator('#playlist-items [data-item="1"][data-move="-1"]').click();
    await editor.locator('#playlist-search').fill('甲歌');
    assert.equal(await editor.locator('#playlist-items [data-remove]').count(),1);
    await detail.locator('[data-detail="'+bvid+':100"]').click();
    await archived.locator('[data-detail="'+bvid+':300"]').click();
    await Promise.all([detail,archived].map(page=>page.locator('[data-copy-clip]').waitFor()));
    collect(true);
    const copy=editor.locator('#playlist-copy-links'),status=editor.locator('#playlist-copy-status');
    await copy.click();
    await editor.waitForFunction(()=>document.querySelector('#playlist-copy-status').textContent.includes('已复制 2 个链接，跳过 1 个'));
    const expected=[original(3),original(1)].join('\n');
    assert.deepEqual(await editor.evaluate(()=>window.copies),[expected]);
    assert.deepEqual(await editor.evaluate(()=>window.clipboardCalls),[true]);
    assert.deepEqual(clipboardRequests[0],[300,100,200].map(cid=>bvid+':'+cid));
    await detail.locator('[data-copy-clip]').click();
    await detail.waitForFunction(()=>window.copies.length===1);
    assert.equal(await detail.evaluate(()=>window.copies[0]),original(3));
    await archived.locator('[data-copy-clip]').click();
    await archived.waitForFunction(()=>document.querySelector('#toast').textContent.includes('当前不可用'));
    assert.deepEqual(await archived.evaluate(()=>window.copies),[]);
    await editor.evaluate(()=>window.denyClipboard=true);
    await copy.click();
    await editor.locator('#playlist-copy-text').waitFor();
    assert.equal(await editor.locator('#playlist-copy-text').inputValue(),expected);
    assert.match(await status.textContent(),/手动复制以下 2 个链接，跳过 1 个/);
    await editor.evaluate(()=>window.denyClipboard=false);
    failNext=true;
    await copy.click();
    await editor.waitForFunction(()=>document.querySelector('#playlist-copy-status').textContent.includes('读取本机歌单失败'));
    assert.deepEqual(await editor.evaluate(()=>window.copies),[expected]);
    const waiting=new Promise(resolve=>holdNext=resolve);
    await copy.click();await waiting;
    assert.equal(await copy.isDisabled(),true);
    await editor.getByRole('button',{name:'关闭歌单编辑'}).click();
    await editor.locator('#playlist-edit').click();
    await editor.locator('#playlist-dialog').waitFor();
    const completed=editor.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/copy-links'));
    release();await completed;
    await editor.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.deepEqual(await editor.evaluate(()=>window.copies),[expected]);
    assert.equal(await status.textContent(),'');
    await copy.click();
    await editor.waitForFunction(()=>window.copies.length===2);
    assert.equal(await editor.evaluate(()=>window.copies.at(-1)),expected);
    assert.deepEqual(errors,[]);
    console.log('Passed: multipart reordering, unsaved filtered draft order, archived CID, updated detail link, user activation, permission fallback, lookup failure and late copy after reopening.');
  } finally {
    await browser?.close();
    if(service.exitCode===null)spawnSync('taskkill',['/PID',String(service.pid),'/T','/F'],{stdio:'ignore'});
    assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('farida-multipart-copy-'));
    fs.rmSync(dataDir,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
