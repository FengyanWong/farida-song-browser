// Uses an installed Playwright package and Edge; neither is an app dependency.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const { chromium }=require(process.argv[2] || process.env.FARIDA_PLAYWRIGHT_PATH || 'playwright');

async function checkCoverRecovery(browser, base) {
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  const automatic = 'https://i0.hdslb.com/qa/reconnect.jpg';
  const manual = 'https://i0.hdslb.com/qa/manual.jpg';
  const blocked = 'https://covers.invalid/never.jpg';
  const permitted = new Set(), requests = new Map();
  const art = fs.readFileSync(path.resolve('frontend/assets/demo-cover.svg'));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('https://**/*', route => {
      const url = route.request().url();
      requests.set(url, (requests.get(url) || 0) + 1);
      return permitted.has(url) ? route.fulfill({contentType:'image/svg+xml',body:art}) : route.abort('internetdisconnected');
    });
    await page.route(url => url.pathname === '/api/clips', async route => {
      const response = await route.fetch(), result = await response.json();
      const fixtures = {'BV0000000009:9':automatic,'BV0000000007:7':manual,'BV0000000006:6':blocked};
      for (const item of result.items) if (fixtures[item.id]) item.thumbnail_url = fixtures[item.id];
      await route.fulfill({response,json:result});
    });
    await page.goto(base);
    const retry = page.getByRole('button',{name:'重新加载封面',exact:true});
    await page.waitForFunction(() => document.querySelectorAll('[data-retry-cover]').length === 2);
    assert.equal(requests.get(automatic),1);assert.equal(requests.get(manual),1);
    // Two ordinary list redraws leave failures dormant.
    await page.locator('#filter-button').click();
    for (const value of ['oldest','newest']) {
      const results = page.waitForResponse(r => new URL(r.url()).pathname === '/api/clips' && new URL(r.url()).searchParams.get('sort') === value);
      await page.locator('#sort').selectOption(value);await results;
      await page.waitForFunction(expected => {
        const first = document.querySelector('#clip-rows input[data-select]');
        return first?.dataset.select === expected && document.querySelectorAll('[data-retry-cover]').length === 2;
      }, value === 'oldest' ? 'BV0000000001:1' : 'BV0000000009:9');
    }
    assert.equal(requests.get(automatic),1);assert.equal(requests.get(manual),1);
    const selected = page.locator('[data-select="BV0000000009:9"]');
    await selected.check();
    await selected.evaluate(el => window.selectedBeforeCoverRetry = el);
    permitted.add(automatic);
    await context.setOffline(true);await page.waitForFunction(()=>!navigator.onLine);
    await context.setOffline(false);
    await page.waitForFunction(url => {
      const image = Array.from(document.querySelectorAll('.clip-cover img')).find(img => img.src === url);
      return image?.complete && image.naturalWidth > 0;
    },automatic);
    await page.waitForFunction(() => document.querySelectorAll('[data-retry-cover]').length === 1);
    assert.equal(requests.get(automatic),2);assert.equal(requests.get(manual),2);
    permitted.add(manual);
    await retry.focus();await page.keyboard.press('Enter');
    await page.waitForFunction(url => Array.from(document.querySelectorAll('.clip-cover img')).some(img => img.src === url && img.naturalWidth > 0),manual);
    assert.equal(requests.get(manual),3);assert.equal(requests.get(automatic),2);
    assert.equal(await selected.evaluate(el=>el.checked && el === window.selectedBeforeCoverRetry),true);
    assert.equal(await page.locator('.clip-cover[aria-label="暂无封面"]').count(),2);
    assert.equal(requests.has(blocked),false);assert.deepEqual(errors,[]);
  } finally {
    await context.close();
  }
}

