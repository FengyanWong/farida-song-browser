// Real local bookmark writes on a disposable catalog; no external media or login traffic.
const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<200;i++){if(await check())return;await delay(50);}throw Error('Bookmark check timed out');}
function gate(){let release;const wait=new Promise(resolve=>{release=resolve;});return {wait,release};}
(async()=>{
 const dir=path.resolve('.local/bookmark-qa');fs.mkdirSync(dir,{recursive:true});
 const data=fs.mkdtempSync(path.join(dir,'run-')),exe=process.argv[3];
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port;
 const args=[...(exe?[]:['-X','utf8',path.resolve('run.py')]),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',data];
 const service=spawn(path.resolve(exe||'.venv/Scripts/python.exe'),args,{stdio:'ignore',windowsHide:true});
 let browser;
 try{
  await until(async()=>{assert.equal(service.exitCode,null);try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
  const token=(await(await fetch(base+'/api/session')).json()).token;
  const mark=async(id,bookmarked)=>{assert.equal((await fetch(base+'/api/clips/'+encodeURIComponent(id)+'/bookmark',{method:'PATCH',headers:{'Content-Type':'application/json','X-Farida-Token':token},body:JSON.stringify({bookmarked})})).status,200);};
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let reads=0,patches=0,overviewReads=0;
  page.on('request',req=>{
   const u=new URL(req.url());if(u.pathname==='/api/clips')reads++;
   if(u.pathname==='/api/overview')overviewReads++;if(u.pathname.endsWith('/bookmark'))patches++;
  });
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.origin!==base)return route.abort();
   if(u.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'收藏测试'}}});
   return route.continue();
  });
  await page.goto(base);const stars=page.locator('#clip-rows [data-bookmark]');await stars.first().waitFor();
  const touched=new Set(),idOf=el=>el.getAttribute('data-bookmark');
  const focused=()=>page.evaluate(()=>document.activeElement.dataset.bookmark||document.activeElement.id);
  const activeStar=id=>page.locator('[data-bookmark="'+id+'"]');
  const patchURL='**/api/clips/*/bookmark';
  async function holdPatch(){
   const started=gate(),pending=gate();
   await page.route(patchURL,async route=>{started.release();await pending.wait;await route.continue();},{times:1});
   return {started:started.wait,release:pending.release};
  }
  const firstId=await idOf(stars.first()),first=activeStar(firstId);touched.add(firstId);
  const initialReads=reads,initialOverviews=overviewReads;
  const held=await holdPatch();await first.focus();
  await first.evaluate(el=>{window.originalStar=el;window.originalRow=el.closest('tr');});
  await first.press('Enter');await held.started;
  assert.equal(await first.getAttribute('aria-disabled'),'true');assert.equal(await focused(),firstId);
  await first.evaluate(el=>el.click());assert.equal(patches,1);
  held.release();await until(async()=>await first.getAttribute('aria-pressed')==='true'&&overviewReads>initialOverviews);
  assert.equal(await first.getAttribute('title'),'取消收藏');assert.equal(reads,initialReads);
  assert.equal(await first.evaluate(el=>el===window.originalStar&&el.closest('tr')===window.originalRow),true);assert.equal(await focused(),firstId);
  console.log('Ordinary keyboard star keeps the exact row and focus, refreshes totals, ignores duplicate activation and sends zero catalog GETs.');

  await page.route(patchURL,r=>r.fulfill({status:503,json:{detail:'收藏暂时失败'}}),{times:1});
  await first.press('Enter');await until(async()=>(await page.locator('#toast').textContent()).includes('收藏暂时失败'));
  assert.equal(await first.getAttribute('aria-pressed'),'true');assert.equal(await first.getAttribute('aria-disabled'),null);
  await first.press('Enter');await until(async()=>await first.getAttribute('aria-pressed')==='false');
  assert.equal(reads,initialReads);assert.equal(await focused(),firstId);
  console.log('Failed writes preserve the prior state and keyboard focus; retry updates the same star.');

  const gotOld=gate(),deliverOld=gate();
  await page.route('**/api/clips?*',async r=>{const old=await r.fetch();gotOld.release();await deliverOld.wait;await r.fulfill({response:old});},{times:1});
  await page.locator('[data-view=catalog]').click();await gotOld.wait;
  await first.focus();await first.press('Enter');await until(async()=>await first.getAttribute('aria-pressed')==='true');
  deliverOld.release();await until(async()=>await first.evaluate(el=>el!==window.originalStar));
  assert.equal(await first.getAttribute('aria-pressed'),'true');assert.equal(await focused(),firstId);
  const fromOldPage=await holdPatch();await first.press('Enter');await fromOldPage.started;
  await page.locator('#next-page').click();await until(async()=>await idOf(stars.first())!==firstId);
  const secondId=await idOf(stars.first()),second=activeStar(secondId);touched.add(secondId);
  await second.focus();await second.press('Space');await until(async()=>await second.getAttribute('aria-pressed')==='true');
  fromOldPage.release();await until(async()=>!(await(await fetch(base+'/api/clips/'+encodeURIComponent(firstId))).json()).bookmarked);
  assert.equal(await second.getAttribute('aria-pressed'),'true');assert.equal(await focused(),secondId);
  console.log('A delayed GET cannot undo a confirmed star, and a delayed mutation from page one leaves the page-two action and focus intact.');

  await page.locator('#group-songs').check();const group=page.locator('#clip-rows [data-group]').first();await group.click();
  const grouped=stars.first(),groupId=await idOf(grouped);touched.add(groupId);
  await grouped.evaluate(el=>window.groupedRow=el.closest('tr'));
  const groupReads=reads,previous=await grouped.getAttribute('aria-pressed');
  await grouped.focus();await grouped.press('Enter');await until(async()=>await grouped.getAttribute('aria-pressed')!==previous);
  assert.equal(await group.getAttribute('aria-expanded'),'true');assert.equal(reads,groupReads);assert.equal(await focused(),groupId);
  assert.equal(await grouped.evaluate(el=>el.closest('tr')===window.groupedRow),true);
  console.log('Expanded song versions keep their rows, keyboard focus, and group expansion on a star change.');

  await page.locator('#group-songs').uncheck();await until(async()=>!(await group.count())&&await stars.count()===40);
  for(const id of touched)await mark(id,false);
  const clips=(await(await fetch(base+'/api/clips?status=included&compact=true&page_size=41&sort=newest')).json()).items.map(item=>item.id);
  assert.equal(clips.length,41);for(const id of clips)await mark(id,true);
  await page.locator('#clip-filter').selectOption('bookmarked');await until(async()=>(await page.locator('#result-count').textContent()).includes('41 个片段'));
  await page.locator('[data-select="'+clips[5]+'"]').check();await page.locator('#next-page').click();
  await until(async()=>await stars.count()===1);const last=await idOf(stars.first());await page.locator('[data-select="'+last+'"]').check();
  await stars.first().focus();await stars.first().press('Enter');
  await until(async()=>await stars.count()===40);
  assert.equal(await focused(),await idOf(stars.last()));assert.equal(await page.locator('#page-number').textContent(),'1 / 1');
  assert.equal(await page.locator('#selected-count').textContent(),'已选择 1 项');assert.equal(await page.locator('[data-select="'+clips[5]+'"]').isChecked(),true);
  const neighboring=await idOf(stars.nth(9));await stars.nth(8).focus();await stars.nth(8).press('Space');
  await until(async()=>await stars.count()===39);assert.equal(await focused(),neighboring);
  const one=await idOf(stars.first());for(const id of clips)if(id!==one)await mark(id,false);
  await page.locator('[data-view=catalog]').click();await until(async()=>await stars.count()===1);
  await stars.first().focus();await stars.first().press('Enter');await page.locator('#empty-state').waitFor();
  assert.equal(await focused(),'clip-filter');assert.equal(await stars.count(),0);
  console.log('Favorites repaginates after removing its last page, keeps other selections, focuses the nearest star, and returns focus to the filter when empty.');
  assert.deepEqual(errors,[]);await page.close();await until(()=>service.exitCode!==null);assert.equal(service.exitCode,0);
 }finally{if(browser)await browser.close();if(service.exitCode===null)spawnSync('taskkill',['/PID',String(service.pid),'/T','/F'],{stdio:'ignore'});}
})().catch(error=>{console.error(error);process.exitCode=1;});
