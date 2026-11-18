// Playlist search browser regression checks. Uses an isolated local database and
// intercepted playback responses; never reads a real login or contacts Bilibili.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(100);}throw Error('Playlist search check timed out');}
(async()=>{
  const root=path.resolve('.local/playlist-search-qa');fs.mkdirSync(root,{recursive:true});
  const output=fs.mkdtempSync(path.join(root,'run-'));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const base=`http://127.0.0.1:${port}`,exe=process.argv[3];
  const args=[...(exe?[]:['-X','utf8',path.resolve('run.py')]),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',path.join(output,'数据')];
  const service=spawn(path.resolve(exe||'.venv/Scripts/python.exe'),args,{cwd:path.resolve('.'),stdio:'ignore'});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});
  const page=await context.newPage(),checks=[],errors=[],plays=[];
  const pass=message=>{checks.push(message);console.log('Passed: '+message);};
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await until(async()=>{assert.equal(service.exitCode,null);try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
    const all=(await(await fetch(base+'/api/play-queue')).json()).items.filter(item=>item.playback_url);
    assert.ok(all.length>=6);
    assert.ok(Object.hasOwn(all[0],'raw_title'),'Queue must include original video title');
    assert.ok(Object.hasOwn(all[0],'raw_part_title'),'Queue must include original part title');
    const fixtures=all.slice(0,6).map((clip,index)=>({...clip,display_song_title:['第一首','月亮 Café','第三首','第四首','月亮之上','<夜色> ＭＯＯＮ'][index],uploader_name:index===4?'阿见':'CLANNADOR',raw_title:index===3?'隐藏标题 古典 2026':'原始标题 '+index,raw_part_title:index===2?'独特分P名称':'分P '+index}));
    const fixtureById=new Map(fixtures.map(item=>[item.id,item]));
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==base)return route.abort();
      if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'歌单搜索测试'},message:''}});
      if(url.pathname==='/api/play-queue')return route.fulfill({json:{items:fixtures}});
      if(/^\/api\/playlists\/\d+$/.test(url.pathname)&&route.request().method()==='GET'){
        const response=await route.fetch(),result=await response.json();
        result.items=result.items.map(item=>({...item,...fixtureById.get(item.id),playback_url:item.id===fixtures[2].id?null:item.playback_url}));return route.fulfill({response,json:result});
      }
      if(/^\/api\/clips\/[^/]+\/play$/.test(url.pathname)){
        plays.push(decodeURIComponent(url.pathname.split('/')[3]));
        return route.fulfill({status:503,json:{detail:'测试视频已暂停'}});
      }
      return route.continue();
    });
    await page.addInitScript(()=>{
      Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{
        if(window.__denyClipboard)throw Error('Clipboard unavailable');
        window.__copied=value;
      }}});
    });
    await page.goto(base);await page.locator('#clip-rows tr').first().waitFor();
    await page.locator('#play-all').click();await until(()=>plays.length===1);
    assert.equal(await page.locator('#player-queue button').count(),6);
    await page.locator('#player-queue-search').fill('月亮');
    assert.equal(await page.locator('#player-queue button').count(),2);
    assert.equal(await page.locator('#player-queue-count').textContent(),'2 / 6 首');
    assert.deepEqual(await page.locator('#player-queue button').evaluateAll(rows=>rows.map(row=>row.dataset.queueIndex)),['1','4']);
    await page.locator('#player-queue-search').fill('clannador ＣＡＦＥ́');
    assert.equal(await page.locator('#player-queue button').count(),1);
    assert.equal(await page.locator('#player-queue button').getAttribute('data-queue-index'),'1');
    await page.locator('#player-queue-search').fill('moon');
    assert.equal(await page.locator('#player-queue b').textContent(),'<夜色> ＭＯＯＮ');
    await page.locator('#player-queue-search').fill('独特分P');
    assert.equal(await page.locator('#player-queue button').getAttribute('data-queue-index'),'2');
    await page.locator('#player-queue-search').fill('古典');
    await page.locator('#player-queue button').click();await until(()=>plays.at(-1)===fixtures[3].id);
    assert.equal(await page.locator('#player-position').textContent(),'4 / 6');
    await page.locator('#player-next').click();await until(()=>plays.at(-1)===fixtures[4].id);
    assert.equal(await page.locator('#player-position').textContent(),'5 / 6');
    assert.equal(await page.locator('#player-queue button').count(),1);
    await page.locator('#player-queue-search').fill('不存在的歌曲');
    assert.equal(await page.locator('#player-queue-count').textContent(),'0 / 6 首');
    assert.match(await page.locator('#player-queue').textContent(),/没有匹配/);
    await page.locator('#player-queue-clear').click();
    assert.equal(await page.locator('#player-queue button').count(),6);
    assert.equal(await page.locator('#player-queue [aria-current]').getAttribute('data-queue-index'),'4');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'player-queue-search');
    pass('Queue search handles Chinese, uploader, original video/part titles, Unicode width/case and empty results while preserving real playback indexes');
    await page.locator('#player-queue-search').fill('月亮');await page.locator('#player-save').click();
    assert.equal(await page.locator('#playlist-items li').count(),6);
    await page.locator('#playlist-name').fill('搜索回归歌单');
    await page.locator('#playlist-save-button').click();await page.locator('#playlist-dialog').waitFor({state:'hidden'});
    const savedId=await page.locator('#playlist-select').inputValue();
    let saved=await(await fetch(base+'/api/playlists/'+savedId)).json();
    assert.deepEqual(saved.items.map(item=>item.id),fixtures.map(item=>item.id));
    await page.locator('#playlist-edit').click();
    await page.locator('#playlist-search').fill('月亮');
    assert.equal(await page.locator('#playlist-items li').count(),2);
    assert.match(await page.locator('#playlist-item-count').textContent(),/^2 \/ 6 首/);
    await page.locator('#playlist-search').press('Enter');
    assert.equal(await page.locator('#playlist-dialog').isVisible(),true);
    await page.locator('#playlist-items [data-item="4"][data-move="-1"]').click();
    assert.equal(await page.locator('#playlist-items [data-item="3"][data-move="-1"]').count(),1);
    await page.locator('#playlist-items [data-remove="1"]').click();
    assert.match(await page.locator('#playlist-item-count').textContent(),/^1 \/ 5 首/);
    const links=[fixtures[0],fixtures[4],fixtures[3],fixtures[5]].map(item=>item.playback_url).join('\n');
    await page.locator('#playlist-copy-links').click();
    assert.equal(await page.evaluate(()=>window.__copied),links);
    assert.match(await page.locator('#playlist-copy-status').textContent(),/已复制 4 个链接，跳过 1 个/);
    await page.evaluate(()=>window.__denyClipboard=true);await page.locator('#playlist-copy-links').click();
    assert.equal(await page.locator('#playlist-copy-text').inputValue(),links);
    assert.equal(await page.locator('#playlist-copy-text').isVisible(),true);
    assert.match(await page.locator('#playlist-copy-status').textContent(),/手动复制以下 4 个链接/);
    await page.evaluate(()=>window.__denyClipboard=false);
    pass('Copy includes all playable links in unsaved order, skips inaccessible clips, and supports a multiline fallback');
    await page.locator('#playlist-search-clear').click();
    assert.equal(await page.locator('#playlist-items li').count(),5);
    await page.locator('#playlist-search').fill('古典');
    assert.equal(await page.locator('#playlist-items li').count(),1);
    await page.locator('#playlist-search').press('Escape');
    assert.equal(await page.locator('#playlist-search').inputValue(),'');
    assert.equal(await page.locator('#playlist-dialog').isVisible(),true);
    await page.locator('#playlist-search').fill('不存在');
    assert.match(await page.locator('#playlist-items').textContent(),/没有匹配/);
    await page.locator('#playlist-save-button').click();await page.locator('#playlist-dialog').waitFor({state:'hidden'});
    saved=await(await fetch(base+'/api/playlists/'+savedId)).json();
    assert.deepEqual(saved.items.map(item=>item.id),[fixtures[0],fixtures[2],fixtures[4],fixtures[3],fixtures[5]].map(item=>item.id));
    pass('Saving a filtered queue keeps every song; filtered editor move/remove/save act on original order and preserve hidden songs');
    await page.locator('#playlist-edit').click();await page.locator('#playlist-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#playlist-search').inputValue(),'');
    assert.equal(await page.locator('#playlist-items li').count(),5);
    await page.locator('#playlist-dialog .close-dialog').first().click();
    await page.locator('#playlist-new').click();
    assert.match(await page.locator('#playlist-items').textContent(),/勾选歌曲/);
    assert.equal(await page.locator('#playlist-copy-links').isDisabled(),true);
    await page.locator('#playlist-search').fill('任意');
    assert.match(await page.locator('#playlist-item-count').textContent(),/^0 \/ 0 首/);
    await page.locator('#playlist-dialog .close-dialog').first().click();
    const previousPlays=plays.length;await page.locator('#play-all').click();await until(()=>plays.length>previousPlays);
    assert.equal(await page.locator('#player-queue-search').inputValue(),'');
    assert.equal(await page.locator('#player-queue button').count(),6);
    pass('Opening another playlist or starting another queue resets its search; search Enter never submits the editor and Escape clears without closing');
    await page.screenshot({path:path.join(output,'search-desktop.png'),fullPage:false});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('#player-queue-search').fill('月亮');
    await page.screenshot({path:path.join(output,'search-mobile.png'),fullPage:false});
    await page.locator('#playlist-edit').click();await page.locator('#playlist-search').fill('月亮');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.ok(await page.locator('#playlist-search').isVisible());
    await page.screenshot({path:path.join(output,'editor-mobile.png'),fullPage:false});
    assert.deepEqual(errors,[]);pass('Queue and editor search fit 390px mobile width without JavaScript errors');
    const editor = page.locator('#playlist-dialog'), nameInput = page.locator('#playlist-name');
    const originalName = await nameInput.inputValue();
    const unloadGuarded = () => page.evaluate(() => {
      const event = new Event('beforeunload', {cancelable:true});
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(await unloadGuarded(),false);
    await page.locator('#playlist-search-clear').click();
    await editor.locator('[data-item="0"][data-move="1"]').click();
    assert.equal(await unloadGuarded(),true);
    await editor.locator('[data-item="1"][data-move="-1"]').click();
    assert.equal(await unloadGuarded(),false);
    await nameInput.fill(originalName+'草稿');
    function respond(type, accept) {
      const seen = page.waitForEvent('dialog');
      page.once('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
      return seen.then(dialog => assert.equal(dialog.type(),type));
    }
    const close = editor.locator('.close-dialog');
    await Promise.all([respond('confirm',false),close.first().click()]);
    await Promise.all([respond('confirm',false),nameInput.press('Escape')]);
    await Promise.all([respond('beforeunload',false),page.evaluate(() => {setTimeout(()=>location.reload(),0);})]);
    assert.equal(await nameInput.inputValue(),originalName+'草稿');
    await Promise.all([respond('confirm',true),close.last().click()]);
    await editor.waitFor({state:'hidden'});
    assert.equal(await unloadGuarded(),false);
    assert.equal((await(await fetch(base+'/api/playlists/'+savedId)).json()).name,originalName);
    pass('Changed playlist name/order guards close and reload; search and undo-to-original stay clean, and explicit discard preserves the stored playlist');

    await page.locator('#playlist-edit').click();await editor.waitFor({state:'visible'});
    const target = '**/api/playlists/'+savedId;
    let releaseSave, announceSave;
    const hold = new Promise(resolve=>{releaseSave=resolve;});
    const submitted = new Promise(resolve=>{announceSave=resolve;});
    await page.route(target, async route=>{
      if(route.request().method()==='PATCH'){announceSave();await hold;}
      await route.continue();
    });
    try {
      await nameInput.fill('第一版');
      await page.locator('#playlist-save-button').click();await submitted;
      await nameInput.fill('第二版');
    } finally {releaseSave();}
    await page.waitForFunction(()=>!document.querySelector('#playlist-save-button').disabled);
    await page.unroute(target);
    assert.equal(await editor.isVisible(),true);
    assert.equal(await unloadGuarded(),true);
    assert.equal((await(await fetch(base+'/api/playlists/'+savedId)).json()).name,'第一版');
    await page.locator('#playlist-save-button').click();await editor.waitFor({state:'hidden'});
    assert.equal((await(await fetch(base+'/api/playlists/'+savedId)).json()).name,'第二版');
    assert.equal(await unloadGuarded(),false);
    pass('Edits made while saving remain open for a second save; both submissions retain the same playlist ID');
    await page.close();await until(()=>service.exitCode!==null);assert.equal(service.exitCode,0);
    fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({checks,errors,output},null,2));
  }finally{await browser.close();if(service.exitCode===null)spawnSync('taskkill',['/PID',String(service.pid),'/T','/F'],{stdio:'ignore'});}
})().catch(error=>{console.error(error);process.exitCode=1;});
