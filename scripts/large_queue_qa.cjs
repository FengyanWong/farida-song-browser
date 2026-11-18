// Exercise the production queue and draft limits with a disposable 20,003-part catalog.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const python=path.resolve('.venv/Scripts/python.exe'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'farida-large-queue-'));
const seed=`import sys
from pathlib import Path
sys.path.insert(0,"backend")
from farida.db import Database
db=Database(Path(sys.argv[1])/"catalog.sqlite3");db.initialize()
v={"bvid":"BV0000000001","aid":1,"title":"法里达 翻唱","desc":"","pubdate":1700000000,"duration":10,"owner":{"mid":394803911,"name":"测试"},"stat":{},"pages":[{"cid":1,"page":1,"part":"1","duration":10}]}
db.save_video(db.source(1),v,["翻唱"])
with db.connect() as c:
 c.executemany("INSERT INTO parts VALUES(?,?,?,?,?,10,1)",((f"BV0000000001:{i}","BV0000000001",str(i),i,str(i)) for i in range(2,20004)))
 c.executemany("INSERT INTO annotations(clip_id,display_song_title,inclusion_status,classification_reason,classification_version) VALUES(?,?,'included','test','test')",((f"BV0000000001:{i}",str(i)) for i in range(2,20004)))
`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await pause(50);}throw Error('large queue check timed out');}
(async()=>{
  const init=spawnSync(python,['-X','utf8','-c',seed,dir],{encoding:'utf8',windowsHide:true});assert.equal(init.status,0,init.stderr);
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const base='http://127.0.0.1:'+port,exe=process.argv[3];
  const service=spawn(exe||python,[...(exe?[]:['-X','utf8','run.py']),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',dir],{stdio:'ignore',windowsHide:true});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    await until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
    const token=(await(await fetch(base+'/api/session')).json()).token;
    const headers={'Content-Type':'application/json','X-Farida-Token':token};
    const api=async url=>(await(await fetch(base+url)).json());
    assert.equal((await fetch(base+'/api/player-state',{method:'PUT',headers,body:'{"compact":true,"volume":0.4}'})).status,200);
    const page=await browser.newPage(),writes=[],size=20003,id=n=>'BV0000000001:'+n;
    await page.addInitScript(()=>{
      const fetchNow=window.fetch;
      window.fetch=async(...args)=>{
        const response=await fetchNow(...args);
        if(window.holdOldProgress && args[1]?.method==='PATCH' && new URL(args[0],location.href).pathname==='/api/player-state'){
          window.holdOldProgress=false;
          await new Promise(resolve=>{window.releaseOldProgress=resolve;});
        }
        return response;
      };
    });
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
      if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'1',name:'测试'}}});
      if(url.pathname.endsWith('/play'))return route.fulfill({status:400,json:{detail:'离线测试片段'}});
      return route.continue();
    });
    page.on('response',r=>{if(new URL(r.url()).pathname==='/api/player-state' && ['PUT','PATCH'].includes(r.request().method())){
      const body=r.request().postDataJSON();writes.push({method:r.request().method(),status:r.status(),length:body.clip_ids?.length,id:body.current_id});
    }});
    await page.goto(base);await page.locator('#page-number').click();await page.locator('#page-target').fill('500');await page.locator('#page-target').press('Enter');
    await page.locator('[data-play="'+id(20000)+'"]').click();
    await until(()=>writes.some(r=>r.id===id(20000)));
    assert.match(await page.locator('#toast').innerText(),/20,000/);
    assert.equal(await page.locator('#player-position').innerText(),'20000 / '+size);
    // Delay the browser's receipt of an old, already-applied PATCH across the window change.
    await page.evaluate(()=>{window.holdOldProgress=true;document.querySelector('#song-video').dispatchEvent(new Event('pause'));});
    await page.waitForFunction(()=>typeof window.releaseOldProgress==='function');
    await page.locator('#player-next').click();await until(()=>writes.some(r=>r.id===id(20001)));
    assert.equal((await api('/api/player-state?summary=true')).current_id,id(20001));
    await page.evaluate(()=>window.releaseOldProgress());
    await page.locator('#player-next').click();await until(()=>writes.some(r=>r.id===id(20002)));
    for(let i=0;i<2;i++)await page.locator('#song-video').dispatchEvent('pause');
    await until(()=>writes.filter(r=>r.id===id(20002)&&r.method==='PATCH').length>=2);
    assert.deepEqual(writes.filter(r=>r.method==='PUT').map(r=>[r.length,r.status]),[[20000,200],[20000,200]]);
    assert.ok(writes.every(r=>r.status===200));
    const state=await api('/api/player-state?summary=true');assert.equal(state.current_id,id(20002));assert.equal(state.compact,true);assert.equal(state.volume,.4);
    const resume=await api('/api/player-state?compact=true&resume=true');assert.equal(resume.clip_ids.length,20000);assert.equal(resume.clip_ids[0],id(4));assert.equal(resume.clip_ids.at(-1),id(size));
    assert.equal(resume.items.length,20000);
    // Observe the production editor without creating hundreds of thousands of DOM elements in QA.
    await page.evaluate(async()=>{const {PlaylistPlayer}=await import('/player.js');const render=PlaylistPlayer.prototype.renderEditing;
      PlaylistPlayer.prototype.renderEditing=function(){document.querySelector('#playlist-search').value='QA hide results';return render.call(this);};});
    await page.locator('#player-save').click();assert.match(await page.locator('#playlist-error').innerText(),/3 首未加入/);
    await page.locator('#playlist-name').fill('保留顺序');await page.locator('#playlist-save-button').click();await page.locator('#playlist-dialog').waitFor({state:'hidden'});
    const list=(await api('/api/playlists')).items.find(l=>l.name==='保留顺序');
    const saved=await api('/api/playlists/'+list.id);assert.equal(saved.items.length,20000);
    assert.ok(saved.items.every((item,i)=>item.id===id(i+1)));
    await page.locator('#player-close').click();await page.locator('#playlist-new').click();
    await page.locator('#playlist-add-results').click();await until(async()=>(await page.locator('#playlist-error').innerText()).includes('3 首未加入'));
    await page.locator('#playlist-name').fill('全部筛选');await page.locator('#playlist-save-button').click();await page.locator('#playlist-dialog').waitFor({state:'hidden'});
    assert.equal((await api('/api/playlists')).items.find(l=>l.name==='全部筛选').count,20000);
    await page.reload();await page.locator('#player-remembered').click();await until(async()=>(await page.locator('#player-position').innerText())==='19999 / 20000');
    assert.match(await page.locator('#player-original').getAttribute('href'),/p=20002$/);
    console.log('20,003 live entries, two bounded window PUTs, compact progress PATCHes, retained settings, two ordered 20,000-item playlists, and restart at selected part verified.');
  }finally{
    await browser.close();
    if(service.exitCode===null)spawnSync('taskkill',['/PID',String(service.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    if(path.dirname(dir)===os.tmpdir() && path.basename(dir).startsWith('farida-large-queue-'))
      fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
