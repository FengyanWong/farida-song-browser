// Offline two-tab session changes. Account, QR and media endpoints use synthetic values.
const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function gate(){let release;const wait=new Promise(resolve=>release=resolve);return {wait,release};}
async function until(check){for(let i=0;i<300;i++){if(await check())return;await delay(100);}throw Error('Timed out in two-tab login check');}
(async()=>{
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port,exe=process.argv[3],dir=path.resolve('.local/account-tabs-qa');fs.mkdirSync(dir,{recursive:true});
 const args=exe?['--no-browser','--no-startup-scan','--port',String(port),'--data-dir',fs.mkdtempSync(path.join(dir,'run-'))]:
     ['-B','-X','utf8','scripts/serve_qa.py','--port',String(port)];
 const server=spawn(path.resolve(exe||'.venv/Scripts/python.exe'),args,{stdio:'ignore',windowsHide:true});let browser;
 try{
  await until(async()=>{assert.equal(server.exitCode,null);try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
  browser=await chromium.launch({channel:'msedge',headless:true});const ctx=await browser.newContext(),a=await ctx.newPage(),b=await ctx.newPage(),errors=[];
  for(const page of [a,b])page.on('pageerror',e=>errors.push(e.message));
  const account=(uid,name)=>({state:'connected',stored:true,account:{uid,name},message:''});
  const signedOut={state:'signed_out',stored:false,account:null,message:''};
  const original=account('12001','离线甲'),replacement=account('12002','离线乙');
  const qr='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6jqkAAAAASUVORK5CYII=';
  // Four seconds of silent 8-bit PCM, played by the real HTML media element.
  const samples=32000,media=Buffer.alloc(44+samples,128);
  media.write('RIFF',0);media.writeUInt32LE(36+samples,4);media.write('WAVEfmt ',8);media.writeUInt32LE(16,16);
  media.writeUInt16LE(1,20);media.writeUInt16LE(1,22);media.writeUInt32LE(8000,24);media.writeUInt32LE(8000,28);
  media.writeUInt16LE(1,32);media.writeUInt16LE(8,34);media.write('data',36);media.writeUInt32LE(samples,40);
  let auth=original, statusReads=0, checks=0, overviewReads=0, badOverview=false, confirmSwitch=false, activeChallenge=false, challenges=0, plays=0;
  const qrTabs=[],observers=new Map();
  await ctx.addInitScript(()=>{window.authSignals=[];window.addEventListener('storage',e=>{if(e.key==='farida-session-change')window.authSignals.push(e.newValue);});});
  await ctx.route('**/*',async route=>{
   const u=new URL(route.request().url()),tab=route.request().frame().page();if(u.origin!==base)return route.abort();
   if(u.pathname==='/api/session'){const r=await route.fetch();return route.fulfill({response:r,json:{...await r.json(),preview_mode:false}});}
   if(u.pathname==='/api/overview'){if(tab===b){overviewReads++;if(badOverview)return route.fulfill({status:503,json:{detail:'测试目录暂时忙'}});}
    const r=await route.fetch();return route.fulfill({response:r,json:{...await r.json(),jobs:[]}});}
   if(u.pathname==='/api/auth/check'){checks++;return route.fulfill({json:auth});}
   if(u.pathname==='/api/auth'){if(tab===b)statusReads++;return route.fulfill({json:auth});}
   if(u.pathname==='/api/auth/logout'){auth=signedOut;activeChallenge=false;observers.clear();return route.fulfill({json:auth});}
   if(u.pathname==='/api/auth/qr'){if(!activeChallenge){challenges++;activeChallenge=true;}
    const observer=u.searchParams.get('observer');if(!observers.has(observer))observers.set(observer,'offline-'+challenges+'-'+observers.size);
    qrTabs.push(tab);return route.fulfill({json:{id:observers.get(observer),qr_image:qr,state:'waiting',expires_in:180,poll_after_ms:3000}});}
   if(u.pathname.endsWith('/poll')){if(confirmSwitch){confirmSwitch=false;activeChallenge=false;auth=replacement;return route.fulfill({json:{state:'authenticated',auth}});}
    return route.fulfill({json:{state:'waiting',expires_in:160,poll_after_ms:3000}});}
   if(u.pathname.endsWith('/cancel'))return route.fulfill({json:{cancelled:true}});
   if(u.pathname.endsWith('/play')){plays++;return route.fulfill({json:{segments:[{url:'/api/playback/media/offline_audio'}]}});}
   if(u.pathname==='/api/playback/media/offline_audio')return route.fulfill({contentType:'audio/wav',body:media});
   return route.continue();
  });
  const nameIs=(page,name)=>page.waitForFunction(n=>document.querySelector('#account-name')?.textContent===n,name);
  const menu=async page=>{if(!await page.locator('#account-menu').isVisible())await page.locator('#account-toggle').click();};
  await Promise.all([a.goto(base),b.goto(base)]);await Promise.all([nameIs(a,'离线甲'),nameIs(b,'离线甲')]);
  await b.evaluate(()=>document.querySelector('#song-video').loop=true);
  await b.locator('#play-all').click();await b.waitForFunction(()=>{const video=document.querySelector('#song-video');return video.currentTime>.05&&!video.paused;});assert.equal(plays,1);
  await b.locator('[data-view=sources]').click();await b.locator('[data-scan-source]').first().waitFor();
  assert.equal(await b.locator('#music-player').evaluate(panel=>panel.hidden),false);
  await b.clock.install();const initialChecks=checks;
  const beforeAuth=statusReads,beforeOverview=overviewReads;
  await b.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await b.clock.runFor(100);
  await until(()=>statusReads>beforeAuth && overviewReads>beforeOverview);
  assert.equal(statusReads,beforeAuth+1);assert.equal(overviewReads,beforeOverview+1);

  // Get a stale local status before A changes accounts, then deliver it after the peer update.
  const oldStatus=gate(),statusStarted=gate();
  await b.route('**/api/auth',async r=>{const old=auth;statusStarted.release();await oldStatus.wait;await r.fulfill({json:old});},{times:1});
  await b.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await b.clock.runFor(100);await statusStarted.wait;
  badOverview=true;await menu(a);await a.locator('#login-button').click();await a.locator('#login-qr').waitFor();
  confirmSwitch=true;await a.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await Promise.all([nameIs(a,'离线乙'),nameIs(b,'离线乙')]);
  assert.equal(await b.locator('#music-player').evaluate(panel=>panel.hidden),true);
  assert.equal(await b.locator('#song-video').evaluate(video=>video.paused&&!video.hasAttribute('src')),true);
  await menu(b);assert.equal(await b.locator('#account-uid').textContent(),'UID 12002');assert.equal(await b.locator('[data-scan-source]').first().isEnabled(),true);
  const staleReceived=b.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth');oldStatus.release();await(await staleReceived).finished();
  await delay(80);assert.equal(await b.locator('#account-name').textContent(),'离线乙');assert.equal(checks,initialChecks);assert.equal(plays,1);
  assert.deepEqual(await b.evaluate(()=>window.authSignals.map(s=>/^[a-f\d-]{36}$/i.test(s))),[true]);
  console.log('A peer account switch updates the header/UID, closes old playback, and rejects stale status. Healthy polling uses one overview and one cached auth read.');

  // A check in B already has the old account response when A signs out.
  const staleCheck=gate(),checkStarted=gate();
  await b.route('**/api/auth/check',async r=>{const old=auth;checkStarted.release();await staleCheck.wait;await r.fulfill({json:old});},{times:1});
  await b.locator('#check-login').click();await checkStarted.wait;
  await menu(a);await a.locator('#logout-button').click();await a.locator('#login-dialog').waitFor();await b.locator('#login-dialog').waitFor();
  await b.locator('#login-qr').waitFor();assert.equal(await b.locator('[data-scan-source]').first().isDisabled(),true);
  const beforeRelease=qrTabs.filter(t=>t===b).length;
  const delivered=b.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/check');staleCheck.release();await(await delivered).finished();
  await until(async()=>await b.locator('#account-status').textContent()==='未登录' && !await b.locator('#login-check').isDisabled());
  assert.equal(await b.locator('#login-dialog').isVisible(),true);assert.equal(qrTabs.filter(t=>t===b).length,beforeRelease);
  assert.equal(challenges,2);assert.equal(checks,initialChecks);assert.equal(plays,1);
  const beforeFailure=statusReads;
  // A local status change without a browser signal still reaches a visible peer on the normal poll.
  auth=original;
  await b.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await b.clock.runFor(100);
  await nameIs(b,'离线甲');await b.locator('#login-dialog').waitFor({state:'hidden'});
  assert.equal(statusReads,beforeFailure+1);assert.equal(await b.locator('[data-scan-source]').first().isEnabled(),true);
  assert.equal(checks,initialChecks);assert.equal(plays,1);
  assert.deepEqual(errors,[]);console.log('During an overview outage, logout gates the peer and its source actions immediately. A late explicit check cannot unlock it or create another QR; local session polling remains independent.');
 }finally{if(browser)await browser.close();if(server.exitCode===null)spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{stdio:'ignore'});}
})().catch(e=>{console.error(e);process.exitCode=1;});
