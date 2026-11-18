// Exercise the shipped frontend against a disposable catalog and local fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.argv[2] || process.env.FARIDA_PLAYWRIGHT_PATH || 'playwright');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test) {
  for (let attempt=0; attempt<200; attempt++) { if (await test()) return; await delay(50); }
  throw Error('Timed out waiting for the local app');
}

(async () => {
  const directory = path.resolve('.local/idle-qa'); fs.mkdirSync(directory,{recursive:true});
  const output = fs.mkdtempSync(path.join(directory,'run-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const exe = process.argv[3];
  const args = [...(exe ? [] : ['-X','utf8','run.py']), '--no-browser','--no-startup-scan','--port',String(port),'--data-dir',output];
  const server = spawn(path.resolve(exe || '.venv/Scripts/python.exe'), args, {stdio:'ignore',windowsHide:true});
  let browser;
  try {
    await until(async () => { assert.equal(server.exitCode,null); try {return (await fetch(base+'/api/health')).ok;} catch {return false;} });
    browser = await chromium.launch({channel:'msedge',headless:true});
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let overviews=0, clips=0, active=false;
    const overview = await (await fetch(base+'/api/overview?compact=true')).json();
    await page.route('**/*', async route => {
      const url=new URL(route.request().url());
      if (url.origin!==base) return route.abort();
      if (url.pathname.startsWith('/api/auth')) return route.fulfill({json:{state:'connected',stored:true,account:{uid:'1',name:'测试'}}});
      if (url.pathname==='/api/clips') clips++;
      if (url.pathname==='/api/overview') {
        assert.equal(url.searchParams.get('compact'),'true');overviews++;
        const jobs=active ? [{id:'local',state:'running',mode:'recent',processed:0,checkpoints:{},errors:[]}] : [];
        return route.fulfill({json:{...overview,jobs}});
      }
      return route.continue();
    });
    await page.goto(base);
    await page.locator('#clip-rows tr').first().waitFor();
    await until(async()=>await page.locator('#pet-sprite').evaluate(el=>el.style.backgroundImage.includes('frida.webp')));
    await page.clock.install();
    await page.evaluate(async () => {
      const {Pet} = await import('/pet.js');
      const tick = Pet.prototype.tick; window.petTicks=0;
      Pet.prototype.tick=function(){window.petTicks++;return tick.call(this);};
      window.changeVisible=(visible)=>{
        Object.defineProperty(document,'hidden',{value:!visible,configurable:true});
        document.dispatchEvent(new Event('visibilitychange'));
      };
      window.captureSprite=()=>document.querySelector('#pet-sprite').style.backgroundPosition;
      window.petOption=(option,value)=>{const control=document.querySelector(option);control.checked=value;control.dispatchEvent(new Event('change'));};
      // Re-arm existing timers on Playwright's deterministic clock.
      window.changeVisible(false); window.changeVisible(true);
    });
    await page.clock.runFor(10); await delay(150);
    await page.evaluate(()=>{window.petTicks=0;});
    await page.clock.runFor(2160);
    const idleFrames=await page.evaluate(()=>window.petTicks);
    assert.ok(idleFrames>=10 && idleFrames<=14,`Unexpected frame count ${idleFrames}`);
    for (const [selector,enabled] of [['#pet-motion',false],['#pet-visible',false]]) {
      await page.evaluate(([choice,value])=>{window.petOption(choice,value);window.petTicks=0;},[selector,enabled]);
      await page.clock.runFor(3000);assert.equal(await page.evaluate(()=>window.petTicks),0);
      await page.evaluate(choice=>window.petOption(choice,true),selector);
    }
    await page.emulateMedia({reducedMotion:'reduce'});await page.clock.runFor(500);
    await page.evaluate(()=>{window.petTicks=0;});await page.clock.runFor(2000);
    assert.equal(await page.evaluate(()=>window.captureSprite()),'0px 0px');assert.equal(await page.evaluate(()=>window.petTicks),0);
    await page.emulateMedia({reducedMotion:'no-preference'});await page.clock.runFor(400);
    await page.evaluate(()=>{window.changeVisible(false);window.petTicks=0;});
    const before=overviews;
    await page.clock.runFor(10050);assert.equal(overviews,before);assert.equal(await page.evaluate(()=>window.petTicks),0);
    const beforeClips=clips;active=true;
    await page.evaluate(()=>window.changeVisible(true));await page.clock.runFor(20);
    await until(()=>overviews>before && clips>beforeClips);
    await until(async()=>await page.locator('#job-banner').isVisible());
    const unchangedRows=clips;
    await page.evaluate(()=>{window.firstCatalogRow=document.querySelector('#clip-rows tr');});
    const activePolls=overviews;
    await page.clock.runFor(1600);await until(()=>overviews>activePolls);await delay(150);
    assert.equal(clips,unchangedRows);
    assert.equal(await page.evaluate(()=>window.firstCatalogRow===document.querySelector('#clip-rows tr')),true);
    const during=overviews;active=false;
    await page.clock.runFor(1700);await until(()=>overviews>during);
    await until(async()=>!(await page.locator('#job-banner').isVisible()));
    await page.evaluate(()=>{
      window.previousFilter=document.querySelector('#source-filter option');
      window.authChanges=0;
      document.addEventListener('farida-auth-change',()=>window.authChanges++);
    });
    const settled=overviews;
    await page.clock.runFor(10100);await until(()=>overviews>settled);await delay(150);
    assert.equal(await page.evaluate(()=>window.previousFilter===document.querySelector('#source-filter option')),true);
    assert.equal(await page.evaluate(()=>window.authChanges),0);
    await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.petTicks=0;});
    await page.clock.runFor(900);assert.equal(await page.evaluate(()=>window.petTicks),0);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await page.clock.runFor(500);assert.ok(await page.evaluate(()=>window.petTicks)>0);
    await page.close();await until(()=>server.exitCode!==null);assert.equal(server.exitCode,0);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({idleFrames,intervalMs:2160,inactiveTicks:0,backgroundOverviewRequests:0,activeAndIdlePolling:true,restoredOnPageshow:true,errors}));
  } finally {
    if (browser) await browser.close();
    if (server.exitCode===null) {
      try {const session=await (await fetch(base+'/api/session')).json();await fetch(base+'/api/shutdown',{method:'POST',headers:{'X-Farida-Token':session.token}});} catch {}
      await until(()=>server.exitCode!==null).catch(()=>server.kill());
    }
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
