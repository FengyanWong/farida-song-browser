// Real mouse/touch playlist editing against a disposable local database.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(80);}throw Error('Playlist drag check timed out');}
(async()=>{
  const root=path.resolve('.local/playlist-drag-qa');fs.mkdirSync(root,{recursive:true});const output=fs.mkdtempSync(path.join(root,'run-'));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const base=`http://127.0.0.1:${port}`,exe=process.argv[3];
  const args=[...(exe?[]:['-X','utf8',path.resolve('run.py')]),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',path.join(output,'数据')];
  const service=spawn(path.resolve(exe||'.venv/Scripts/python.exe'),args,{cwd:path.resolve('.'),stdio:'ignore'});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000},hasTouch:true});
  const page=await context.newPage(),checks=[],errors=[];
  const pass=message=>{checks.push(message);console.log('Passed: '+message);};page.on('pageerror',error=>errors.push(error.message));
  try{
    await until(async()=>{assert.equal(service.exitCode,null);try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
    const all=(await(await fetch(base+'/api/play-queue')).json()).items.filter(item=>item.playback_url).slice(0,1000);assert.equal(all.length,1000);
    const fixtures=all.map((clip,index)=>({...clip,display_song_title:([0,3,5].includes(index)?'筛选 ':'歌曲 ')+index,uploader_name:'测试 UP',raw_title:'原标题 '+index,raw_part_title:'分P '+index}));
    const fixtureById=new Map(fixtures.map(item=>[item.id,item]));
    const token=(await(await fetch(base+'/api/session')).json()).token;
    const playlist=await(await fetch(base+'/api/playlists',{method:'POST',headers:{'Content-Type':'application/json','X-Farida-Token':token},body:JSON.stringify({name:'拖动歌单',clip_ids:all.map(item=>item.id)})})).json();
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
      if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'拖动测试'},message:''}});
      if(/^\/api\/playlists\/\d+$/.test(url.pathname)&&route.request().method()==='GET'){
        const response=await route.fetch(),result=await response.json();result.items=result.items.map(item=>({...item,...fixtureById.get(item.id)}));return route.fulfill({response,json:result});
      }
      return route.continue();
    });
    await page.goto(base);await page.locator('#clip-rows tr').first().waitFor();
    await page.locator('#playlist-select').selectOption(String(playlist.id));
    async function open(){await page.locator('#playlist-edit').click();await page.locator('#playlist-dialog').waitFor({state:'visible'});}
    async function ids(){return(await(await fetch(base+'/api/playlists/'+playlist.id)).json()).items.map(item=>item.id);}
    async function save(){await page.locator('#playlist-save-button').click();await page.locator('#playlist-dialog').waitFor({state:'hidden'});}
    async function point(index){const box=await page.locator(`#playlist-items [data-drag-index="${index}"]`).boundingBox();assert.ok(box);return {x:box.x+box.width/2,y:box.y+box.height/2};}
    async function move(from,to,after=true,release=true){
      const start=await point(from),target=await page.locator(`#playlist-items [data-drag-index="${to}"]`).locator('..').boundingBox();
      await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+8,start.y+8,{steps:3});
      await page.locator('.playlist-drag-preview').waitFor({state:'visible'});
      await page.mouse.move(start.x,target.y+target.height*(after?.8:.2),{steps:7});if(release)await page.mouse.up();
    }
    const expected=all.map(item=>item.id);function reorder(from,to){expected.splice(to,0,expected.splice(from,1)[0]);}
    await open();
    const firstHandle=await point(0),listBounds=await page.locator('#playlist-items').boundingBox();
    await page.evaluate(()=>{
      const list=document.querySelector('#playlist-items'),original=Element.prototype.getBoundingClientRect;
      window.__dragRowReads=0;
      Element.prototype.getBoundingClientRect=function(){
        if(this.parentElement===list)window.__dragRowReads++;
        return original.call(this);
      };
      window.__restoreRect=()=>{Element.prototype.getBoundingClientRect=original;};
    });
    await page.mouse.move(firstHandle.x,firstHandle.y);await page.mouse.down();
    await page.mouse.move(firstHandle.x,listBounds.y+listBounds.height/2,{steps:6});
    await page.locator('.playlist-drag-preview').waitFor({state:'visible'});
    const rowReads=await page.evaluate(async()=>{
      const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
      await frame();await frame();
      const moving=window.__dragRowReads;
      for(let i=0;i<8;i++)await frame();
      return {moving,stationary:window.__dragRowReads-moving};
    });
    console.log('Row geometry reads with 1,000 songs:',rowReads);
    assert.ok(rowReads.moving<40,'Dragging must not measure all playlist rows');
    assert.equal(rowReads.stationary,0,'A stationary drag away from the edge should be idle');
    await page.keyboard.press('Escape');await page.mouse.up();await page.evaluate(()=>window.__restoreRect());
    pass('A 1,000-song drag measures only nearby rows and stays idle while held still');
    await move(0,2);reorder(0,2);await save();assert.deepEqual(await ids(),expected);
    await page.reload();await page.locator('#clip-rows tr').first().waitFor();await page.locator('#playlist-select').selectOption(String(playlist.id));await open();
    assert.match(await page.locator('#playlist-items li').nth(2).textContent(),/筛选 0/);
    pass('Mouse dragging changes playlist order and persists through save and reload');

    await page.locator('#playlist-search').fill('筛选');assert.equal(await page.locator('#playlist-items li').count(),3);
    await move(2,5);reorder(2,5);await save();assert.deepEqual(await ids(),expected);
    assert.deepEqual(expected.filter(id=>![all[0].id,all[3].id,all[5].id].includes(id)),all.filter((_,i)=>![0,3,5].includes(i)).map(item=>item.id));
    pass('Dragging filtered rows uses full playlist positions and preserves every hidden song in relative order');

    await open();await page.locator('#playlist-search').fill('筛选');
    await page.locator('#playlist-items [data-drag-index="5"]').focus();await page.keyboard.press('ArrowUp');reorder(5,4);
    await page.locator('#playlist-items [data-item="4"][data-move="1"]').click();reorder(4,5);
    await save();assert.deepEqual(await ids(),expected);pass('Handle keyboard arrows and existing move buttons both reorder the full playlist while filtered');

    await open();await page.locator('#playlist-search').fill('筛选');
    await page.evaluate(()=>window.addEventListener('pointerdown',event=>window.__qaPointer=event.pointerId,{capture:true}));
    await move(2,5,true,false);await page.keyboard.press('Escape');await page.mouse.up();
    assert.equal(await page.locator('#playlist-dialog').isVisible(),true);assert.equal(await page.locator('.playlist-drag-preview').count(),0);
    await move(2,5,true,false);await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.__qaPointer})));await page.mouse.up();
    assert.equal(await page.locator('.playlist-drag-preview').count(),0);
    await move(2,5,true,false);await page.locator('#playlist-search').fill('歌曲');await page.mouse.up();assert.equal(await page.locator('.playlist-drag-preview').count(),0);
    await save();assert.deepEqual(await ids(),expected);pass('Escape, pointer cancellation, and search rerender cancel dragging without changing song order');

    await open();const start=await point(0),bounds=await page.locator('#playlist-items').boundingBox();
    await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x,bounds.y+bounds.height-5,{steps:8});
    await until(async()=>await page.locator('#playlist-items').evaluate(list=>list.scrollTop)>80);
    await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.locator('.playlist-drag-preview').count(),0);
    await page.locator('#playlist-items').evaluate(list=>list.scrollTop=0);
    await move(0,2,true,false);await page.evaluate(()=>document.querySelector('#playlist-dialog').close());await page.mouse.up();
    await page.locator('.playlist-drag-preview').waitFor({state:'detached'});assert.deepEqual(await ids(),expected);
    pass('Dragging near the list edge scrolls; closing the editor cancels safely and cleans the preview');

    await page.setViewportSize({width:390,height:844});await open();
    const source=await point(0),target=await page.locator('#playlist-items [data-drag-index="2"]').locator('..').boundingBox();
    const cdp=await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:source.x,y:source.y}]});
    for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:source.x,y:source.y+(target.y+target.height*.8-source.y)*i/8}]});
    await page.locator('.playlist-drag-preview').waitFor({state:'visible'});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();reorder(0,2);
    await page.screenshot({path:path.join(output,'playlist-drag-mobile.png'),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await save();assert.deepEqual(await ids(),expected);
    assert.deepEqual(errors,[]);pass('Touch dragging works at 390px without scrolling the page, losing songs, or JavaScript errors');
    await page.close();await until(()=>service.exitCode!==null);assert.equal(service.exitCode,0);
    const result={checks,errors,output,packaged:!!exe};fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{await browser.close();if(service.exitCode===null)spawnSync('taskkill',['/PID',String(service.pid),'/T','/F'],{stdio:'ignore'});}
})().catch(error=>{console.error(error);process.exitCode=1;});
