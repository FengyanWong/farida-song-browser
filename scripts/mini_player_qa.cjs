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
  let restricted=false, signedOut=false, queueUploads=0, summaryReads=0, fullReads=0, queueWriter;
  const page=await context.newPage(),checks=[],errors=[],plays=[];
  const pass=message=>{checks.push(message);console.log('Passed: '+message);};
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{
    const url=new URL(request.url());
    if (url.pathname!=='/api/player-state') return;
    if (request.method()==='GET') {
      if (url.searchParams.get('summary')==='true') summaryReads++;else fullReads++;
    }
    if (request.method()==='PUT') {queueUploads++;queueWriter=request.headers()['x-farida-preference-writer'];}
  });
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
    const catalog=(await(await fetch(base+'/api/play-queue')).json()).items.filter(item=>item.playback_url);
    const all=catalog.slice(0,3);assert.equal(all.length,3);
    const playlist=await(await fetch(base+'/api/playlists',{method:'POST',headers:{'Content-Type':'application/json','X-Farida-Token':token},body:JSON.stringify({name:'迷你播放器测试',clip_ids:all.map(item=>item.id)})})).json();
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
      if(url.pathname.startsWith('/api/auth')) {
        if(url.pathname==='/api/auth/logout')signedOut=true;
        if(signedOut && url.pathname.startsWith('/api/auth/qr'))return route.fulfill({status:503,json:{detail:'测试页面已退出登录'}});
        return route.fulfill({json:signedOut?{state:'signed_out',stored:false,account:null,message:''}:
          {state:'connected',stored:true,account:{uid:'123',name:'迷你播放器测试'},message:''}});
      }
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

    const remembered=page.locator('#player-remembered');
    assert.equal(await remembered.isVisible(),true);
    assert.equal(await remembered.evaluate(el=>document.activeElement===el),true);
    const uploadsBefore=queueUploads, readsBefore=fullReads;
    await remembered.click();await ready();
    await page.locator('#player-next').click();await ready();
    await page.locator('#player-shuffle').click();await page.locator('#player-repeat').click();
    await page.locator('#player-skip-unavailable').click();
    await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>.6);
    const stoppedAt=await page.locator('#song-video').evaluate(video=>{video.pause();return video.currentTime;});
    const beforeStop=plays.length;
    await page.locator('#player-close').click();await remembered.waitFor();
    assert.equal(await remembered.textContent(),'继续播放：'+all[1].display_song_title);
    await until(async()=>{const saved=await state();return saved.current_id===all[1].id && Math.abs(saved.position-stoppedAt)<.05 && saved.shuffle && saved.repeat==='all' && saved.skip_unavailable;});
    assert.equal(plays.length,beforeStop);assert.equal(await page.locator('#song-video').getAttribute('src'),null);
    await page.locator('#song-video').evaluate(video=>{
      video.addEventListener('seeked',()=>{window.resumedPosition=video.currentTime;},{once:true});
    });
    await remembered.press('Enter');await ready();
    await page.waitForFunction(()=>window.resumedPosition!==undefined);
    assert.ok(Math.abs(await page.evaluate(()=>window.resumedPosition)-stoppedAt)<.2);
    assert.equal(plays.length,beforeStop+1);assert.equal(plays.at(-1),all[1].id);
    assert.equal(await page.locator('#player-position').textContent(),'2 / 3');
    assert.equal(await page.locator('#player-compact').evaluate(el=>document.activeElement===el),true);
    assert.equal(await page.locator('#player-shuffle').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#player-skip-unavailable').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#player-repeat').textContent(),'列表循环');
    assert.equal(queueUploads,uploadsBefore);assert.equal(fullReads,readsBefore);
    // Hold the first mode change until the old document has unloaded. Its older
    // sequence must not overwrite the final state sent when the player closes.
    let heldModeSave;
    await page.exposeFunction('holdModeSave',request=>{heldModeSave=request;});
    await page.evaluate(()=>{
      const send=window.fetch.bind(window);
      window.fetch=async (url,options)=>{
        if(url==='/api/player-state'&&options?.method==='PATCH'&&!options.keepalive){
          const progress=JSON.parse(options.body);
          if(!progress.shuffle&&progress.repeat==='all'){
            window.fetch=send;
            await window.holdModeSave({headers:options.headers,body:options.body});
            return new Promise(()=>{});
          }
        }
        return send(url,options);
      };
    });
    await page.locator('#player-shuffle').click();await until(()=>!!heldModeSave);
    await page.locator('#player-repeat').click();await page.locator('#player-repeat').click();await page.locator('#player-skip-unavailable').click();
    await page.locator('#player-close').click();
    pass('Explicit close offers the current song in the same page without autoplay; keyboard resume restores the position, queue and modes without uploading the queue again');

    await page.reload();await page.locator('#player-remembered').waitFor({state:'visible'});
    const lateModeSave=await fetch(base+'/api/player-state',{method:'PATCH',headers:heldModeSave.headers,body:heldModeSave.body});
    assert.equal((await lateModeSave.json()).saved,false);
    const closedState=await state();
    assert.deepEqual([closedState.current_id,closedState.shuffle,closedState.repeat,closedState.skip_unavailable],[all[1].id,false,'off',false]);
    pass('Immediate reload after closing preserves the last playback modes even when an older checkpoint arrives late');
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
    await remembered.waitFor({state:'visible'});
    restricted=false;await remembered.click();await ready();
    const beforeCheck=plays.length, sourceBeforeCheck=await page.locator('#song-video').getAttribute('src');
    await page.locator('#account-toggle').click();await page.locator('#check-login').click();
    await until(async()=>!(await page.locator('#check-login').isDisabled()));
    assert.equal(await page.locator('#song-video').getAttribute('src'),sourceBeforeCheck);
    assert.equal(await page.locator('#music-player').isVisible(),true);
    assert.equal(plays.length,beforeCheck);
    await page.waitForFunction(()=>document.querySelector('#song-video').currentTime>.45);
    const currentId=plays.at(-1);
    let signalLogout, releaseLogout;
    const logoutStarted=new Promise(resolve=>{signalLogout=resolve;}), holdLogout=new Promise(resolve=>{releaseLogout=resolve;});
    await page.route('**/api/auth/logout',async route=>{
      signalLogout();await holdLogout;await route.fulfill({status:503,json:{detail:'退出失败测试'}});
    },{times:1});
    const beforeLogout=plays.length;
    await page.locator('#account-toggle').click();await page.locator('#logout-button').click();await logoutStarted;
    assert.equal(await page.locator('#account-status').textContent(),'正在退出登录');
    assert.equal(await page.locator('#song-video').getAttribute('src'),null);
    assert.equal(await page.locator('#music-player').isHidden(),true);
    assert.equal(await remembered.isHidden(),true);
    await until(async()=>{const s=await state();return s.current_id===currentId && s.position>.4;});
    const savedOnLogout=(await state()).position;
    let queueReads=0;
    const countReads=request=>{if(new URL(request.url()).pathname==='/api/play-queue')queueReads++;};
    page.on('request',countReads);
    await page.locator('#play-all').focus();await page.keyboard.press('Enter');
    await page.evaluate(()=>{document.querySelector('#player-retry').click();document.querySelector('#player-next').click();});
    await delay(150);
    page.off('request',countReads);
    assert.equal(queueReads,0);assert.equal(plays.length,beforeLogout);
    releaseLogout();await remembered.waitFor({state:'visible'});
    assert.equal(await page.locator('#account-status').textContent(),'已登录');
    assert.equal(await page.locator('#logout-button').isEnabled(),true);
    assert.equal(await page.locator('#music-player').isHidden(),true);
    assert.equal(plays.length,beforeLogout);
    await remembered.click();await ready();
    assert.equal(plays.at(-1),currentId);
    assert.ok((await page.locator('#song-video').evaluate(v=>v.currentTime))>=savedOnLogout-.1);
    await page.locator('#player-close').click();
    pass('Pending logout stops playback and blocks new lookups or retries; failure restores login controls and a paused resume offer while a routine account check leaves playback alone');
    await page.locator('#account-toggle').click();await page.locator('#logout-button').click();
    await page.locator('#login-dialog').waitFor({state:'visible'});
    assert.equal(await remembered.isHidden(),true);
    const loggedOutPlays=plays.length;
    await page.reload();await page.locator('#login-dialog').waitFor({state:'visible'});await page.locator('#clip-rows tr').first().waitFor();
    assert.equal(await remembered.isHidden(),true);assert.equal(await page.locator('#music-player').isHidden(),true);
    assert.equal(plays.length,loggedOutPlays);
    pass('Logging out hides an existing resume offer; signed-out startup keeps the saved queue idle and hidden');
    assert.equal(summaryReads>0,true);
    signedOut=false;restricted=false;
    const ids=catalog.map(item=>item.id), stateURL=base+'/api/player-state';
    const writeState=async(method,body)=>{
      const response=await fetch(stateURL,{method,headers:{'Content-Type':'application/json','X-Farida-Token':token},body:JSON.stringify(body)});
      assert.equal(response.status,200);return response.json();
    };
    const firstQueue=await writeState('PUT',{name:'初始长队列',clip_ids:ids,current_id:ids[0],position:.44});
    const readsAtRest=fullReads, summariesAtRest=summaryReads, playsAtRest=plays.length;
    const incoming=page.waitForResponse(r=>r.url().endsWith('/api/player-state?summary=true'));
    await page.reload();await remembered.waitFor();
    const summary=await (await incoming).json();
    assert.ok(!('items' in summary)&&!('clip_ids' in summary)&&summary.preference_writer);
    assert.ok(ids.length>=1000);assert.equal(summaryReads,summariesAtRest+1);assert.equal(fullReads,readsAtRest);
    assert.equal(plays.length,playsAtRest);assert.equal(await remembered.textContent(),'继续播放：'+catalog[0].display_song_title);
    pass('Reopening a 1,000-plus-song queue loads only its summary and offers the saved song without fetching queue rows or media');

    const hydrate='**/api/player-state?compact=true&resume=true';
    await page.route(hydrate,r=>r.fulfill({status:503,json:{detail:'离线模拟'}}),{times:1});
    await remembered.click();await until(async()=>(await page.locator('#toast').textContent()).includes('再次点击'));
    assert.equal(await remembered.isEnabled(),true);assert.equal(plays.length,playsAtRest);
    await writeState('PATCH',{current_id:ids[1],position:.35,segment:0,shuffle:false,repeat:'off',skip_unavailable:false,sequence:1,queue_key:firstQueue.queue_key});
    await remembered.click();
    await until(async()=>await remembered.textContent()==='继续播放：'+catalog[1].display_song_title);
    assert.equal(plays.length,playsAtRest);
    await writeState('PUT',{name:'另外的队列',clip_ids:[ids[2],ids[1],ids[0]],current_id:ids[1],position:.54,shuffle:true,repeat:'one'});
    await remembered.click();await until(async()=>(await page.locator('#toast').textContent()).includes('另外的队列'));
    assert.equal(plays.length,playsAtRest);assert.equal(await remembered.isEnabled(),true);

    // Deliberately hold a real completed GET and ignore AbortSignal to exercise stale callbacks.
    async function holdResume(){
      await page.evaluate(()=>{
        const original=window.fetch.bind(window);
        window.fetch=async(url,options)=>{
          if(url!=='/api/player-state?compact=true&resume=true')return original(url,options);
          window.fetch=original;
          const response=await original(url,{...options,signal:undefined});
          await new Promise(resolve=>{window.releaseHydration=resolve;});
          return response;
        };
        window.releaseHydration=null;
      });
      await remembered.click();await page.waitForFunction(()=>!!window.releaseHydration);
    }
    const readsBeforeHold=fullReads;await holdResume();
    assert.equal(await remembered.isDisabled(),true);
    await remembered.evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})));
    assert.equal(fullReads,readsBeforeHold+1);
    await page.evaluate(()=>window.releaseHydration());await ready();assert.equal(plays.length,playsAtRest+1);
    assert.equal(plays.at(-1),ids[1]);assert.equal(await page.locator('#player-position').textContent(),'2 / 3');
    assert.equal(await page.locator('#player-shuffle').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#player-repeat').textContent(),'单曲循环');
    await until(()=>queueWriter===summary.preference_writer);
    pass('A failed queue read stays retryable; changed song and same-song replacement queue each require confirmation, double-clicks share one read, and playback keeps the original preference writer');

    await page.locator('#player-close').click();await page.reload();await remembered.waitFor();
    await holdResume();
    await page.locator('#playlist-select').selectOption(String(playlist.id));await page.locator('#playlist-play').click();await ready();
    const playsAfterNew=plays.length;assert.equal(plays.at(-1),all[0].id);
    await page.evaluate(()=>window.releaseHydration());await delay(160);
    assert.equal(plays.length,playsAfterNew);assert.equal(await page.locator('#player-title').textContent(),all[0].display_song_title);
    await page.locator('#player-close').click();await page.reload();await remembered.waitFor();
    await holdResume();
    await page.route('**/api/restore',route=>route.fulfill({status:400,json:{detail:'恢复失败测试'}}),{times:1});
    await page.locator('#backup-file').setInputFiles(backupFile);
    await until(async()=>(await page.locator('#toast').textContent()).includes('恢复失败测试'));
    await page.evaluate(()=>window.releaseHydration());await delay(160);
    assert.equal(await remembered.isEnabled(),true);assert.equal(await remembered.isVisible(),true);assert.equal(plays.length,playsAfterNew);
    await holdResume();
    await page.locator('#account-toggle').click();await page.locator('#logout-button').click();
    await page.locator('#login-dialog').waitFor();await page.evaluate(()=>window.releaseHydration());
    await delay(160);assert.equal(await remembered.isHidden(),true);assert.equal(plays.length,playsAfterNew);
    assert.deepEqual(errors,[]);
    pass('Delayed hydration cannot replace a newly started playlist, autoplay after a failed restore, or start media after logout');
    signedOut=false;
    await writeState('PUT',{name:'完整收藏',clip_ids:ids,current_id:ids.at(-1),position:.25,shuffle:false,repeat:'off'});
    await page.reload();await remembered.waitFor();
    assert.equal(await remembered.textContent(),'继续播放：'+catalog.at(-1).display_song_title);
    await page.evaluate(()=>{document.querySelector('#song-video').loop=true;});
    const writes=[];
    const trackCheckpoint=request=>{
      if(new URL(request.url()).pathname==='/api/player-state' && ['PATCH','PUT'].includes(request.method()))
        writes.push({method:request.method(),body:request.postDataJSON()});
    };
    page.on('request',trackCheckpoint);
    await remembered.click();await until(()=>plays.at(-1)===ids.at(-1));await ready();
    assert.equal(await page.locator('#player-position').textContent(),ids.length+' / '+ids.length);
    await until(()=>writes.some(write=>write.method==='PUT'));
    await page.locator('#player-shuffle').click();
    await page.evaluate(()=>{window.previousRandom=Math.random;Math.random=()=>0;});
    await page.locator('#player-next').click();await until(()=>plays.at(-1)===ids[0]);await ready();
    await page.evaluate(()=>{Math.random=window.previousRandom;});
    await until(async()=>{const current=await state();return current.current_id===ids[0] && current.shuffle;});
    await page.locator('#player-prev').click();await until(()=>plays.at(-1)===ids.at(-1));await ready();
    await page.locator('#player-close').click();await remembered.waitFor();
    await until(async()=>{const current=await state();return current.current_id===ids.at(-1) && current.shuffle;});
    const savedFull=await state();
    assert.deepEqual(savedFull.clip_ids,ids);
    assert.ok(savedFull.position>0);
    assert.deepEqual(writes.filter(write=>write.method==='PUT').map(write=>write.body.clip_ids),[ids]);
    const patches=writes.filter(write=>write.method==='PATCH');
    assert.ok(patches.some(write=>write.body.current_id===ids[0]));
    assert.ok(patches.every(write=>!Object.hasOwn(write.body,'clip_ids')));
    page.off('request',trackCheckpoint);
    const playsBeforeReopen=plays.length;
    await page.reload();await remembered.waitFor();
    assert.equal(await remembered.textContent(),'继续播放：'+catalog.at(-1).display_song_title);
    assert.equal(plays.length,playsBeforeReopen);
    pass('The entire '+ids.length+'-song catalog keeps its original order through shuffle, previous and close; one full checkpoint and small progress updates restore the last song without autoplay');
    await page.close();await until(()=>server.exitCode!==null);assert.equal(server.exitCode,0);
    fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({checks,errors,output,packaged:!!exe},null,2));
  }finally{await browser.close();if(server.exitCode===null)spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{stdio:'ignore'});}
})().catch(error=>{console.error(error);process.exitCode=1;});
