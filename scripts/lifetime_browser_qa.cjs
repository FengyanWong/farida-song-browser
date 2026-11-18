// Test the application (or supplied EXE) with isolated data and offline account/media responses.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const executable=process.argv[3]?path.resolve(process.argv[3]):null;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=20000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await delay(100);}
  throw new Error('Timed out waiting for app lifetime transition');
}

(async()=>{
  const root=path.resolve('.local/browser-lifetime');fs.mkdirSync(root,{recursive:true});
  const output=fs.mkdtempSync(path.join(root,'run-'));
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  const env={...process.env};
  for(const name of ['PYTHONHOME','PYTHONPATH','VIRTUAL_ENV','FARIDA_COOKIE_FILE','FARIDA_DATA_DIR'])delete env[name];
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({locale:'zh-CN'});
  const checks=[],errors=[];let processHandle,loggedIn=true;
  const get=async route=>{const response=await fetch(base+route);assert.equal(response.status,200);return response.json();};
  async function start() {
    processHandle=spawn(executable || path.resolve('.venv/Scripts/python.exe'),[...(executable?[]:['-X','utf8',path.resolve('run.py')]),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',path.join(output,'数据')],{cwd:output,env,stdio:'ignore'});
    await until(async()=>{
      assert.equal(processHandle.exitCode,null,'EXE exited before becoming ready');
      try{return (await get('/api/health')).application==='farida-song-browser';}catch{return false;}
    });
  }
  async function stopped() {
    await until(()=>processHandle.exitCode!==null);
    assert.equal(processHandle.exitCode,0);
  }
  async function tab() {
    const page=await context.newPage(), state={connected:0,stopping:0,requests:0};
    page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))state.requests++;});
    await page.addInitScript(()=>{
      window.lifetimeAttempts=0;
      window.WebSocket=class extends WebSocket {
        constructor(url,...args) {
          super(url,...args);
          if(new URL(url,location.href).pathname==='/api/window')window.lifetimeAttempts++;
        }
      };
    });
    page.on('pageerror',error=>errors.push(error.message));
    page.on('websocket',socket=>{
      if(socket.url().endsWith('/api/window'))socket.on('framereceived',frame=>{
        const value=JSON.parse(frame.payload.toString()).state;
        if(value==='connected')state.connected++;
        if(value==='stopping')state.stopping++;
      });
    });
    await page.goto(base);
    await until(()=>state.connected>0);
    return {page,state};
  }
  let quitPosts=0;
  const wav=Buffer.alloc(44+8000*30,128);
  wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(8000,24);wav.writeUInt32LE(8000,28);wav.writeUInt16LE(1,32);wav.writeUInt16LE(8,34);
  wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base){await route.abort();return;}
    if(url.pathname==='/api/shutdown' && route.request().method()==='POST')quitPosts++;
    if(/^\/api\/clips\/[^/]+\/play$/.test(url.pathname))return route.fulfill({json:{segments:[{url:'/api/playback/media/lifetime'}],history_generation:1}});
    if(url.pathname==='/api/playback/media/lifetime')return route.fulfill({body:wav,contentType:'audio/wav'});
    if(!url.pathname.startsWith('/api/auth')){await route.continue();return;}
    const auth=loggedIn?{state:'connected',stored:true,account:{uid:'123',name:'离线测试'},message:''}
      :{state:'signed_out',stored:false,account:null,message:''};
    const result=url.pathname.endsWith('/cancel')?{cancelled:true}
      :url.pathname==='/api/auth/qr'||url.pathname.endsWith('/poll')
        ?{id:'offline',state:'waiting',expires_in:180,poll_after_ms:3000,
          qr_image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSSsAAAAASUVORK5CYII='}:auth;
    await route.fulfill({json:result});
  });
  try {
    await start();
    const first=await tab();
    const retryPage=await context.newPage();
    await retryPage.goto(base+'/assets/favicon.svg');
    const retries=await retryPage.evaluate(async()=>{
      const {AppLifetime}=await import('/lifetime.js');
      let pending=null,lastSocket,stops=0,attempts=0;
      const original={WebSocket:window.WebSocket,setTimeout:window.setTimeout,clearTimeout:window.clearTimeout};
      try {
        window.WebSocket=class extends EventTarget {
          constructor(){super();lastSocket=this;attempts++;}
          close() {}
        };
        window.setTimeout=(fn,ms)=>{pending={fn,ms};return 1;};
        window.clearTimeout=()=>{pending=null;};
        const life=new AppLifetime(()=>stops++);life.start('synthetic');
        const lose=()=>lastSocket.dispatchEvent(new CloseEvent('close',{code:1006}));
        const message=state=>lastSocket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({state})}));
        const delays=[];
        for(let i=0;i<10;i++){lose();delays.push(pending.ms);pending.fn();}
        message('connected');const idle=pending===null;
        lose();const recovered=pending.ms;pending.fn();
        message('stopping');lose();life.connect();
        return {delays,recovered,idle,stops,attempts,pending:!!pending};
      } finally {Object.assign(window,original);}
    });
    assert.deepEqual(retries.delays,[500,1000,2000,4000,8000,16000,30000,30000,30000,30000]);
    assert.deepEqual([retries.recovered,retries.idle,retries.stops,retries.attempts,retries.pending],[500,true,1,12,false]);
    await retryPage.close();
    checks.push('Interrupted sockets retry after 0.5 seconds then back off to 30 seconds; an authenticated connection resets the wait and schedules no heartbeat');
    const session=await get('/api/session');
    assert.equal(session.close_with_page,true);assert.equal(session.close_grace_seconds,5);
    const clip=(await get('/api/clips?page_size=1')).items[0];
    const saved=await fetch(base+`/api/clips/${clip.id}/bookmark`,{method:'PATCH',headers:{'Content-Type':'application/json','X-Farida-Token':session.token},body:JSON.stringify({bookmarked:true})});
    assert.equal(saved.status,200);
    await first.page.reload();await until(()=>first.state.connected===2);await delay(6000);
    assert.equal((await get('/api/session')).token,session.token);
    checks.push('Refreshing the last app tab reconnects without restarting the backend');

    const second=await tab();await first.page.close();await delay(6000);
    assert.equal(processHandle.exitCode,null);
    checks.push('Closing one of two app tabs keeps the remaining app running');

    const blank=await context.newPage();await blank.goto('about:blank');await blank.bringToFront();
    const cdp=await context.newCDPSession(second.page);
    await cdp.send('Page.setWebLifecycleState',{state:'frozen'});await delay(6000);
    assert.equal(processHandle.exitCode,null);await get('/api/health');
    await cdp.send('Page.setWebLifecycleState',{state:'active'});
    checks.push('A background/frozen document keeps the backend alive without JavaScript heartbeat timers');

    const beforeReturn=second.state.connected;
    await second.page.goto(base+'/assets/favicon.svg');await second.page.goBack();
    await until(()=>second.state.connected>beforeReturn);await delay(6000);
    assert.equal(processHandle.exitCode,null);
    checks.push('Back navigation restores the app connection during the close grace period');

    await second.page.close();await stopped();
    checks.push('Closing the last app tab exits the backend while unrelated tabs remain open');
    await blank.close();

    loggedIn=false;await start();
    assert.equal((await get('/api/overview')).bookmarked,1);
    const login=await tab();await login.page.locator('#login-dialog').waitFor({state:'visible'});
    await login.page.close();await stopped();
    checks.push('Restart preserves the saved catalog and bookmark; closing the login page also exits');

    await start();const crash=await tab();const crashSession=await context.newCDPSession(crash.page);
    const crashed=crash.page.waitForEvent('crash');
    crashSession.send('Page.crash').catch(()=>{});await crashed;await stopped();
    await crash.page.close();
    checks.push('Renderer termination exits the backend even without an unload handler');

    loggedIn=true;await start();
    const peer=await tab(),requester=await tab();
    await peer.page.locator('#clip-rows [data-play]').first().click();
    await peer.page.waitForFunction(()=>{const v=document.querySelector('#song-video');return v.currentTime>0 && !v.paused;});
    // A late restore reply normally reloads the page. Quit must supersede it.
    let restoreRoute;
    const restoreReceived=new Promise(resolve=>peer.page.route(base+'/api/restore',route=>{restoreRoute=route;resolve();}));
    peer.page.once('dialog',dialog=>dialog.accept());
    await peer.page.locator('#backup-file').setInputFiles({name:'offline.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    await restoreReceived;
    loggedIn=false;const scanning=await tab();
    await scanning.page.locator('#login-qr').waitFor();loggedIn=true;
    await requester.page.locator('#account-toggle').click();
    await requester.page.locator('#account-menu [data-quit-app]').click();
    const tabs=[peer,scanning,requester];
    await Promise.all(tabs.map(({page})=>page.locator('#shutdown-dialog').waitFor()));
    await stopped();
    const restoreReply=peer.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/restore');
    await restoreRoute.fulfill({json:{ok:true}});await restoreReply;
    assert.equal(quitPosts,1);assert.equal(peer.state.stopping,1);assert.equal(scanning.state.stopping,1);
    const stoppedCounts=tabs.map(({state})=>state.requests);
    for(const {page} of tabs){
      await page.keyboard.press('Escape');assert.equal(await page.locator('#shutdown-dialog').isVisible(),true);
      await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pageshow'));});
    }
    assert.equal(await peer.page.evaluate(()=>{const v=document.querySelector('#song-video');return v.paused && !v.getAttribute('src') && document.querySelector('#music-player').hidden;}),true);
    assert.equal(await scanning.page.locator('#login-dialog').isVisible(),false);
    await delay(11000);
    assert.deepEqual(tabs.map(({state})=>state.requests),stoppedCounts);
    assert.deepEqual(await Promise.all(tabs.map(({page})=>page.evaluate(()=>window.lifetimeAttempts))),[1,1,1]);
    assert.equal(quitPosts,1);
    await Promise.all(tabs.map(({page})=>page.close()));
    checks.push('Explicit quit in one window stops real audio and pending QR work in the other windows, with one shutdown POST and no later requests or socket attempts');
    assert.deepEqual(errors,[]);
    const result={checks,errors};
    fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  } finally {
    await browser.close();
    if(processHandle&&processHandle.exitCode===null)spawnSync('taskkill',['/PID',String(processHandle.pid),'/T','/F'],{stdio:'ignore'});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
