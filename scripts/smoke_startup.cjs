const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.argv[2]||'playwright');
(async()=>{
  const base=process.argv[3]||'http://127.0.0.1:8765';
  const health=await(await fetch(base+'/api/health')).json();
  assert.equal(health.application,'farida-song-browser');
  const overview=await(await fetch(base+'/api/overview')).json();
  assert.equal(overview.entries,0);
  assert.deepEqual(overview.sources.filter(s=>s.source_type==='uploader').map(s=>s.uid).sort(),['210887872','290566607','394803911','475349220']);
  assert.ok(overview.sources.every(s=>s.verification_status==='pending'));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:950},locale:'zh-CN'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.locator('#empty-state h2').waitFor();await page.waitForTimeout(600);
    assert.equal(await page.locator('#pet-name').textContent(),'Frida');
    await page.screenshot({path:'.local/app-preview.png',fullPage:true});
    await page.locator('[data-view=sources]').click();
    assert.equal(await page.locator('.source-card').count(),6);
    await page.screenshot({path:'.local/sources-preview.png',fullPage:true});
    await page.goto('http://127.0.0.1:8766/#catalog');await page.locator('#clip-rows tr').first().waitFor();
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
    assert.equal(await page.locator('.brand>span:last-child').isVisible(),false);
    assert.ok(await page.locator('.row-actions').first().evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
    await page.screenshot({path:'.local/browser-qa/catalog-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({startup:'passed',real_entries:0,sources:overview.sources.length,mobile_controls:'visible',browser_errors:errors}));
  }finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
