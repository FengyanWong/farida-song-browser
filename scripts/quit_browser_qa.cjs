// Isolated preview only: account and shutdown responses are intercepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.argv[2] || process.env.FARIDA_PLAYWRIGHT_PATH || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:8770';
const qr = execFileSync(path.resolve('.venv/Scripts/python.exe'), ['-c',
  "import segno; print(segno.make('Offline quit test', micro=False).png_data_uri(scale=5,border=4))"], {encoding:'utf8'}).trim();

(async()=>{
  const browser = await chromium.launch({channel:'msedge', headless:true});
  const checks = [], errors = [];
  try {
    for (const mode of ['preview', 'connected', 'qr', 'late_check']) {
      const page = await browser.newPage({viewport:{width:1100,height:850}, locale:'zh-CN'});
      page.on('pageerror', error=>errors.push(error.message));
      let authCalls = 0, quitCalls = 0, releaseCheck;
      const auth = {state:mode==='connected'?'connected':'signed_out', stored:mode==='connected',
        account:mode==='connected'?{uid:'123',name:'测试账号'}:null, message:''};
      if (mode!=='preview') {
        await page.route(base+'/api/session', async route=>{
          const response = await route.fetch();
          await route.fulfill({response, json:{...await response.json(),preview_mode:false,can_shutdown:true}});
        });
        await page.route(base+'/api/auth**', async route=>{
          authCalls++;
          const pathname = new URL(route.request().url()).pathname;
          if (mode==='late_check' && pathname==='/api/auth/check') {
            await new Promise(resolve=>{releaseCheck=resolve;});
          }
          const result = pathname==='/api/auth/qr'
            ? {id:'offline',state:'waiting',qr_image:qr,expires_in:180,poll_after_ms:3000}
            : pathname.endsWith('/cancel') ? {cancelled:true} : auth;
          await route.fulfill({json:result});
        });
        await page.route(base+'/api/shutdown', async route=>{
          assert.equal(route.request().method(),'POST');
          assert.ok(route.request().headers()['x-farida-token']);
          quitCalls++;
          await route.fulfill({json:{status:'stopping'}});
        });
      }
      await page.goto(base);
      await page.locator('#clip-rows tr').first().waitFor();
      if (mode==='preview') {
        await page.locator('#account-toggle').click();
        assert.equal(await page.locator('[data-quit-app]:visible').count(),0);
        checks.push('Exit controls remain hidden in the demo preview');
      } else {
        if (mode==='qr') {
          await page.locator('#login-qr').waitFor({state:'visible'});
          await page.locator('#login-dialog [data-quit-app]').click();
        } else {
          if (mode==='connected') await page.waitForFunction(()=>document.querySelector('#account-status').textContent==='已登录');
          else while(!releaseCheck) await page.waitForTimeout(10);
          await page.locator('#account-toggle').click();
          await page.locator('#account-menu [data-quit-app]').click();
        }
        await page.locator('#shutdown-dialog').waitFor({state:'visible'});
        if (releaseCheck) releaseCheck();
        const callsAtExit = authCalls;
        await page.waitForTimeout(3500);
        assert.equal(quitCalls,1);
        assert.equal(authCalls,callsAtExit);
        assert.equal(await page.locator('#login-dialog').isVisible(),false);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#shutdown-dialog').isVisible(),true);
        checks.push(mode==='qr'?'Exit from mandatory login stops QR polling without reopening login':
          mode==='late_check'?'A late login response cannot reopen the app after exit':
          'Account-menu exit sends the local token and shows a clear closed state');
      }
      await page.close();
    }
    assert.deepEqual(errors,[]);
    const output=path.resolve('.local/browser-qa/quit-results.json');
    fs.writeFileSync(output,JSON.stringify({checks,errors},null,2));
    console.log(JSON.stringify({checks,errors},null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
