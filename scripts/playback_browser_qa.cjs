// Real browser playback with a generated test video; no Bilibili account or traffic.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(100);}throw Error('Browser playback check timed out');}

(async()=>{
  const root=path.resolve('.local/playback-qa');fs.mkdirSync(root,{recursive:true});
  const output=fs.mkdtempSync(path.join(root,'run-'));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  const exe=process.argv[3];
  const command=path.resolve(exe||'.venv/Scripts/python.exe');
  const args=[...(exe?[]:['-X','utf8',path.resolve('run.py')]),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',path.join(output,'数据')];
  const processHandle=spawn(command,args,{cwd:path.resolve('.'),stdio:'ignore'});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});
  const page=await context.newPage(),checks=[],errors=[],requests=[];
  let mode='normal',release=null;
  const pass=message=>{checks.push(message);console.log('Passed: '+message);};
  async function startClick(selector){const before=requests.length;await page.locator(selector).first().click();await page.locator('#music-player').waitFor({state:'visible'});await until(()=>requests.length>before);}
  page.on('pageerror',error=>errors.push(error.message));
  try{
    // Create actual encoded media locally so queue advancement uses real ended events.
    await page.goto('about:blank');
    const encoded=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
      const drawing=canvas.getContext('2d'),stream=canvas.captureStream(15),chunks=[];
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
      recorder.ondataavailable=event=>chunks.push(event.data);
      const ended=new Promise(resolve=>recorder.onstop=resolve);
      recorder.start();let frame=0;
      const timer=setInterval(()=>{drawing.fillStyle='#17283d';drawing.fillRect(0,0,320,180);drawing.fillStyle='#a9cdf7';drawing.fillRect(frame++%260,70,50,40);},60);
      await new Promise(resolve=>setTimeout(resolve,1800));clearInterval(timer);recorder.stop();await ended;
      stream.getTracks().forEach(track=>track.stop());
      return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}));});
    });
    const media=Buffer.from(encoded,'base64');assert.ok(media.length>1000);
    await until(async()=>{assert.equal(processHandle.exitCode,null);try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==base)return route.abort();
      if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'播放器测试'},message:''}});
      if(url.pathname.match(/^\/api\/clips\/[^/]+\/play$/)){
        const id=decodeURIComponent(url.pathname.split('/')[3]);requests.push(id);
        const key='test_'+requests.length;
        if(mode==='held'){mode='normal';await new Promise(resolve=>release=resolve);}
        if(mode==='restricted')return route.fulfill({status:429,json:{detail:'哔哩哔哩暂时限制了播放请求，已暂停队列，请稍后重试。'}});
        return route.fulfill({json:{quality:64,segments:[{url:'/api/playback/media/'+key},...(mode==='segments'?[{url:'/api/playback/media/'+key+'_part2'}]:[])]}});
      }
      if(url.pathname.startsWith('/api/playback/media/'))return route.fulfill({body:media,contentType:'video/webm',headers:{'Accept-Ranges':'bytes'}});
      return route.continue();
    });
    await page.goto(base);await page.locator('#clip-rows tr').first().waitFor();
    const all=(await(await fetch(base+'/api/play-queue')).json()).items.filter(item=>item.playback_url);
    assert.ok(all.length>40);
    await startClick('#play-all');
    await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>0);
    assert.equal(await page.locator('#player-queue li').count(),all.length);
    assert.equal(await page.locator('#player-position').textContent(),`1 / ${all.length}`);
    await page.locator('#player-toggle').click();const pausedCount=requests.length;
    await delay(2200);assert.equal(requests.length,pausedCount);
    await page.locator('#player-compact').click();
    await page.locator('[data-view=sources]').click();
    assert.equal(await page.locator('#music-player').isVisible(),true);
    await page.locator('#player-toggle').click();
    await until(()=>requests.length===pausedCount+1);
    assert.equal(requests.at(-1),all[1].id);
    await page.locator('#player-toggle').click();
    pass('Play all spans every catalog page; pause and source-tab navigation preserve the queue; real ended advances one song');
    await page.locator('#player-compact').click();
    await page.screenshot({path:path.join(output,'player-desktop.png'),fullPage:true});
    await page.locator('#player-close').click();
    assert.equal(await page.locator('#song-video').getAttribute('src'),null);

    await page.locator('[data-view=catalog]').click();await page.locator('#next-page').click();
    await page.waitForFunction(()=>document.querySelector('#page-number').textContent.startsWith('2 /'));
    await startClick('[data-play]');
    assert.equal(await page.locator('#player-position').textContent(),`41 / ${all.length}`);
    await page.locator('#player-close').click();
    pass('Clicking a song on page two starts at its correct position in the complete queue');

    const selected=await page.locator('[data-select]').evaluateAll(elements=>elements.slice(0,2).map(el=>el.dataset.select));
    for(const id of selected)await page.locator(`[data-select="${id}"]`).check();
    await page.locator('#playlist-add-selected').click();await page.locator('#playlist-name').fill('我的晚安歌单');
    await page.locator('#playlist-items [data-move="1"]').first().click();
    await page.locator('#playlist-save-button').click();await page.locator('#playlist-dialog').waitFor({state:'hidden'});
    const savedId=await page.locator('#playlist-select').inputValue();
    let saved=await(await fetch(base+'/api/playlists/'+savedId)).json();
    assert.deepEqual(saved.items.map(item=>item.id),[selected[1],selected[0]]);
    await page.reload();await page.locator('#playlist-select option',{}).filter({hasText:'我的晚安歌单'}).waitFor({state:'attached'});
    await page.locator('#playlist-select').selectOption(savedId);await startClick('#playlist-play');
    assert.equal(await page.locator('#player-position').textContent(),'1 / 2');
    await page.locator('#player-close').click();
    await page.locator('#playlist-edit').click();await page.locator('#playlist-items [data-remove]').last().click();
    await page.locator('#playlist-name').fill('晚安 · 一首');await page.locator('#playlist-save-button').click();
    await page.locator('#playlist-dialog').waitFor({state:'hidden'});
    saved=await(await fetch(base+'/api/playlists/'+savedId)).json();
    assert.equal(saved.items.length,1);assert.equal(saved.name,'晚安 · 一首');
    pass('Selected songs form a named playlist; order, rename and removal save to SQLite and survive reload');

    const filtered=(await(await fetch(base+'/api/play-queue?q='+encodeURIComponent('月亮'))).json()).items.filter(item=>item.playback_url);
    assert.ok(filtered.length>1);
    await page.locator('#search').fill('月亮');
    await page.waitForFunction(ids=>JSON.stringify([...document.querySelectorAll('[data-play]')].map(el=>el.dataset.play))===JSON.stringify(ids),filtered.slice(0,40).map(item=>item.id));
    await startClick('#play-all');assert.equal(await page.locator('#player-queue li').count(),filtered.length);
    await page.locator('#player-save').click();await page.locator('#playlist-name').fill('月亮 · 搜索歌单');
    await page.locator('#playlist-save-button').click();await page.locator('#playlist-dialog').waitFor({state:'hidden'});
    pass('Play all respects search filters and the entire current queue can be saved as a playlist');
    await page.locator('#player-close').click();

    mode='segments';await startClick('#play-all');const initial=requests.length;
    await page.waitForFunction(()=>document.querySelector('#song-video').currentSrc.endsWith('_part2'));
    assert.equal(requests.length,initial);
    await until(()=>requests.length>initial);assert.equal(requests.length,initial+1);
    await page.locator('#player-close').click();mode='normal';
    pass('A song with multiple media segments advances only after its final segment ends');

    mode='restricted';await startClick('#play-all');
    await page.locator('#player-retry').waitFor({state:'visible'});const failedCount=requests.length;
    await delay(1200);assert.equal(requests.length,failedCount);
    assert.ok((await page.locator('#player-status').textContent()).includes('限制'));
    await page.locator('#player-close').click();mode='normal';
    pass('Playback restrictions pause the queue without repeated requests or rapid skipping');

    mode='held';await startClick('#play-all');await until(()=>!!release);
    await page.locator('#player-next').click();await until(()=>requests.at(-1)===filtered[1].id);
    release();release=null;
    await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>0);
    assert.equal(await page.locator('#player-title').textContent(),filtered[1].display_song_title);
    await page.locator('#player-toggle').click();
    pass('An old playback lookup cannot replace the song after Next is pressed');

    await page.locator('#player-close').click();
    await page.locator('#search').fill('');
    await delay(500);await startClick('#play-all');
    await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>0);
    await page.evaluate(()=>document.querySelector('#song-video').pause());
    await page.locator('#player-repeat').click();await page.locator('#player-repeat').click();
    const repeated=requests.at(-1),repeatCount=requests.length;
    await page.locator('#player-toggle').click();await until(()=>requests.length>repeatCount);
    assert.equal(requests.at(-1),repeated);
    await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>0);
    await page.evaluate(()=>document.querySelector('#song-video').pause());
    await page.locator('#player-repeat').click();await page.locator('#player-repeat').click();
    const wrapStart=requests.length;
    await page.locator('#player-queue button').last().click();
    await until(()=>requests.length>=wrapStart+2);
    assert.equal(requests.at(-1),all[0].id);
    await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>0);
    await page.evaluate(()=>document.querySelector('#song-video').pause());
    await page.locator('#player-repeat').click();await page.locator('#player-repeat').click();
    pass('List repeat wraps from the last song to the first after a real ended event');
    await page.locator('#player-shuffle').click();
    const shuffled=[requests.at(-1)];
    for(let i=0;i<3;i++){
      await startClick('#player-next');
      await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>0);
      await page.evaluate(()=>document.querySelector('#song-video').pause());
      shuffled.push(requests.at(-1));
    }
    assert.equal(new Set(shuffled).size,4);
    await startClick('#player-prev');assert.equal(requests.at(-1),shuffled[2]);
    await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>0);
    await page.evaluate(()=>{const v=document.querySelector('#song-video');v.currentTime=.5;v.pause();});
    const lastId=requests.at(-1);
    await until(async()=>{const saved=await(await fetch(base+'/api/player-state')).json();return saved.current_id===lastId&&saved.position>=.4;});
    const memoryRequests=requests.length;
    await page.reload();await page.locator('#player-remembered').waitFor({state:'visible'});
    assert.equal(requests.length,memoryRequests);
    await startClick('#player-remembered');assert.equal(requests.at(-1),lastId);
    await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>=.4);
    await page.evaluate(()=>document.querySelector('#song-video').pause());
    assert.equal(await page.locator('#player-shuffle').getAttribute('aria-pressed'),'true');
    pass('Single-song repeat uses real ended events; shuffle visits different songs; Previous follows history; reload remembers song, position and modes without autoplay');

    await page.locator('#account-toggle').click();
    const downloaded=page.waitForEvent('download');await page.locator('#backup-download').click();
    const download=await downloaded;const backupPath=path.join(output,'backup.json');await download.saveAs(backupPath);
    const backup=JSON.parse(fs.readFileSync(backupPath,'utf8'));assert.equal(backup.format,'farida-backup');
    assert.ok(backup.tables.playlists.length>0);assert.ok(!('credentials' in backup.tables));
    const token=(await(await fetch(base+'/api/session')).json()).token;
    await fetch(base+'/api/clips/'+encodeURIComponent(lastId)+'/bookmark',{method:'PATCH',headers:{'Content-Type':'application/json','X-Farida-Token':token},body:JSON.stringify({bookmarked:true})});
    page.on('dialog',async dialog=>dialog.accept());
    await page.locator('#backup-file').setInputFiles(backupPath);
    await page.waitForEvent('load');await page.locator('#clip-rows tr').first().waitFor();
    const restored=await(await fetch(base+'/api/backup')).json();
    assert.deepEqual(restored.tables.user_state,backup.tables.user_state);
    assert.deepEqual(restored.tables.playlists,backup.tables.playlists);
    pass('Chinese backup download and confirmed restore preserve playlists and restore favorites from an actual file');
    await startClick('#player-remembered');await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>0);
    await page.evaluate(()=>document.querySelector('#song-video').pause());

    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(output,'player-mobile.png'),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await page.locator('.nav-item').count(),2);
    assert.deepEqual(errors,[]);pass('Compact Chinese UI fits mobile width and retains two tabs without JavaScript errors');
    await page.locator('#player-close').click();await page.close();
    await until(()=>processHandle.exitCode!==null);assert.equal(processHandle.exitCode,0);
    pass('Closing the final page still shuts down the backend after playback');
    const result={checks,errors,output};fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{
    if(release)release();await browser.close();
    if(processHandle.exitCode===null)spawnSync('taskkill',['/PID',String(processHandle.pid),'/T','/F'],{stdio:'ignore'});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
