// Pinned controls use one real, locally generated video. No Bilibili traffic or real user data.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(80);}throw Error('Mini-player check timed out');}
(async()=>{
  const root=path.resolve('.local/mini-player-qa');fs.mkdirSync(root,{recursive:true});
  const output=fs.mkdtempSync(path.join(root,'run-'));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const base=`http://127.0.0.1:${port}`,exe=process.argv[3];
  const args=[...(exe?[]:['-X','utf8',path.resolve('run.py')]),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',path.join(output,'数据')];
  const server=spawn(path.resolve(exe||'.venv/Scripts/python.exe'),args,{cwd:path.resolve('.'),stdio:'ignore'});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});
  // Capture the callbacks registered with Edge so a test can issue media actions
  // without sending physical media-key events to the user's operating system.
  await context.addInitScript(()=>{
    const session=navigator.mediaSession;
    window.mediaActions=new Map();
    const register=session.setActionHandler.bind(session);
    session.setActionHandler=(name,callback)=>{
      register(name,callback);
      if(callback)window.mediaActions.set(name,callback);else window.mediaActions.delete(name);
    };
  });
  let restricted=false;
  const page=await context.newPage(),checks=[],errors=[],plays=[];
  const pass=message=>{checks.push(message);console.log('Passed: '+message);};
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto('about:blank');
    const encoded=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
      const drawing=canvas.getContext('2d'),stream=canvas.captureStream(15),chunks=[];
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
      recorder.ondataavailable=event=>chunks.push(event.data);
      const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();let frame=0;
      const timer=setInterval(()=>{drawing.fillStyle='#17283d';drawing.fillRect(0,0,320,180);drawing.fillStyle='#a9cdf7';drawing.fillRect(frame++%260,70,50,40);},60);
      await new Promise(resolve=>setTimeout(resolve,2800));clearInterval(timer);recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
      return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}));});
    });
    const media=Buffer.from(encoded,'base64');assert.ok(media.length>1000);
    await until(async()=>{assert.equal(server.exitCode,null);try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
    const token=(await(await fetch(base+'/api/session')).json()).token;
    const all=(await(await fetch(base+'/api/play-queue')).json()).items.filter(item=>item.playback_url).slice(0,3);assert.equal(all.length,3);
    const playlist=await(await fetch(base+'/api/playlists',{method:'POST',headers:{'Content-Type':'application/json','X-Farida-Token':token},body:JSON.stringify({name:'迷你播放器测试',clip_ids:all.map(item=>item.id)})})).json();
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
      if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'迷你播放器测试'},message:''}});
      if(/^\/api\/clips\/[^/]+\/play$/.test(url.pathname)){
        plays.push(decodeURIComponent(url.pathname.split('/')[3]));
        if(restricted)return route.fulfill({status:429,json:{detail:'播放已暂停，请稍后重试。'}});
        return route.fulfill({json:{segments:[{url:'/api/playback/media/mini_'+plays.length}]}});
      }
      if(url.pathname.startsWith('/api/playback/media/'))return route.fulfill({body:media,contentType:'video/webm',headers:{'Accept-Ranges':'bytes'}});
      return route.continue();
    });
    async function scrollBottom(){await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.locator('#mini-player').waitFor({state:'visible'});}
    async function ready(){await page.waitForFunction(()=>{const video=document.querySelector('#song-video');return video.currentTime>.05&&!video.paused;});}
    async function state(){return(await(await fetch(base+'/api/player-state')).json());}
    await page.goto(base);await page.locator('#clip-rows tr').first().waitFor();
    assert.equal(await page.locator('#mini-player').isVisible(),false);
    await page.evaluate(()=>document.querySelector('#song-video').loop=true);
    await page.locator('#playlist-select').selectOption(String(playlist.id));await page.locator('#playlist-play').click();await ready();
    assert.equal(await page.locator('#mini-player').isVisible(),false);
    const firstSrc=await page.locator('#song-video').getAttribute('src');
    await scrollBottom();assert.equal(await page.locator('#mini-player-title').textContent(),all[0].display_song_title);
    assert.equal(await page.locator('video,audio').count(),1);assert.equal(await page.locator('#song-video').getAttribute('src'),firstSrc);assert.equal(plays.length,1);
    await page.locator('#mini-player-toggle').click();
    await page.waitForFunction(()=>document.querySelector('#song-video').paused&&document.querySelector('#mini-player-toggle').textContent==='播放');
    await page.locator('#mini-player-toggle').click();await ready();
    await page.locator('#mini-player-next').click();await until(()=>plays.length===2);await ready();assert.equal(plays.at(-1),all[1].id);
    await until(async()=>await page.locator('#mini-player-position').textContent()==='2 / 3');
    await page.locator('#mini-player-prev').click();await until(()=>plays.length===3);await ready();assert.equal(plays.at(-1),all[0].id);
    pass('Pinned controls appear off-screen without duplicating or restarting media; pause, resume, next and previous operate the existing player');

    await page.locator('[data-view=sources]').click();await page.locator('#source-list .source-card').first().waitFor();await scrollBottom();
    assert.equal(await page.locator('#mini-player-title').textContent(),all[0].display_song_title);assert.equal(plays.length,3);
    await page.locator('#mini-player-volume').evaluate(input=>{input.value='37';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await until(async()=>Math.abs((await state()).volume-.37)<.001);
    await page.locator('#mini-player-mute').click();await until(async()=>(await state()).muted===true);
    assert.equal(await page.locator('#song-video').evaluate(video=>video.muted),true);
    assert.equal(await page.locator('#mini-player-original').getAttribute('href'),all[0].playback_url);
    await page.screenshot({path:path.join(output,'mini-desktop.png'),fullPage:false});
    pass('Source-tab navigation preserves playback; volume and mute use the same video and persist, and the original-video link follows the current song');

    await page.locator('#mini-player-show').click();await page.locator('#mini-player').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>document.activeElement.id),'player-compact');
    await page.locator('#player-compact').click();await until(async()=>(await state()).compact===true);
    await scrollBottom();await page.locator('#mini-player-show').click();
    await until(async()=>(await state()).compact===false);assert.equal(await page.locator('#music-player').evaluate(el=>el.classList.contains('compact')),false);
    assert.equal(plays.length,3);await scrollBottom();
    await page.locator('#pet-settings').click();await page.locator('#pet-dialog').waitFor({state:'visible'});
    for(let i=0;i<8;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement===document.body||!!document.activeElement.closest('#pet-dialog')),true);}
    await page.locator('#pet-dialog .close-dialog').first().click();assert.equal(await page.locator('#mini-player').isVisible(),true);
    pass('Expanding scrolls and focuses the original player, restores full layout, and keeps playback; modal dialogs retain keyboard focus above the pinned strip');

    await page.setViewportSize({width:390,height:844});await scrollBottom();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const mini=await page.locator('#mini-player').boundingBox();assert.ok(mini.x>=68&&mini.x+mini.width<=390&&mini.y+mini.height<=844);
    assert.ok(mini.height<=105);
    const rect=await page.locator('#mini-player-volume').boundingBox();assert.ok(rect.x+rect.width<=mini.x+mini.width);
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
    const bottom=await page.locator('#job-history').boundingBox();assert.ok(bottom.y+bottom.height<=mini.y,'Page content remains reachable above mini-player');
    await page.screenshot({path:path.join(output,'mini-mobile.png'),fullPage:false});
    await page.locator('#mini-player-show').click();await page.locator('#mini-player').waitFor({state:'hidden'});
    await page.locator('#player-compact').click();await until(async()=>(await state()).compact===true);
    await page.locator('#player-close').click();assert.equal(await page.locator('#mini-player').isVisible(),false);assert.equal(await page.locator('#song-video').getAttribute('src'),null);
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));assert.equal(await page.locator('#mini-player').isVisible(),false);
    assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('has-mini-player')),false);
    assert.deepEqual(errors,[]);pass('390px layout stays compact with reachable bottom content; stopping playback removes pinned controls and reserved space without JavaScript errors');

    await page.reload();await page.locator('#player-remembered').waitFor({state:'visible'});
    assert.equal(await page.locator('#song-video').evaluate(v=>v.volume),.37);assert.equal(await page.locator('#song-video').evaluate(v=>v.muted),true);
    assert.equal(await page.locator('#music-player').evaluate(el=>el.classList.contains('compact')),true);
    assert.equal(await page.locator('#music-player').isVisible(),false);assert.deepEqual((await state()).clip_ids,all.map(item=>item.id));
    await page.locator('#song-video').evaluate(video=>{video.volume=.22;video.muted=false;});
    await until(async()=>{const current=await state();return current.volume===.22&&!current.muted;});
    await page.reload();await page.locator('#player-remembered').waitFor({state:'visible'});
    assert.equal(await page.locator('#song-video').evaluate(v=>v.volume),.22);assert.equal(await page.locator('#song-video').evaluate(v=>v.muted),false);
    assert.equal(await page.locator('#music-player').evaluate(el=>el.classList.contains('compact')),true);
    pass('Native volume, mute and compact layout survive reload without autoplay or lost queue; preference changes also persist while stopped');

    const backup=await(await fetch(base+'/api/backup')).json();
    const saved=JSON.parse(backup.tables.playback_state[0].value);Object.assign(saved,{volume:.61,muted:true,compact:false});
    backup.tables.playback_state[0].value=JSON.stringify(saved);
    const backupFile=path.join(output,'restored-preferences.json');fs.writeFileSync(backupFile,JSON.stringify(backup));
    page.on('dialog',dialog=>dialog.accept());
    page.on('response',async response=>{if(response.url().endsWith('/api/restore')&&!response.ok())console.log('Restore response:',response.status(),await response.text());});
    await page.locator('#backup-file').setInputFiles(backupFile);
    try{await page.waitForFunction(()=>{const video=document.querySelector('#song-video');return video.volume===.61&&video.muted;});}catch(error){console.log('Restore diagnostic:',await page.locator('#toast').textContent(),{...await state(),items:undefined},errors);throw error;}
    await delay(600);const restored=await state();assert.equal(restored.volume,.61);assert.equal(restored.muted,true);assert.equal(restored.compact,false);
    assert.equal(await page.locator('#music-player').evaluate(el=>el.classList.contains('compact')),false);
    assert.deepEqual(restored.clip_ids,all.map(item=>item.id));assert.deepEqual(errors,[]);
    pass('Restoring a backup keeps its different volume/layout after reload; old page preferences do not overwrite restored settings');
    assert.equal(await page.evaluate(()=>window.mediaActions.size),0);
    await page.locator('[data-view=catalog]').click();
    const beforeMedia=plays.length;
    await page.evaluate(()=>document.querySelector('#song-video').loop=true);
    await page.locator('#playlist-select').selectOption(String(playlist.id));await page.locator('#playlist-play').click();await ready();
    async function action(name){await page.evaluate(name=>window.mediaActions.get(name)(),name);}
    const metadata=await page.evaluate(()=>{const m=navigator.mediaSession.metadata;return [m.title,m.artist,m.artwork.length];});
    assert.deepEqual(metadata,[all[0].display_song_title,all[0].uploader_name,0]);
    await action('pause');await page.waitForFunction(()=>document.querySelector('#song-video').paused&&navigator.mediaSession.playbackState==='paused');
    await action('play');await ready();await action('play');assert.equal(plays.length,beforeMedia+1);
    await action('nexttrack');await until(()=>plays.length===beforeMedia+2);await ready();
    assert.equal(plays.at(-1),all[1].id);
    assert.equal(await page.evaluate(()=>navigator.mediaSession.metadata.title),all[1].display_song_title);
    await action('previoustrack');await until(()=>plays.length===beforeMedia+3);await ready();
    assert.equal(plays.at(-1),all[0].id);

    restricted=true;await action('nexttrack');await page.locator('#player-retry').waitFor({state:'visible'});
    await action('play');await action('nexttrack');await action('previoustrack');
    assert.equal(plays.length,beforeMedia+4);assert.equal(await page.evaluate(()=>navigator.mediaSession.playbackState),'paused');
    await page.evaluate(()=>{window.oldMediaAction=window.mediaActions.get('nexttrack');});
    await page.locator('#player-close').click();
    assert.deepEqual(await page.evaluate(()=>[window.mediaActions.size,navigator.mediaSession.metadata,navigator.mediaSession.playbackState]),[0,null,'none']);
    await page.evaluate(()=>window.oldMediaAction());assert.equal(plays.length,beforeMedia+4);
    assert.deepEqual(errors,[]);pass('System transport callbacks control one current queue, carry title and uploader, preserve restricted pauses, and release on stop');
    // Hold a real client's first write until after the next volume change and
    // navigation. Deliver the older payload to the backend last, on purpose.
    let delayed;
    await page.exposeFunction('holdOlderPreferences',request=>{delayed=request;});
    await page.evaluate(()=>{
      const send=window.fetch.bind(window);
      window.fetch=async (url,options)=>{
        if(url==='/api/player-preferences'&&JSON.parse(options.body).volume===.11){
          await window.holdOlderPreferences({headers:options.headers,body:options.body});
          return new Promise(()=>{});
        }
        return send(url,options);
      };
      document.querySelector('#song-video').volume=.11;
    });
    await until(()=>!!delayed);
    await page.evaluate(()=>{document.querySelector('#song-video').volume=.77;location.reload();});
    await until(async()=>(await state()).volume===.77);
    const older=await fetch(base+'/api/player-preferences',{method:'PATCH',headers:delayed.headers,body:delayed.body});
    assert.equal((await older.json()).saved,false);
    assert.equal((await state()).volume,.77);
    pass('Immediate reload delivers the final volume while an earlier write is pending and rejects the delayed value');
    await page.close();await until(()=>server.exitCode!==null);assert.equal(server.exitCode,0);
    fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({checks,errors,output,packaged:!!exe},null,2));
  }finally{await browser.close();if(server.exitCode===null)spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{stdio:'ignore'});}
})().catch(error=>{console.error(error);process.exitCode=1;});