(async()=>{
  const output=path.resolve('.local/browser-qa');fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
  const page=await context.newPage();const errors=[];const checks=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.goto(process.argv[3] || 'http://127.0.0.1:8766');
    await page.locator('#clip-rows tr').first().waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
    assert.equal(await page.locator('#pet-name').textContent(),'Frida');
    assert.match(await page.locator('#pet-sprite').evaluate(el=>getComputedStyle(el).backgroundImage),/frida\.webp/);
    assert.equal(await page.locator('#clip-rows tr').count(),9);
    assert.deepEqual(await page.locator('.nav-item').evaluateAll(items=>items.map(el=>el.dataset.view)),['catalog','sources']);
    assert.equal(await page.locator('[role=tablist]').count(),0);checks.push('Chinese two-tab interface, included-only default, Frida default');
    assert.equal(await page.locator('#preview-notice').isVisible(),true);
    await page.waitForFunction(()=>[...document.querySelectorAll('.clip-cover img')].every(img=>img.complete&&img.naturalWidth>0));
    assert.equal(await page.locator('.clip-cover img').count(),8);
    assert.equal(await page.locator('.clip-cover[aria-label="暂无封面"]').count(),1);checks.push('Labeled preview, lazy cover thumbnails, missing-cover placeholder');
    await checkCoverRecovery(browser, page.url());
    checks.push('Failed covers stay dormant on redraw, recover on reconnect or keyboard retry, and preserve the selected row and missing-cover placeholders');
    const startupJobs=await page.evaluate(async()=>await(await fetch('/api/sync')).json());
    assert.equal(startupJobs.length,1);assert.equal(startupJobs[0].mode,'incremental');assert.equal(startupJobs[0].source_ids.length,6);
    await page.waitForFunction(async()=>{const jobs=await(await fetch('/api/sync')).json();return jobs[0].state==='completed';});
    checks.push('Automatic startup update includes all six enabled sources');
    await page.screenshot({path:path.join(output,'catalog-desktop.png'),fullPage:true});
    await page.locator('#search').fill('月亮');await page.waitForTimeout(500);
    assert.equal(await page.locator('#clip-rows tr').count(),1);checks.push('Chinese debounced search');
    await page.locator('[data-bookmark]').click();await page.waitForTimeout(300);
    await page.locator('#clip-filter').selectOption('bookmarked');await page.waitForTimeout(300);
    assert.equal(await page.locator('#clip-rows tr').count(),1);checks.push('Bookmark filter within clips tab');
    await page.locator('[data-detail]').click();await page.locator('#detail-dialog').waitFor({state:'visible'});
    const openResponse=page.waitForResponse(r=>r.url().includes('/open')&&r.request().method()==='POST');
    await page.locator('#detail-content [data-open]').click();const opened=await (await openResponse).json();
    assert.equal(opened.url,'https://www.bilibili.com/video/BV0000000001/?p=1');checks.push('Open original dispatches the verified part URL to the system-browser endpoint');
    assert.equal(await page.locator('#detail-content a[href="https://fareeda.songlist.cc/"]').textContent(),'CLANNADOR · 小法的歌单 ↗');
    checks.push('Song-list attribution and original-site link in clip details');
    await page.getByText('修改歌名、分组与备注',{exact:true}).click();
    await page.locator('[name=display_song_title]').fill('演示 · 中文修正');await page.locator('[name=notes]').fill('保存中文备注');
    await page.locator('#annotation-form button').click();await page.waitForTimeout(300);
    await page.locator('#search').fill('中文修正');await page.waitForTimeout(500);
    assert.equal(await page.locator('.row-title').textContent(),'演示 · 中文修正');checks.push('Manual Chinese title/note correction');
    await page.reload();await page.locator('#clip-rows tr').first().waitFor();
    assert.equal(await page.locator('#clip-filter').inputValue(),'bookmarked');
    assert.equal(await page.locator('#clip-rows tr').count(),1);
    assert.equal(await page.evaluate(async()=>(await(await fetch('/api/sync')).json()).length),1);checks.push('Bookmark/filter survives reload without repeating startup scan');
    await page.locator('#clip-filter').selectOption('needs_review');await page.waitForTimeout(300);
    assert.equal(await page.locator('#clip-rows tr').count(),1);
    await page.locator('#select-page').check();await page.locator('[data-bulk=included]').click();await page.waitForTimeout(300);
    assert.equal(await page.locator('#clip-rows tr').count(),0);checks.push('Review filter and explicit selected-row bulk review');
    await page.locator('[data-view=sources]').click();
    assert.equal(await page.locator('.source-card').count(),6);
    const curatedCard=page.locator('.source-card').filter({has:page.locator('h3',{hasText:'CLANNADOR 歌单'})});
    assert.match(await curatedCard.textContent(),/CLANNADOR 整理/);
    assert.match(await curatedCard.textContent(),/1 首歌 · 1 个 BV 链接/);
    assert.equal(await curatedCard.locator('a').getAttribute('href'),'https://fareeda.songlist.cc/');
    checks.push('Curated song-list source with attribution, counts, and refresh control');
    await page.locator('#add-source').click();await page.locator('#source-name').fill('测试来源');
    const sourceUrl=page.locator('#source-url'),singing=page.locator('#singing-collection');
    await sourceUrl.fill('https://space.bilibili.com/123/lists/456?type=season');
    await singing.check();await page.locator('#source-form button[type=submit]').click();
    const newSource=page.locator('.source-card').filter({has:page.locator('h3',{hasText:'测试来源'})});
    await newSource.locator('[data-edit-source]').click();
    assert.equal(await singing.isChecked(),true);
    await sourceUrl.fill('https://space.bilibili.com/99887766');
    assert.equal(await singing.isDisabled(),true);assert.equal(await singing.isChecked(),false);
    await sourceUrl.fill('https://www.bilibili.com/medialist/play/123?business=space_series&business_id=456');
    assert.equal(await singing.isEnabled(),true);
    await sourceUrl.fill('99887766');assert.equal(await singing.isDisabled(),true);
    await page.locator('#source-form button[type=submit]').click();await page.waitForSelector('#source-dialog',{state:'hidden'});
    assert.equal(await page.locator('.source-card').count(),7);checks.push('Source editing clears collection-only evidence when the URL changes to an uploader');
    let sourcePosts=0, releaseSource;
    const sourceGate=new Promise(resolve=>{releaseSource=resolve;});
    const sourcesEndpoint='**/api/sources';
    await page.route(sourcesEndpoint,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      sourcePosts++;await sourceGate;return route.continue();
    });
    await page.locator('#add-source').click();
    await page.locator('#source-name').fill('延迟保存的来源');
    await sourceUrl.fill('ＵＩＤ：１２３４５６７９');
    const form=page.locator('#source-form'),saveSource=form.locator('[type=submit]');
    const pending=page.waitForRequest(req=>new URL(req.url()).pathname==='/api/sources' && req.method()==='POST');
    await form.evaluate(el=>{el.requestSubmit();el.requestSubmit();});await pending;
    assert.equal(await saveSource.isDisabled(),true);
    await form.getByRole('button',{name:'取消'}).click();
    await page.locator('#add-source').click();
    await page.locator('#source-name').fill('新的草稿');
    await sourceUrl.fill('UID: 111333');
    releaseSource();await page.locator('.source-card h3').filter({hasText:'延迟保存的来源'}).waitFor({state:'attached'});
    assert.equal(sourcePosts,1);
    assert.equal(await form.isVisible(),true);assert.equal(await saveSource.isEnabled(),true);
    assert.equal(await page.locator('#source-name').inputValue(),'新的草稿');
    assert.equal(await sourceUrl.inputValue(),'UID: 111333');
    await page.unroute(sourcesEndpoint);
    await page.route(sourcesEndpoint,route=>route.fulfill({status:503,json:{detail:'来源暂时无法保存'}}),{times:1});
    await saveSource.click();await page.getByText('来源暂时无法保存',{exact:true}).waitFor();
    assert.equal(await saveSource.isEnabled(),true);assert.equal(await sourceUrl.inputValue(),'UID: 111333');
    await form.getByRole('button',{name:'取消'}).click();
    checks.push('A labelled full-width UID saves once; a delayed save leaves a second source draft intact and a failed save keeps it editable');
    await page.locator('#sync-button').click();await page.waitForTimeout(150);
    await page.locator('#job-banner').waitFor({state:'visible'});await page.locator('[data-cancel]').first().click();
    await page.waitForFunction(()=>/已取消|已完成/.test(document.querySelector('#job-history').textContent),{timeout:8000});
    assert.match(await page.locator('#job-history').textContent(),/已取消|已完成/);checks.push('Job status and cancellation');
    await page.screenshot({path:path.join(output,'sources-desktop.png'),fullPage:true});
    // Directly exercise the exported layout math in the actual browser module.
    assert.deepEqual(await page.evaluate(async()=>{const m=await import('/pet.js');return [m.spriteVersion(1536,1872),m.spriteVersion(1536,2288),m.directionIndex(0,-100),m.directionIndex(100,0),m.directionIndex(0,100),m.directionIndex(-100,0)];}),[1,2,0,4,8,12]);
    const sprite=await page.evaluate(async()=>{
      const image=await createImageBitmap(await(await fetch('/assets/frida.webp')).blob());
      const canvas=document.createElement('canvas');canvas.width=1536;canvas.height=1872;
      canvas.getContext('2d').drawImage(image,0,0);image.close();
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#pet-settings').click();
    await page.locator('#pet-files').setInputFiles([{name:'v1-test.png',mimeType:'image/png',buffer:Buffer.from(sprite,'base64')},{name:'pet.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({displayName:'V1 测试',spriteVersionNumber:1}))}]);
    await page.waitForFunction(()=>document.querySelector('#pet-name').textContent==='V1 测试');
    await page.locator('#pet-dialog .close-dialog').last().click();await page.reload();
    await page.waitForFunction(()=>document.querySelector('#pet-name').textContent==='V1 测试');checks.push('v1 import and IndexedDB persistence');
    await page.locator('#pet-settings').click();await page.locator('#pet-files').setInputFiles([{name:'bad.png',mimeType:'image/png',buffer:Buffer.from('not an image')}]);
    await page.waitForFunction(()=>document.querySelector('#pet-message').textContent.includes('不是 PNG'));checks.push('Invalid pet rejection');
    await page.locator('#pet-files').setInputFiles([{name:'frida.webp',mimeType:'image/webp',buffer:fs.readFileSync(path.resolve('frontend/assets/frida.webp'))}]);
    await page.waitForFunction(()=>document.querySelector('#pet-message').textContent.includes('（v2）'));checks.push('v2 import');
    await page.locator('#pet-reset').click();await page.waitForFunction(()=>document.querySelector('#pet-name').textContent==='Frida');
    await page.locator('#pet-dialog .close-dialog').last().click();checks.push('Restore default Frida');
    await page.locator('[data-view=catalog]').click();await page.waitForTimeout(300);
    assert.equal(await page.locator('#clip-filter').inputValue(),'needs_review');
    await page.locator('#clip-filter').selectOption('included');await page.waitForTimeout(300);
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(output,'catalog-mobile.png'),fullPage:true});checks.push('390px mobile viewport without page overflow');
    await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(150);
    assert.equal(await page.locator('#pet-sprite').evaluate(el=>getComputedStyle(el).backgroundPosition),'0px 0px');checks.push('Reduced-motion support');
    assert.deepEqual(errors,[]);checks.push('No browser JavaScript errors');
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:checks.length,checks,errors},null,2));
    console.log(JSON.stringify({passed:checks.length,checks,errors},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
