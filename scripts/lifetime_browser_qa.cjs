// Test the actual EXE with isolated data and mocked Bilibili account responses.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const executable=path.resolve(process.argv[3]);
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
    processHandle=spawn(executable,['--no-browser','--no-startup-scan','--port',String(port),'--data-dir',path.join(output,'数据')],{cwd:output,env,stdio:'ignore'});
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
    const page=await context.newPage(), state={connected:0};
    page.on('pageerror',error=>errors.push(error.message));
    page.on('websocket',socket=>{
      if(socket.url().endsWith('/api/window'))socket.on('framereceived',frame=>{
        if(JSON.parse(frame.payload.toString()).state==='connected')state.connected++;
      });
    });
    await page.goto(base);
    await until(()=>state.connected>0);
    return {page,state};
  }
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base){await route.abort();return;}
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
    checks.push('Closing the last app tab exits the real EXE while unrelated tabs remain open');
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
    assert.deepEqual(errors,[]);
    const result={checks,errors};
    fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  } finally {
    await browser.close();
    if(processHandle&&processHandle.exitCode===null)spawnSync('taskkill',['/PID',String(processHandle.pid),'/T','/F'],{stdio:'ignore'});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
