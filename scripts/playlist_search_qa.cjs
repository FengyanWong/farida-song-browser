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
    const fixtures=all.slice(0,6).map((clip,index)=>({...clip,display_song_title:['第一首','月亮 Café','第三首','第四首','月亮之上','<夜色> ＭＯＯＮ'][index],uploader_name:index===4?'阿见':'CLANNADOR',raw_title:index===3?'隐藏标题 古典 2026':index===0?'Fareeda 歌切':index===5?'法里達 歌切':'原始标题 '+index,raw_part_title:index===2?'独特分P名称':'分P '+index}));
    const fixtureById=new Map(fixtures.map(item=>[item.id,item]));
    let useFullQueue=false;
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==base)return route.abort();
      if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'歌单搜索测试'},message:''}});
      if(url.pathname==='/api/play-queue')return route.fulfill({json:{items:useFullQueue?all:fixtures}});
      if(/^\/api\/playlists\/\d+$/.test(url.pathname)&&route.request().method()==='GET'){
        const response=await route.fetch();if(!response.ok())return route.fulfill({response});
        const result=await response.json();
        result.items=result.items.map(item=>({...item,...fixtureById.get(item.id),playback_url:item.playback_url}));return route.fulfill({response,json:result});
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
    async function checkComposition(inputSelector, listSelector) {
      await page.locator(inputSelector).waitFor({state:'visible'});
      await page.locator(inputSelector).focus();
      const actual=await page.locator(inputSelector).evaluate((input,listSelector)=>{
        const list=document.querySelector(listSelector), first=list.firstElementChild;
        input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
        for(const value of ['f','fa','fali']){
          input.value=value;
          input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
        }
        const unchanged=list.firstElementChild===first;
        const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true,cancelable:true});
        input.dispatchEvent(enter);
        input.value='法里达';
        input.dispatchEvent(new CompositionEvent('compositionend',{data:'法里达',bubbles:true}));
        const committed=list.firstElementChild;
        input.dispatchEvent(new InputEvent('input',{bubbles:true}));
        return [unchanged,enter.defaultPrevented,list.children.length,list.firstElementChild===committed];
      },listSelector);
      assert.deepEqual(actual,[true,false,2,true]);
    }
    await checkComposition('#player-queue-search','#player-queue');
    for(const query of ['Ｆａｒｅｅｄａ','Farida','法里達']){
      await page.locator('#player-queue-search').fill(query);
      assert.deepEqual(await page.locator('#player-queue button').evaluateAll(rows=>rows.map(row=>row.dataset.queueIndex)),['0','5']);
    }
    await page.locator('#player-queue-search').fill('月亮');
    assert.equal(await page.locator('#player-queue button').count(),2);
    assert.equal(await page.locator('#player-queue-count').textContent(),'2 / 6 首');
    assert.deepEqual(await page.locator('#player-queue button').evaluateAll(rows=>rows.map(row=>row.dataset.queueIndex)),['1','4']);
    const focusedQueueIndex=()=>page.evaluate(()=>document.activeElement.dataset.queueIndex);
    await page.locator('#player-queue-clear').focus();await page.keyboard.press('Tab');
    assert.equal(await focusedQueueIndex(),'1');
    await page.keyboard.press('ArrowDown');assert.equal(await focusedQueueIndex(),'4');
    await page.keyboard.press('Home');assert.equal(await focusedQueueIndex(),'1');
    await page.keyboard.press('End');assert.equal(await focusedQueueIndex(),'4');
    await page.keyboard.press('ArrowUp');assert.equal(await focusedQueueIndex(),'1');
    assert.equal(plays.length,1);
    await page.keyboard.press('Enter');await until(()=>plays.at(-1)===fixtures[1].id);
    assert.equal(await page.locator('#player-queue [aria-current]').getAttribute('data-queue-index'),'1');
    pass('Arrow keys, Home and End browse filtered songs by original index; Enter alone starts the focused song');
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
    const archived=spawnSync(path.resolve('.venv/Scripts/python.exe'),['-c',
      'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE parts SET active=0 WHERE id=?",(sys.argv[2],)); db.commit(); db.close()',
      path.join(output,'数据','catalog.sqlite3'),fixtures[2].id],{encoding:'utf8',windowsHide:true});
    assert.equal(archived.status,0,archived.stderr);
    await page.locator('#playlist-edit').click();
    await checkComposition('#playlist-search','#playlist-items');
    pass('Chinese IME keeps both lists stable until confirmation and searches all performer spellings after one redraw');
    await page.locator('#playlist-search').fill('月亮');
    assert.equal(await page.locator('#playlist-items li').count(),2);
    assert.match(await page.locator('#playlist-item-count').textContent(),/^2 \/ 6 首/);
    await page.locator('#playlist-search').press('Enter');
    assert.equal(await page.locator('#playlist-dialog').isVisible(),true);
    await page.locator('#playlist-items [data-item="4"][data-move="-1"]').click();
    assert.equal(await page.locator('#playlist-items [data-item="3"][data-move="-1"]').count(),1);
    assert.equal(await page.evaluate(()=>document.activeElement.matches('[data-item="3"][data-move="-1"]')),true);
    await page.locator('#playlist-items [data-remove="1"]').click();
    assert.equal(await page.evaluate(()=>document.activeElement.matches('[data-remove="2"]')),true);
    assert.match(await page.locator('#playlist-item-count').textContent(),/^1 \/ 5 首/);
    const links=[fixtures[0],fixtures[4],fixtures[3],fixtures[5]].map(item=>item.playback_url).join('\n');
    await page.locator('#playlist-copy-links').click();
    await until(async()=>await page.evaluate(()=>window.__copied)===links);
    assert.match(await page.locator('#playlist-copy-status').textContent(),/已复制 4 个链接，跳过 1 个/);
    await page.evaluate(()=>window.__denyClipboard=true);await page.locator('#playlist-copy-links').click();
    await page.locator('#playlist-copy-text').waitFor();
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
    const target = url => url.pathname==='/api/playlists/'+savedId;
    let releaseSave, announceSave;
    const hold = new Promise(resolve=>{releaseSave=resolve;});
    const submitted = new Promise(resolve=>{announceSave=resolve;});
    await page.route(target, async route=>{
      if(route.request().method()==='PATCH'){
        assert.equal(new URL(route.request().url()).searchParams.get('summary'),'true');
        assert.deepEqual(route.request().postDataJSON(),{name:'第一版'});
        announceSave();await hold;
      }
      await route.continue();
    });
    try {
      await nameInput.fill('第一版');
      await page.locator('#playlist-save-button').click();await submitted;
      assert.equal(await page.locator('#playlist-add-results').isDisabled(),true);
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
    const second=await context.newPage();
    second.on('pageerror',error=>errors.push(error.message));
    try {
      await second.goto(base);await second.locator('#clip-rows tr').first().waitFor();
      const detail=async id=>(await(await fetch(base+'/api/playlists/'+id)).json());
      const openEditor=async(tab,id)=>{
        await tab.locator('#playlist-select').selectOption(String(id));
        await tab.locator('#playlist-edit').click();await tab.locator('#playlist-dialog').waitFor();
      };
      const saveEditor=async tab=>{
        await tab.locator('#playlist-save-button').click();
        await tab.locator('#playlist-dialog').waitFor({state:'hidden'});
      };
      const readIds=list=>list.items.map(item=>item.id);
      const before=await detail(savedId), draftOrder=readIds(before);
      [draftOrder[0],draftOrder[1]]=[draftOrder[1],draftOrder[0]];
      await openEditor(page,savedId);await openEditor(second,savedId);
      await nameInput.fill('我保留的草稿');await editor.locator('[data-item="0"][data-move="1"]').click();
      await second.locator('#playlist-name').fill('另一个页面已保存');await second.locator('#playlist-items [data-remove="0"]').click();
      await saveEditor(second);
      await page.locator('#playlist-save-button').click();await page.locator('#playlist-save-copy').waitFor();
      assert.match(await page.locator('#playlist-error').textContent(),/本页修改已保留/);
      assert.equal(await nameInput.inputValue(),'我保留的草稿');assert.equal(await unloadGuarded(),true);
      assert.deepEqual(readIds(await detail(savedId)),readIds(before).slice(1));
      assert.ok(await editor.evaluate(el=>el.scrollWidth<=el.clientWidth));
      await page.locator('#playlist-save-copy').click();await editor.waitFor({state:'hidden'});
      const copyId=await page.locator('#playlist-select').inputValue();assert.notEqual(copyId,savedId);
      const copy=await detail(copyId);assert.equal(copy.name,'我保留的草稿');assert.deepEqual(readIds(copy),draftOrder);
      assert.equal((await detail(savedId)).name,'另一个页面已保存');
      pass('Two editors preserve the first saved change; the second can explicitly save its full draft as a selected new playlist with its name and song order intact');

      await openEditor(page,savedId);await nameInput.fill('待放弃的草稿');await openEditor(second,savedId);
      await second.locator('#playlist-name').fill('载入这一版');await saveEditor(second);
      await Promise.all([respond('confirm',true),page.locator('#playlist-delete').click()]);
      await page.locator('#playlist-reload').waitFor();assert.equal((await detail(savedId)).name,'载入这一版');
      await Promise.all([respond('confirm',false),page.locator('#playlist-reload').click()]);
      assert.equal(await nameInput.inputValue(),'待放弃的草稿');
      await Promise.all([respond('confirm',true),page.locator('#playlist-reload').click()]);
      await until(async()=>await nameInput.inputValue()==='载入这一版');
      assert.equal(await unloadGuarded(),false);assert.equal(await page.locator('#playlist-save-copy').isVisible(),false);
      await nameInput.fill('载入后保存');await saveEditor(page);assert.equal((await detail(savedId)).name,'载入后保存');
      pass('A stale Delete preserves the stored playlist; reloading requires explicit confirmation and adopts the current revision for the next Save');

      await openEditor(page,savedId);await openEditor(second,savedId);await nameInput.fill('已删除原件的草稿');
      second.once('dialog',dialog=>dialog.accept());await second.locator('#playlist-delete').click();
      await second.locator('#playlist-dialog').waitFor({state:'hidden'});
      await page.locator('#playlist-save-button').click();await page.locator('#playlist-reload').click();
      await until(async()=>(await page.locator('#playlist-error').textContent()).includes('已被删除'));
      assert.equal(await page.locator('#playlist-reload').isVisible(),false);
      assert.equal(await nameInput.inputValue(),'已删除原件的草稿');await page.locator('#playlist-save-copy').click();
      await editor.waitFor({state:'hidden'});
      const recoveredId=await page.locator('#playlist-select').inputValue();
      assert.equal((await detail(recoveredId)).name,'已删除原件的草稿');

      let releaseDelete,announceDelete;
      const deleteHeld=new Promise(resolve=>{releaseDelete=resolve;}),deleteStarted=new Promise(resolve=>{announceDelete=resolve;});
      await openEditor(page,recoveredId);
      await page.route('**/api/playlists/'+recoveredId,async route=>{
        const result=await route.fetch();announceDelete();await deleteHeld;await route.fulfill({response:result});
      },{times:1});
      await Promise.all([respond('confirm',true),page.locator('#playlist-delete').click()]);await deleteStarted;
      await Promise.all([respond('confirm',true),close.last().click()]);
      await page.locator('#playlist-new').click();await nameInput.fill('新的编辑器');
      const lateDelete=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().endsWith('/'+recoveredId));
      releaseDelete();await (await lateDelete).finished();await page.evaluate(()=>new Promise(requestAnimationFrame));
      assert.equal(await nameInput.inputValue(),'新的编辑器');assert.equal(await editor.isVisible(),true);
      assert.equal(await page.locator('#playlist-save-copy').isVisible(),false);
      await Promise.all([respond('confirm',true),close.last().click()]);
      await until(async()=>await page.locator('#playlist-select option[value="'+recoveredId+'"]').count()===0);
      pass('A remotely deleted original can still be copied; a delayed Delete response leaves a newly opened draft intact');
    } finally {await second.close();}
    const resolver='**/api/playlists/resolve-links';
    let lookups=0;
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/playlists/resolve-links')lookups++;});
    const savedLists=async()=>(await(await fetch(base+'/api/playlists')).json()).items;
    const addFiltered=page.locator('#playlist-add-results'), saveButton=page.locator('#playlist-save-button');
    const queueURL='**/api/play-queue?*';
    async function holdResultLookup(){
      let release,announce;
      const hold=new Promise(r=>{release=r;}),started=new Promise(r=>{announce=r;});
      await page.route(queueURL,async route=>{announce();await hold;await route.fulfill({json:{items:fixtures}});},{times:1});
      await addFiltered.click();await started;
      return release;
    }
    const beforeFiltered=(await savedLists()).length;
    await page.locator('#playlist-new').click();await nameInput.fill('完整筛选歌单');
    const finish=await holdResultLookup();
    assert.equal(await saveButton.isDisabled(),true);assert.equal(await addFiltered.isDisabled(),true);
    assert.equal(await page.locator('#playlist-import-add').isDisabled(),true);
    await page.locator('#playlist-save').evaluate(form=>form.requestSubmit());
    assert.equal(await editor.isVisible(),true);assert.equal((await savedLists()).length,beforeFiltered);
    finish();await until(async()=>await saveButton.isEnabled());
    assert.equal(await editor.locator('[data-remove]').count(),fixtures.length);
    await saveButton.click();await editor.waitFor({state:'hidden'});
    const filteredId=await page.locator('#playlist-select').inputValue();
    const savedIds=async()=>(await(await fetch(base+'/api/playlists/'+filteredId)).json()).items.map(i=>i.id);
    assert.deepEqual(await savedIds(),fixtures.map(i=>i.id));

    await page.locator('#playlist-edit').click();await editor.locator('[data-remove="0"]').click();
    await page.route(queueURL,r=>r.fulfill({status:503,json:{detail:'筛选结果暂时无法读取'}}),{times:1});
    await addFiltered.click();await until(async()=>(await page.locator('#playlist-error').textContent()).includes('暂时无法读取'));
    assert.equal(await editor.locator('[data-remove]').count(),fixtures.length-1);
    assert.equal(await saveButton.isEnabled(),true);assert.equal(await addFiltered.isEnabled(),true);
    await addFiltered.click();await until(async()=>await editor.locator('[data-remove]').count()===fixtures.length);
    assert.equal(await page.locator('#playlist-error').textContent(),'');
    await saveButton.click();await editor.waitFor({state:'hidden'});
    assert.deepEqual(await savedIds(),[...fixtures.slice(1),fixtures[0]].map(i=>i.id));
    pass('Saving waits for filtered songs to arrive; a failed lookup preserves the draft and retry adds missing songs in order without duplicates');

    await page.locator('#playlist-new').click();await nameInput.fill('放弃等待中的结果');
    const stale=await holdResultLookup();
    await Promise.all([respond('confirm',true),close.last().click()]);
    await page.locator('#playlist-new').click();await nameInput.fill('保留新草稿');
    const delivered=page.waitForResponse(queueURL);stale();await (await delivered).finished();
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await nameInput.inputValue(),'保留新草稿');assert.equal(await editor.locator('[data-remove]').count(),0);
    assert.equal(await saveButton.isEnabled(),true);assert.equal(await addFiltered.isEnabled(),true);
    await Promise.all([respond('confirm',true),close.last().click()]);
    pass('Cancelling a filtered lookup leaves the next editor untouched when its delayed response arrives');
    const oldCount=(await savedLists()).length;
    const pasted=page.locator('#playlist-import-text'), importButton=page.locator('#playlist-import-add');
    const importStatus=page.locator('#playlist-import-status');
    const fillRepeated=(count,line)=>pasted.evaluate((el,{count,line})=>{
      el.value=Array(count).fill(line).join('\n');
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste'}));
    },{count,line});
    await page.locator('#playlist-new').click();await page.locator('#playlist-import summary').click();
    const copiedLinks=links.split('\n');
    await pasted.fill(copiedLinks[0]);await pasted.press('End');await pasted.press('Enter');
    assert.equal(await pasted.inputValue(),copiedLinks[0]+'\n');
    await nameInput.fill('粘贴未提交');await page.locator('#playlist-save-button').click();
    assert.equal(await editor.isVisible(),true);
    assert.match(await importStatus.textContent(),/请先点击/);
    assert.equal((await savedLists()).length,oldCount);

    await fillRepeated(20001,'BV0000000000');await importButton.click();
    assert.match(await importStatus.textContent(),/20,000/);
    await pasted.fill('x'.repeat(2049));await importButton.click();
    assert.match(await importStatus.textContent(),/2,048/);assert.equal(lookups,0);
    // Mark one unrelated video in the disposable catalog unavailable for this import.
    const usedVideos=new Set([fixtures[0],fixtures[4],fixtures[3],fixtures[5]].map(clip=>clip.id.split(':')[0]));
    const unavailable=all.find(clip=>!usedVideos.has(clip.id.split(':')[0]));
    const changed=spawnSync(path.resolve('.venv/Scripts/python.exe'),['-c',
      'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE videos SET availability_status=? WHERE bvid=?",(sys.argv[2],sys.argv[3])); db.commit(); db.close()',
      path.join(output,'数据','catalog.sqlite3'),'unavailable',unavailable.id.split(':')[0]],{encoding:'utf8',windowsHide:true});
    assert.equal(changed.status,0,changed.stderr);
    const mixed=[...copiedLinks,'',copiedLinks[0],'invalid-line','BV0000000000',unavailable.playback_url].join('\n');
    await pasted.fill(mixed);await importButton.click();
    await until(async()=>(await importStatus.textContent()).includes('已加入 4 首'));
    assert.match(await importStatus.textContent(),/重复输入 1 行，格式无效 1 行，本机未找到 1 行，不可播放 1 行/);
    assert.equal(await pasted.inputValue(),mixed);
    assert.equal(lookups,1);assert.equal((await savedLists()).length,oldCount);
    await page.evaluate(()=>window.__copied=null);await page.locator('#playlist-copy-links').click();
    await until(async()=>await page.evaluate(()=>window.__copied)===links);
    await pasted.fill(links);await importButton.click();
    await until(async()=>(await importStatus.textContent()).includes('已加入 0 首，歌单已有 4 首'));
    assert.equal(await pasted.inputValue(),'');assert.equal(await page.locator('#playlist-items li').count(),4);
    assert.equal(lookups,2);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await fillRepeated(20000,copiedLinks[0]);await importButton.click();
    await until(async()=>(await importStatus.textContent()).includes('歌单已有 1 首，重复输入 19999 行'));
    assert.equal(lookups,3);assert.equal(await pasted.inputValue(),'');
    await nameInput.fill('链接导入测试');await page.locator('#playlist-save-button').click();await editor.waitFor({state:'hidden'});
    const pastedId=await page.locator('#playlist-select').inputValue();
    const imported=await(await fetch(base+'/api/playlists/'+pastedId)).json();
    assert.deepEqual(imported.items.map(item=>item.id),[fixtures[0],fixtures[4],fixtures[3],fixtures[5]].map(item=>item.id));
    pass('Copied links round-trip in order through one local lookup per paste; unavailable, invalid, missing, duplicate and already-present lines are counted up to 20,000 lines; only Save writes a playlist');

    let releaseLookup, lookupStarted;
    const pendingLookup=new Promise(resolve=>{lookupStarted=resolve;});
    const blockLookup=new Promise(resolve=>{releaseLookup=resolve;});
    await page.route(resolver,async route=>{lookupStarted();await blockLookup;await route.continue();},{times:1});
    await page.locator('#playlist-new').click();await page.locator('#playlist-import summary').click();
    await pasted.fill(links);await importButton.click();await pendingLookup;
    assert.equal(await page.locator('#playlist-save-button').isDisabled(),true);
    await Promise.all([respond('confirm',true),close.last().click()]);
    await page.locator('#playlist-new').click();await page.locator('#playlist-import summary').click();
    await pasted.fill('新草稿');const lateResponse=page.waitForResponse(resolver);
    releaseLookup();await (await lateResponse).finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    assert.equal(await pasted.inputValue(),'新草稿');assert.equal(await importStatus.textContent(),'');
    assert.equal(await page.locator('#playlist-items [data-remove]').count(),0);
    assert.equal(await page.locator('#playlist-save-button').isDisabled(),false);
    await Promise.all([respond('confirm',true),close.last().click()]);
    pass('Closing during a lookup guards the draft; late results leave a newly opened editor untouched');
    useFullQueue=true;
    await page.locator('#play-all').click();await until(async()=>await page.locator('#player-queue button').count()===all.length);
    assert.ok(all.length>=1000);
    assert.equal(await page.locator('#player-queue button[tabindex="0"]').count(),1);
    await page.locator('#player-queue-search').focus();await page.keyboard.press('Tab');
    assert.equal(await focusedQueueIndex(),'0');
    await page.keyboard.press('End');assert.equal(await focusedQueueIndex(),String(all.length-1));
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.closest('.player-controls')!==null),true);
    await page.keyboard.press('Shift+Tab');assert.equal(await focusedQueueIndex(),String(all.length-1));
    await page.keyboard.press('Space');await until(()=>plays.at(-1)===all[all.length-1].id);
    assert.equal(await page.locator('#player-position').textContent(),all.length+' / '+all.length);
    await page.locator('#player-queue-search').fill('no-match-for-keyboard-test-1234');
    assert.equal(await page.locator('#player-queue button').count(),0);
    pass('The full '+all.length+'-song queue uses one tab stop, Shift+Tab returns to the browsed song, and Space plays it');
    await page.locator('#player-queue-search').fill('');
    const queue=page.locator('#player-queue'),draftRows=page.locator('#playlist-items');
    const queueElements=await queue.locator('*').count();
    assert.ok(queueElements>=5*all.length);
    await page.locator('#player-save').click();await editor.waitFor();
    const draftElements=await draftRows.locator('*').count();
    assert.ok(draftElements>queueElements);
    await close.last().click();await editor.waitFor({state:'hidden'});
    await until(async()=>await draftRows.locator('*').count()===0);
    await page.locator('#player-compact').click();
    assert.equal(await queue.locator('*').count(),0);
    await page.locator('#player-compact').click();
    assert.equal(await queue.locator('*').count(),queueElements);
    assert.equal(await queue.locator('[aria-current]').getAttribute('data-queue-index'),String(all.length-1));
    await page.locator('#player-close').click();assert.equal(await queue.locator('*').count(),0);
    await page.locator('#player-remembered').click();
    await until(async()=>await queue.locator('*').count()===queueElements);
    assert.equal(await queue.locator('[aria-current]').getAttribute('data-queue-index'),String(all.length-1));
    pass('Closing the editor releases '+draftElements+' song elements; compact or stopped playback releases '+queueElements+' and restores the current song on demand');
    await page.close();await until(()=>service.exitCode!==null);assert.equal(service.exitCode,0);
    fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({checks,errors,output},null,2));
  }finally{await browser.close();if(service.exitCode===null)spawnSync('taskkill',['/PID',String(service.pid),'/T','/F'],{stdio:'ignore'});}
})().catch(error=>{console.error(error);process.exitCode=1;});
