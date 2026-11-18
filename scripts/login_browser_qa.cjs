// Offline login UI checks. All account endpoints are intercepted; no user login.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const base=process.argv[3]||'http://127.0.0.1:8768';
const qr=execFileSync(path.resolve('.venv/Scripts/python.exe'),['-c',"import segno; print(segno.make('Farida OFFLINE UI TEST - not a login code', micro=False).png_data_uri(scale=5,border=4))"],{encoding:'utf8'}).trim();
const signedOut=()=>({state:'signed_out',stored:false,account:null,message:''});
const connected=()=>({state:'connected',stored:true,account:{uid:'123',name:'测试账号 · 演示'},message:''});

(async()=>{
 const output=path.resolve('.local/browser-qa');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
 const page=await context.newPage(),checks=[],errors=[];
 await page.addInitScript(()=>{
  window.loginDialogMutations=0;
  new MutationObserver(records=>{
   window.loginDialogMutations+=records.filter(record=>record.target.id==='login-dialog').length;
  }).observe(document,{subtree:true,attributes:true,attributeFilter:['open']});
 });
 page.on('pageerror',error=>errors.push(error.message));
 let auth=signedOut(),mode='happy',attempt=0,polls=0,delayGeneration=false,creating=false,checkOverride=null,checkCalls=0,manualScans=0,releaseCheck=null,holdCheck=false;
 const cancelled=[],pollTimes=[];
 const menu=async()=>{if(!await page.locator('#account-menu').isVisible())await page.locator('#account-toggle').click();};
 const signedIn=async()=>{await page.waitForFunction(()=>!document.querySelector('#login-dialog').open&&document.querySelector('#account-status').textContent==='已登录');};
 try{
  await page.goto(base+'/#sources');
  await page.waitForFunction(()=>document.querySelector('#account-status').textContent==='演示模式');
  await menu();assert.equal(await page.locator('#login-button').isDisabled(),true);
  await page.keyboard.press('Escape');checks.push('Demo account menu cannot connect a real account');
  await page.route(base+'/api/session',async route=>{
   const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),preview_mode:false}});
  });
  await page.route(base+'/api/sync',async route=>{
   if(route.request().method()==='POST'){manualScans++;await route.fulfill({status:401,json:{detail:'Offline test does not start collection'}});}
   else await route.continue();
  });
  await page.route(base+'/api/auth**',async route=>{
   const pathname=new URL(route.request().url()).pathname;let result;
   if(pathname==='/api/auth')result=auth;
   else if(pathname==='/api/auth/qr'){
    const id='offline-qr-'+ ++attempt;polls=0;creating=true;
    if(delayGeneration)await new Promise(resolve=>setTimeout(resolve,550));creating=false;
    result={id,state:'waiting',qr_image:qr,expires_in:180,poll_after_ms:3000};
   }else if(pathname.endsWith('/poll')){
    polls++;pollTimes.push(Date.now());const id=pathname.split('/')[4];
    if(mode==='expired')result={id,state:'expired',expires_in:0};
    else if(mode==='waiting'||polls===1)result={id,state:mode==='waiting'?'waiting':'scanned',expires_in:177,poll_after_ms:3000};
    else{auth=connected();result={id,state:'authenticated',auth,expires_in:174};}
   }else if(pathname.endsWith('/cancel')){cancelled.push(pathname.split('/')[4]);result={cancelled:true};}
   else if(pathname.endsWith('/logout')){auth=signedOut();result=auth;}
   else if(pathname.endsWith('/check')){checkCalls++;if(holdCheck)await new Promise(resolve=>{releaseCheck=resolve;});if(checkOverride){auth={...auth,...checkOverride};checkOverride=null;}result=auth;}
   else throw new Error('Unexpected local auth route');
   await route.fulfill({json:result});
  });
  await page.reload();await page.locator('#login-qr').waitFor({state:'visible'});
  assert.equal(await page.locator('#login-dialog .login-dismiss:visible').count(),0);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#login-dialog').isVisible(),true);
  assert.equal(await page.locator('#sync-button').isDisabled(),true);
  assert.equal(manualScans,0);assert.equal(attempt,1);
  await page.screenshot({path:path.join(output,'login-required-desktop.png')});
  checks.push('Opening without login automatically shows mandatory QR; Escape cannot bypass it');
  await page.waitForFunction(()=>document.querySelector('#login-message').textContent.includes('在手机上确认'));
  await signedIn();assert.equal(polls,2);assert.ok(pollTimes[1]-pollTimes[0]>=2900);
  assert.equal(manualScans,0);checks.push('Confirmed login enters app without a duplicate frontend collection request');
  assert.equal(await page.locator('#account-name').textContent(),'测试账号 · 演示');
  assert.equal(await page.locator('.nav-item').count(),2);assert.equal(await page.locator('.account-card').count(),0);
  const box=await page.locator('#account-toggle').boundingBox();assert.ok(box.x>1000&&box.y<80);
  await menu();assert.equal(await page.locator('#account-uid').textContent(),'UID 123');
  await page.screenshot({path:path.join(output,'account-menu-desktop.png')});
  await page.keyboard.press('Escape');assert.equal(await page.locator('#account-menu').isVisible(),false);
  await page.locator('[data-view=catalog]').click();assert.equal(await page.locator('#account-name').isVisible(),true);
  checks.push('Account name/status in upper right on both tabs, UID and controls in dropdown');
  const unreadable=()=>({state:'unavailable',stored:true,account:null,message:'未能读取本机保存的登录信息。'});
  const beforeUnreadable=attempt;
  auth=unreadable();await page.reload();await page.getByRole('button',{name:'重试读取登录信息'}).waitFor();
  assert.equal(await page.locator('#login-qr-box').isVisible(),false);
  assert.equal(await page.locator('#sync-button').isDisabled(),true);
  assert.equal(attempt,beforeUnreadable);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#login-dialog').isVisible(),true);
  const checksBeforeRetry=checkCalls;
  await page.locator('#login-check').click();
  await page.waitForFunction(()=>document.querySelector('#login-title').textContent==='读取已保存的登录'&&!document.querySelector('#login-check').disabled);
  assert.equal(checkCalls,checksBeforeRetry+1);assert.equal(attempt,beforeUnreadable);
  checkOverride=connected();await page.locator('#login-check').click();await signedIn();
  assert.equal(attempt,beforeUnreadable);checks.push('Temporarily unreadable saved login stays locked and reopens after a local retry without requesting a QR');
  auth=unreadable();await page.reload();
  await page.getByRole('button',{name:'重新扫码',exact:true}).click();
  await page.locator('#login-qr').waitFor({state:'visible'});assert.equal(attempt,beforeUnreadable+1);
  await signedIn();checks.push('Choosing a fresh QR from an unreadable saved login requests exactly one code');
  const previousAttempt=attempt,previousChecks=checkCalls;
  await page.reload();await signedIn();assert.equal(attempt,previousAttempt);assert.ok(checkCalls>previousChecks);assert.equal(manualScans,0);
  assert.equal(await page.evaluate(()=>window.loginDialogMutations),0);
  checks.push('Saved valid login reopens without flashing the dialog, creating a QR, or duplicating collection');
  holdCheck=true;await page.reload();
  await page.waitForFunction(()=>document.querySelector('#account-status').textContent==='正在验证登录');
  while(!releaseCheck)await page.waitForTimeout(10);
  assert.equal(await page.locator('#login-dialog').isVisible(),false);
  assert.equal(await page.locator('#login-qr-box').isVisible(),false);
  assert.equal(await page.locator('#sync-button').isDisabled(),true);
  assert.equal(attempt,previousAttempt);
  holdCheck=false;releaseCheck();releaseCheck=null;await signedIn();
  assert.equal(await page.evaluate(()=>window.loginDialogMutations),0);
  checks.push('Slow startup verification stays in the header and prevents collection until confirmed');
  await menu();checkOverride={state:'unknown',message:'暂时无法连接，请稍后检查。'};
  await page.locator('#check-login').click();await page.locator('#login-check').waitFor({state:'visible'});
  assert.equal(await page.locator('#login-dialog').isVisible(),true);assert.equal(attempt,previousAttempt);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#login-dialog').isVisible(),true);
  checkOverride={state:'connected',message:''};await page.locator('#login-check').click();await signedIn();
  checks.push('Unverifiable saved login remains locked; successful recheck unlocks without rescan');
  mode='expired';await menu();await page.locator('#logout-button').click();
  await page.waitForFunction(()=>document.querySelector('#login-message').textContent.includes('二维码已过期'));
  assert.equal(await page.locator('#account-status').textContent(),'未登录');
  const expiredAttempt=attempt;await page.waitForTimeout(3200);assert.equal(attempt,expiredAttempt);
  mode='happy';await page.locator('#login-retry').click();await signedIn();assert.equal(attempt,expiredAttempt+1);
  checks.push('Sign-out returns to required login; expired QR refreshes only on request');
  checkOverride={state:'expired',message:'登录已失效，请重新扫码登录。'};await menu();await page.locator('#check-login').click();
  await page.locator('#login-qr').waitFor({state:'visible'});assert.equal(await page.locator('#sync-button').isDisabled(),true);
  await signedIn();checks.push('Expired saved session requires fresh confirmation');
  mode='waiting';delayGeneration=true;const firstAttempt=attempt+1;
  await menu();await page.locator('#login-button').click();while(!creating)await page.waitForTimeout(10);
  await page.keyboard.press('Escape');await menu();await page.locator('#login-button').click();
  await page.locator('#login-qr').waitFor({state:'visible'});
  assert.ok(cancelled.includes('offline-qr-'+firstAttempt));assert.equal(attempt,firstAttempt+1);assert.ok(!cancelled.includes('offline-qr-'+attempt));
  checks.push('Optional account switch can close/reopen safely without cancelling the new QR');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('#login-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await page.screenshot({path:path.join(output,'login-required-mobile.png')});
  await page.keyboard.press('Escape');await menu();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('#account-name').isVisible(),true);
  const mobileMenu=await page.locator('#account-menu').boundingBox();assert.ok(mobileMenu.x>=68&&mobileMenu.x+mobileMenu.width<=390);
  await page.screenshot({path:path.join(output,'account-menu-mobile.png')});
  checks.push('Account and QR screens fit 390px viewport');
  assert.deepEqual(errors,[]);checks.push('No JavaScript errors');
  const result={passed:checks.length,checks,errors,accountEndpoints:'offline intercepted fixtures'};
  fs.writeFileSync(path.join(output,'login-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
