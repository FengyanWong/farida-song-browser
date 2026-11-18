// Recovery uses real encoded local video and isolated data. External traffic is blocked.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(60);}throw Error('Recovery check timed out');}
(async()=>{
  const root=path.resolve('.local/playback-recovery-qa');fs.mkdirSync(root,{recursive:true});
  const output=fs.mkdtempSync(path.join(root,'run-'));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const base=`http://127.0.0.1:${port}`,exe=process.argv[3];
  const command=path.resolve(exe||'.venv/Scripts/python.exe');
  const args=[...(exe?[]:['-X','utf8',path.resolve('run.py')]),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',path.join(output,'数据')];
  const server=spawn(command,args,{cwd:path.resolve('.'),stdio:'ignore'});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});
  const page=await context.newPage(),checks=[],errors=[],requests=[],history=[];
  let lookup=()=>null,segments=1,mediaFailure=false,statusCategory='network',release=null;
  const pass=message=>{checks.push(message);console.log('Passed: '+message);};
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto('about:blank');
    const encoded=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
      const drawing=canvas.getContext('2d'),stream=canvas.captureStream(15),chunks=[];
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
      recorder.ondataavailable=event=>chunks.push(event.data);
      const ended=new Promise(resolve=>recorder.onstop=resolve);recorder.start();let frame=0;
      const timer=setInterval(()=>{drawing.fillStyle='#17283d';drawing.fillRect(0,0,320,180);drawing.fillStyle='#a9cdf7';drawing.fillRect(frame++%260,70,50,40);},60);
      await new Promise(resolve=>setTimeout(resolve,3600));clearInterval(timer);recorder.stop();await ended;
      stream.getTracks().forEach(track=>track.stop());
      return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}));});
    });
    const media=Buffer.from(encoded,'base64');assert.ok(media.length>1000);
    await until(async()=>{assert.equal(server.exitCode,null);try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
    const token=(await(await fetch(base+'/api/session')).json()).token;
    const all=(await(await fetch(base+'/api/play-queue')).json()).items.filter(item=>item.playback_url).slice(0,3);
    assert.equal(all.length,3);
    const playlist=await(await fetch(base+'/api/playlists',{method:'POST',headers:{'Content-Type':'application/json','X-Farida-Token':token},body:JSON.stringify({name:'恢复测试',clip_ids:all.map(item=>item.id)})})).json();
    const single=await(await fetch(base+'/api/playlists',{method:'POST',headers:{'Content-Type':'application/json','X-Farida-Token':token},body:JSON.stringify({name:'单首恢复测试',clip_ids:[all[0].id]})})).json();
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
      if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'恢复测试'},message:''}});
      if(/^\/api\/clips\/[^/]+\/play$/.test(url.pathname)){
        const id=decodeURIComponent(url.pathname.split('/')[3]);requests.push(id);const key='recovery_'+requests.length;
        const error=await lookup(id);
        if(error)return route.fulfill({status:error.status||409,headers:{'X-Farida-Error':error.category},json:{detail:error.message||'测试：'+error.category}});
        return route.fulfill({json:{segments:Array.from({length:segments},(_,i)=>({url:'/api/playback/media/'+key+'_'+i}))}});
      }
      if(url.pathname.startsWith('/api/playback/status/'))return route.fulfill({json:{category:statusCategory,message:'测试：'+statusCategory}});
      if(url.pathname.startsWith('/api/playback/media/'))return mediaFailure?route.fulfill({status:502,body:'connection failed'}):route.fulfill({body:media,contentType:'video/webm',headers:{'Accept-Ranges':'bytes'}});
      if(url.pathname==='/api/listening-history'&&route.request().method()==='POST')history.push(route.request().postDataJSON().clip_id);
      return route.continue();
    });
    await page.goto(base);await page.locator('#clip-rows tr').first().waitFor();
    await page.locator('#playlist-select').selectOption(String(playlist.id));
    async function start(){const before=requests.length;await page.locator('#playlist-play').click();await until(()=>requests.length>before);}
    async function ready(){await page.waitForFunction(()=>{const v=document.querySelector('#song-video');return v.currentTime>.05&&!v.paused;});}
    async function pause(position){await ready();await page.evaluate(value=>{const v=document.querySelector('#song-video');v.pause();if(value!==undefined)v.currentTime=value;},position);}
    async function error(){await page.evaluate(()=>document.querySelector('#song-video').dispatchEvent(new Event('error')));}
    async function stop(){await page.locator('#player-close').click();}
    async function repeat(label){for(let i=0;i<3&&await page.locator('#player-repeat').textContent()!==label;i++)await page.locator('#player-repeat').click();assert.equal(await page.locator('#player-repeat').textContent(),label);}
    async function skip(value){if((await page.locator('#player-skip-unavailable').getAttribute('aria-pressed')==='true')!==value)await page.locator('#player-skip-unavailable').click();}

    await start();await pause(1.1);await until(()=>history.length===1);
    const before=requests.length;await error();await until(()=>requests.length===before+1);await ready();
    assert.ok(await page.locator('#song-video').evaluate(v=>v.currentTime>=1.05));await pause(1.3);
    assert.equal(requests.at(-1),all[0].id);assert.equal(history.length,1);
    const after=requests.length;await error();await page.locator('#player-retry').waitFor({state:'visible'});await delay(300);assert.equal(requests.length,after);
    await page.locator('#player-retry').click();await until(()=>requests.length===after+1);await ready();
    assert.ok(await page.locator('#song-video').evaluate(v=>v.currentTime>=1.25));await pause();assert.equal(history.length,1);
    pass('One automatic URL refresh and manual retry resume at the saved position; pause/resume/retry do not duplicate history');await stop();

    segments=2;const segmentHistory=history.length;await start();
    await page.waitForFunction(()=>{const v=document.querySelector('#song-video');return v.currentSrc.endsWith('_1')&&v.currentTime>.1;});
    await pause(.6);const segmentRequests=requests.length;await error();await until(()=>requests.length===segmentRequests+1);await ready();
    assert.ok(await page.locator('#song-video').evaluate(v=>v.currentSrc.endsWith('_1')&&v.currentTime>=.55));
    await pause();assert.equal(history.length,segmentHistory+1);pass('Recovery retains the second media segment and time, with one history entry for the complete song');await stop();segments=1;

    mediaFailure=true;statusCategory='network';const failedRequests=requests.length,failedHistory=history.length;
    await start();await page.locator('#player-retry').waitFor({state:'visible'});await delay(300);
    assert.equal(requests.length,failedRequests+2);assert.equal(history.length,failedHistory);
    pass('Actual failed media requests trigger at most one URL refresh and create no listening history');await stop();mediaFailure=false;

    await start();await pause();await skip(true);await repeat('单曲循环');await stop();
    for(const category of ['restricted','authentication']){
      lookup=()=>({category,status:category==='restricted'?429:401});const count=requests.length,h=history.length;
      await start();await page.locator('#player-retry').waitFor({state:'visible'});await delay(300);
      assert.equal(requests.length,count+1);assert.equal(history.length,h);assert.ok((await page.locator('#player-status').textContent()).includes(category));await stop();
    }
    lookup=()=>null;mediaFailure=true;statusCategory='restricted';const restrictedRequests=requests.length;
    await start();await page.locator('#player-retry').waitFor({state:'visible'});await delay(300);assert.equal(requests.length,restrictedRequests+1);await stop();mediaFailure=false;statusCategory='network';
    pass('Login failures, lookup rate limits, and media rate limits pause without refreshing or skipping despite skip mode');

    lookup=id=>id===all[0].id?{category:'unavailable'}:null;const skipRequests=requests.length,skipHistory=history.length;
    await start();await ready();await pause();
    assert.deepEqual(requests.slice(skipRequests),[all[0].id,all[1].id]);assert.equal(history.length,skipHistory+1);assert.equal(history.at(-1),all[1].id);
    pass('Explicit unavailable clips are skipped when enabled, including with single-song repeat');await repeat('列表循环');await stop();

    lookup=()=>({category:'unsupported'});const allFailed=requests.length;
    await start();await page.locator('#player-retry').waitFor({state:'visible'});await delay(300);
    assert.equal(requests.length,allFailed+3);assert.ok((await page.locator('#player-status').textContent()).includes('没有可继续'));
    pass('A queue of unsupported clips stops after each song is tried once, even with list repeat');
    await repeat('单曲循环');await page.locator('#playlist-select').selectOption(String(single.id));const singleFailed=requests.length;
    await start();await page.locator('#player-retry').waitFor({state:'visible'});await delay(300);assert.equal(requests.length,singleFailed+1);
    await repeat('列表循环');await page.locator('#player-shuffle').click();await page.locator('#playlist-select').selectOption(String(playlist.id));const shuffleFailed=requests.length;
    await start();await page.locator('#player-retry').waitFor({state:'visible'});await delay(300);assert.equal(requests.length,shuffleFailed+3);assert.equal(new Set(requests.slice(shuffleFailed)).size,3);
    pass('A single unavailable song and a shuffled all-failed queue also stop without repeat loops');await page.locator('#player-shuffle').click();await stop();
    await page.reload();await page.locator('#playlist-select').selectOption(String(playlist.id));
    await page.waitForFunction(()=>document.querySelector('#player-skip-unavailable').getAttribute('aria-pressed')==='true');
    pass('The optional skip-unavailable preference survives reload');

    lookup=()=>null;await start();await pause();await repeat('循环：关');await skip(false);
    lookup=async()=>{lookup=()=>null;await new Promise(resolve=>release=resolve);return null;};
    await error();await until(()=>!!release);await page.locator('#player-next').click();await ready();await pause();
    const nextSrc=await page.locator('#song-video').getAttribute('src');release();release=null;await delay(250);
    assert.equal(await page.locator('#song-video').getAttribute('src'),nextSrc);assert.equal(await page.locator('#player-title').textContent(),all[1].display_song_title);
    pass('Next cancels an outstanding recovery lookup so stale responses cannot replace the chosen song');await stop();

    await start();await pause();lookup=async()=>{lookup=()=>null;await new Promise(resolve=>release=resolve);return null;};
    await error();await until(()=>!!release);await stop();release();release=null;await delay(250);
    assert.equal(await page.locator('#song-video').getAttribute('src'),null);assert.equal(await page.locator('#music-player').isVisible(),false);
    assert.deepEqual(errors,[]);pass('Closing the player cancels recovery and does not start hidden playback or cause JavaScript errors');
    await page.close();await until(()=>server.exitCode!==null);assert.equal(server.exitCode,0);
    const result={checks,errors,output,packaged:!!exe};fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{if(release)release();await browser.close();if(server.exitCode===null)spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{stdio:'ignore'});}
})().catch(error=>{console.error(error);process.exitCode=1;});
