// Grouped catalog, listening history, and manual backup browser regression checks.
// Generates synthetic metadata in a disposable database; no real profile or upstream traffic.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(100);}throw Error('Catalog groups/history check timed out');}
const python=path.resolve('.venv/Scripts/python.exe');
const seed=`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
from farida.db import Database
db=Database(Path(sys.argv[1])/'catalog.sqlite3')
db.initialize()
sources=db.sources()[:2]
ids=[]
for index in range(94):
    source=sources[index%2]
    title='同一首歌' if index<50 else '独立歌曲 %02d'%(index-49)
    video={'bvid':'BV%010d'%(index+1),'aid':index+1,'title':'法里达 直播翻唱 '+title,
      'desc':'浏览器测试使用的合成元数据','pubdate':(1800000000 if index<50 else 1700000000)+index,
      'duration':180,'pic':'','owner':{'mid':int(source['uid']),'name':source['display_name']},
      'stat':{'view':0},'pages':[{'cid':1000+index,'page':1,'part':title,'duration':180}]}
    db.save_video(source,video,['法里达','直播切片'])
    clip=video['bvid']+':'+str(1000+index)
    db.annotate([clip],{'display_song_title':title,'inclusion_status':'included'})
    if index>=92:db.annotate([clip],{'song_group':'手工分组'})
    ids.append(clip)
print(json.dumps({'ids':ids,'source_ids':[source['id'] for source in sources]},ensure_ascii=False))
`;
(async()=>{
  const root=path.resolve('.local/catalog-groups-history-qa');fs.mkdirSync(root,{recursive:true});
  const output=fs.mkdtempSync(path.join(root,'run-')),dataDir=path.join(output,'数据');
  const seeded=spawnSync(python,['-X','utf8','-c',seed,dataDir],{cwd:path.resolve('.'),encoding:'utf8',windowsHide:true});
  assert.equal(seeded.status,0,seeded.stderr);const fixture=JSON.parse(seeded.stdout);
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const base=`http://127.0.0.1:${port}`,exe=process.argv[3];
  const args=[...(exe?[]:['-X','utf8',path.resolve('run.py')]),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',dataDir];
  const service=spawn(path.resolve(exe||'.venv/Scripts/python.exe'),args,{cwd:path.resolve('.'),stdio:'ignore',windowsHide:true});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({locale:'zh-CN',timezoneId:'UTC',viewport:{width:1440,height:1000}});
  const page=await context.newPage(),checks=[],errors=[],plays=[],dialogs=[],blocked=[];
  const pass=message=>{checks.push(message);console.log('Passed: '+message);};
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.accept();});
  try{
    await page.goto('about:blank');
    const encoded=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
      const drawing=canvas.getContext('2d'),stream=canvas.captureStream(12),chunks=[];
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
      recorder.ondataavailable=event=>chunks.push(event.data);
      const ended=new Promise(resolve=>recorder.onstop=resolve);recorder.start();let frame=0;
      const timer=setInterval(()=>{drawing.fillStyle='#17283d';drawing.fillRect(0,0,160,90);drawing.fillStyle='#a9cdf7';drawing.fillRect(frame++%120,30,30,30);},80);
      await new Promise(resolve=>setTimeout(resolve,1600));clearInterval(timer);recorder.stop();await ended;
      stream.getTracks().forEach(track=>track.stop());
      return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}));});
    });
    const media=Buffer.from(encoded,'base64');assert.ok(media.length>500);
    await until(async()=>{assert.equal(service.exitCode,null);try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
    const token=(await(await fetch(base+'/api/session')).json()).token;
    async function api(endpoint,method='GET',body){
      const response=await fetch(base+endpoint,{method,headers:{'X-Farida-Token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      assert.ok(response.ok,`${method} ${endpoint}: ${response.status} ${await response.clone().text()}`);
      return response.json();
    }
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==base){blocked.push(url.origin);return route.abort();}
      if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'分组与历史测试'},message:''}});
      if(url.pathname.startsWith('/api/sync'))return route.fulfill({status:409,json:{detail:'QA prevents upstream collection'}});
      if(/^\/api\/clips\/[^/]+\/play$/.test(url.pathname)){
        plays.push(decodeURIComponent(url.pathname.split('/')[3]));
        return route.fulfill({json:{quality:64,segments:[{url:'/api/playback/media/catalog-test-'+plays.length}]}});
      }
      if(url.pathname.startsWith('/api/playback/media/'))return route.fulfill({body:media,contentType:'video/webm',headers:{'Accept-Ranges':'bytes'}});
      return route.continue();
    });
    // Keep clipboard writes inside this disposable test page.
    await context.addInitScript(()=>{
      Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedUrl=text;}}});
    });
    let recoveryChecks=0;
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.pathname==='/api/backup/recovery' && url.searchParams.has('check')) recoveryChecks++;
    });
    await page.goto(base+'/#catalog');await page.locator('#clip-rows tr').first().waitFor();
    assert.equal(await page.locator('nav [data-view]').count(),2);
    const queries=[];
    page.on('request',req=>{
      const target=new URL(req.url());
      if(target.pathname==='/api/clips')queries.push(target.searchParams.get('q'));
    });
    const search=page.locator('#search');
    await search.evaluate(el=>{
      el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      el.value='ton';
      el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
    });
    await delay(400);
    assert.ok(!queries.includes('ton'));
    await search.evaluate(el=>{
      el.value='同一首歌';
      el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:el.value}));
      el.dispatchEvent(new InputEvent('input',{bubbles:true}));
    });
    await until(()=>queries.includes('同一首歌'));
    assert.equal(queries.filter(q=>q==='同一首歌').length,1);
    pass('Chinese input composition issues a single search for the confirmed text');
    const wanted=fixture.ids[0],bvid=wanted.split(':')[0];
    const longLink='【分享歌曲】 https://m.bilibili.com/video/'+bvid+'/?tracking='+'x'.repeat(600)+'&p=2';
    await search.focus();await search.press('Control+a');await page.keyboard.insertText(longLink);
    await until(()=>queries.includes(longLink));
    // This fixture has only P1, so losing the P2 suffix would show the wrong recording.
    await until(async()=>await page.locator('#clip-rows [data-play]').count()===0);
    assert.equal(await search.inputValue(),longLink);
    const overlong=longLink.replace('tracking=', 'tracking='+'x'.repeat(2048));
    await search.press('Control+a');await page.keyboard.insertText(overlong);
    await until(async()=>(await page.locator('#notice').textContent()).includes('2,048'));
    assert.equal(await search.inputValue(),overlong);
    assert.equal(queries.includes(overlong),false);
    pass('Long Bilibili share text retains its P2 suffix and overlength input stays editable with a clear error');
    const canonical='https://www.bilibili.com/video/'+bvid+'/?p=1';
    await page.locator('#search').fill(canonical+'&share_source=copy');
    await until(async()=>{
      const ids=await page.locator('#clip-rows [data-play]').evaluateAll(nodes=>nodes.map(node=>node.dataset.play));
      return ids.length===1 && ids[0]===wanted;
    });
    await page.locator('#clip-rows [data-detail]').click();
    await page.locator('[data-copy-url]').click();
    assert.equal(await page.evaluate(()=>window.copiedUrl),canonical);
    await page.locator('#detail-dialog .close-dialog').click();
    await page.locator('#search').fill('');
    await until(async()=>await page.locator('#clip-rows [data-play]').count()===40);
    pass('Pasting a shared Bilibili link selects the saved clip and Copy Link returns its clean original URL');
    const sortBy=async (column,sort,direction)=>{
      const heading=page.locator('th').filter({has:page.locator('button[data-first="'+column+'"]')});
      const control=heading.getByRole('button');
      await control.focus();await control.press('Enter');
      await until(async()=>await heading.getAttribute('aria-sort')===direction);
      assert.equal(await page.locator('#sort').inputValue(),sort);
      assert.equal(await page.locator('th[aria-sort]').count(),1);
      assert.equal(await control.evaluate(el=>document.activeElement===el),true);
      const rows=(await api('/api/clips?compact=true&sort='+sort)).items.map(row=>row.id);
      assert.deepEqual(await page.locator('#clip-rows [data-select]').evaluateAll(nodes=>nodes.map(node=>node.dataset.select)),rows);
    };
    await sortBy('newest','oldest','ascending');
    await sortBy('title','title','ascending');
    await sortBy('title','title_desc','descending');
    await sortBy('uploader','uploader','ascending');
    await sortBy('uploader','uploader_desc','descending');
    await page.locator('#filter-button').click();
    await page.locator('#sort').selectOption('discovered');
    await until(async()=>await page.locator('th[aria-sort]').count()===0);
    await page.locator('#filter-button').click();
    await sortBy('newest','newest','descending');
    pass('Column headings sort by title, uploader and date, keep keyboard focus, and show the same order as the advanced filter');

    await page.locator('#page-number').click();
    const pageTarget=page.locator('#page-target');
    assert.equal(await pageTarget.inputValue(),'1');
    await pageTarget.fill('4');
    await pageTarget.press('Enter');
    assert.equal(await pageTarget.evaluate(el=>el.validity.rangeOverflow),true);
    await pageTarget.press('Escape');
    assert.equal(await page.locator('#page-number').evaluate(el=>el===document.activeElement),true);
    await page.locator('#page-number').click();
    await pageTarget.fill('3');
    await pageTarget.press('Enter');
    await until(async()=>await page.locator('#page-number').textContent()==='3 / 3');
    assert.equal(await page.locator('#clip-rows [data-select]').first().evaluate(el=>el===document.activeElement),true);
    await page.locator('#clip-rows [data-select]').first().check();
    const firstDocument=await page.evaluate(()=>performance.timeOrigin);
    const initialLength=await page.evaluate(()=>history.length);
    await page.locator('[data-view=sources]').click();
    await page.locator('[data-view=sources]').click();
    assert.equal(await page.evaluate(()=>history.length),initialLength+1);
    await page.goBack();await page.locator('#catalog-view').waitFor({state:'visible'});
    assert.equal(await page.locator('#page-number').textContent(),'3 / 3');
    assert.equal(await page.locator('#clip-rows [data-select]').first().isChecked(),true);
    await page.goForward();await page.locator('#sources-view').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>performance.timeOrigin),firstDocument);
    pass('Browser Back and Forward switch between the two app tabs, preserving page and selection without restarting the app');
    await page.locator('[data-view=catalog]').click();
    await until(async()=>await page.locator('#page-number').textContent()==='3 / 3');
    assert.equal(await page.locator('#clip-rows [data-select]').first().isChecked(),true);
    await page.locator('#clear-selection').click();
    await page.locator('#page-number').click();await pageTarget.fill('1');
    await page.locator('#page-jump [type=submit]').click();
    await until(async()=>await page.locator('#page-number').textContent()==='1 / 3');
    pass('Direct page jump validates the number, supports keyboard or touch, and keeps the current page and selection across Sources');
    const catalogPattern='**/api/clips?**';
    const onPage=number=>until(async()=>await page.locator('#page-number').textContent()===number+' / 3');
    // Hold exactly one request while allowing subsequent navigation to finish.
    async function holdCatalogResponse(matches) {
      let signal, release;
      const started=new Promise(resolve=>{signal=resolve;});
      const held=new Promise(resolve=>{release=resolve;});
      let captured=false;
      const handler=async route=>{
        const params=new URL(route.request().url()).searchParams;
        if (!captured && matches(params)) {captured=true;signal();await held;}
        await route.continue();
      };
      await page.route(catalogPattern,handler);
      return {started, async finish(){
        const response=page.waitForResponse(res=>{
          const url=new URL(res.url());
          return url.pathname==='/api/clips' && matches(url.searchParams);
        });
        release();await (await response).finished();await page.unroute(catalogPattern,handler);
      }};
    }
    await page.route(catalogPattern,route=>route.fulfill({status:503,json:{detail:'分页读取失败测试'}}),{times:1});
    await page.locator('#next-page').click();await until(async()=>await page.locator('#notice').textContent()==='分页读取失败测试');
    await onPage(1);await page.locator('#next-page').click();await onPage(2);
    assert.ok(await page.locator('#notice').isHidden());
    await page.locator('#prev-page').click();await onPage(1);
    const delayedPage=await holdCatalogResponse(params=>params.get('page')==='2');
    await page.locator('#next-page').click();await delayedPage.started;
    await page.locator('#next-page').click();await onPage(3);
    const page3First=await page.locator('[data-select]').first().getAttribute('data-select');
    await delayedPage.finish();await onPage(3);
    assert.equal(await page.locator('[data-select]').first().getAttribute('data-select'),page3First);
    pass('Retrying a failed Next loads the missing page; two rapid clicks still reach page three when page two arrives last');

    const delayedFilter=await holdCatalogResponse(params=>params.get('bookmarked')==='true');
    await page.locator('#clip-filter').selectOption('bookmarked');await delayedFilter.started;
    const oldBox=page.locator('[data-select]').first();
    await oldBox.scrollIntoViewIfNeeded();
    const rect=await oldBox.boundingBox();
    await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);
    assert.equal(await oldBox.isChecked(),false);
    await delayedFilter.finish();await until(async()=>await page.locator('#clip-rows tr').count()===0);
    assert.equal(await page.locator('#bulk-bar').isVisible(),false);
    await page.locator('#clip-filter').selectOption('included');await onPage(1);
    await page.locator('[data-view=sources]').click();
    const sameFilter=await holdCatalogResponse(params=>params.get('page')==='1');
    await page.locator('[data-view=catalog]').click();await sameFilter.started;
    await page.locator('[data-select]').first().check();await sameFilter.finish();
    assert.equal(await page.locator('[data-select]').first().isChecked(),true);
    await page.locator('#clear-selection').click();
    pass('Pending filters reject clicks on obsolete rows; refreshing the same filter preserves the ability to select songs');

    // Pick in reverse page order. Playback and the saved playlist follow catalog order.
    await page.locator('#next-page').click();
    await until(async()=>await page.locator('#page-number').textContent()==='2 / 3');
    const pageTwoBox=page.locator('#clip-rows [data-select]').first();
    const secondId=await pageTwoBox.getAttribute('data-select');
    await pageTwoBox.check();
    await page.locator('#prev-page').click();
    await until(async()=>await page.locator('#page-number').textContent()==='1 / 3');
    assert.match(await page.locator('#selected-count').textContent(),/1 项（本页 0 项）/);
    await page.locator('#select-page').check();
    assert.match(await page.locator('#selected-count').textContent(),/41 项（本页 40 项）/);
    await page.locator('#select-page').uncheck();
    const pageOneBox=page.locator('#clip-rows [data-select]').nth(1);
    const firstId=await pageOneBox.getAttribute('data-select');
    await pageOneBox.check();
    await page.locator('#playlist-add-selected').click();
    await page.locator('#playlist-name').fill('跨页选歌');
    await page.locator('#playlist-save-button').click();
    await page.locator('#playlist-dialog').waitFor({state:'hidden'});
    const multiId=await page.locator('#playlist-select').inputValue();
    assert.deepEqual((await api('/api/playlists/'+multiId)).items.map(item=>item.id),[firstId,secondId]);
    await page.locator('#playlist-select').selectOption('');
    await page.locator('#next-page').click();
    await until(async()=>await page.locator('#page-number').textContent()==='2 / 3');
    assert.equal(await pageTwoBox.isChecked(),true);
    const bulkRequest=page.waitForRequest(req=>new URL(req.url()).pathname==='/api/review/bulk' && req.method()==='PATCH');
    await page.locator('[data-bulk=included]').click();
    assert.deepEqual((await bulkRequest).postDataJSON().ids.sort(),[firstId,secondId].sort());
    await page.locator('#bulk-bar').waitFor({state:'hidden'});
    await pageTwoBox.check();
    await page.locator('#group-songs').check();await until(async()=>await page.locator('.song-group-row').count()===40);
    assert.equal(await page.locator('#bulk-bar').isVisible(),false);
    pass('Across pages, selecting and deselecting the current page preserves other choices, orders the saved playlist, and applies bulk review to the chosen clips');
    const first=await api('/api/clips?grouped=true&page=1&page_size=40');
    const second=await api('/api/clips?grouped=true&page=2&page_size=40');
    assert.equal(first.total,44);assert.equal(first.total_clips,94);assert.equal(first.groups[0].count,50);
    const allIds=[...first.items,...second.items].map(item=>item.id);
    assert.equal(allIds.length,94);assert.equal(new Set(allIds).size,94);
    assert.match(await page.locator('[data-group="0"]').textContent(),/同一首歌.*50 个版本/s);
    assert.equal(await page.locator('#clip-rows [data-select]').count(),0);
    assert.match(await page.locator('#clip-rows').textContent(),/手工分组.*2 个版本/s);
    await page.locator('#next-page').click();await until(async()=>await page.locator('#page-number').textContent()==='2 / 2');
    assert.equal(await page.locator('.song-group-row').count(),4);
    await page.locator('#prev-page').click();await until(async()=>await page.locator('#page-number').textContent()==='1 / 2');
    pass('Grouping paginates complete groups: all 50 recordings stay together, all 94 clips appear once, and explicit song groups combine differently named recordings');

    await page.locator('[data-select-group="0"]').check();
    assert.match(await page.locator('#selected-count').textContent(),/50/);
    await page.locator('#playlist-add-selected').click();assert.equal(await page.locator('#playlist-items li').count(),50);
    await page.locator('#playlist-name').fill('隐藏版本完整歌单');await page.locator('#playlist-save-button').click();
    await page.locator('#playlist-dialog').waitFor({state:'hidden'});
    const playlistId=await page.locator('#playlist-select').inputValue();
    const saved=await api('/api/playlists/'+playlistId);
    assert.deepEqual(saved.items.map(item=>item.id),first.groups[0].clip_ids);
    await page.locator('[data-group="0"]').click();assert.equal(await page.locator('#clip-rows [data-select]').count(),50);
    await page.locator('#clip-rows [data-select]').first().uncheck();
    assert.equal(await page.locator('[data-select-group="0"]').evaluate(input=>input.indeterminate),true);
    assert.match(await page.locator('#selected-count').textContent(),/49/);
    await page.locator('[data-group="0"]').click();assert.equal(await page.locator('#clip-rows [data-select]').count(),0);
    await page.locator('#clear-selection').click();
    await page.evaluate(()=>document.querySelector('#song-video').addEventListener('playing',event=>event.target.pause(),{once:true}));
    await page.locator('[data-play-group="0"]').click();await until(()=>plays.length===1);
    await until(async()=>await page.locator('#player-queue [data-queue-index]').count()===50);
    assert.equal(plays[0],first.groups[0].clip_ids[0]);
    await until(async()=>(await api('/api/listening-history')).items.length===1);
    assert.equal(await page.locator('#player-position').textContent(),'1 / 50');
    const beforeInvalidRestore = await page.locator('#song-video').getAttribute('src');
    const rejected=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/restore');
    await page.locator('#backup-file').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    assert.equal((await rejected).status(),400);
    await until(async()=>await page.locator('#backup-restore').isEnabled());
    assert.equal(await page.locator('#music-player').isVisible(),true);
    assert.equal(await page.locator('#song-video').getAttribute('src'),beforeInvalidRestore);
    assert.equal(await page.locator('#player-position').textContent(),'1 / 50');
    pass('A rejected backup preserves the current player, video, and queue position');
    await page.locator('#player-close').click();
    pass('Collapsed group selection includes hidden recordings; indeterminate selection stays correct; saved playlist and group playback use all 50 real queue IDs');

    await page.locator('#search').fill('同一首歌');await until(async()=>await page.locator('.song-group-row').count()===1);
    await page.locator('#source-filter').selectOption(String(fixture.source_ids[0]));
    await until(async()=>(await page.locator('[data-group="0"]').textContent()).includes('25 个版本'));
    assert.match(await page.locator('#result-count').textContent(),/1 首歌 · 25 个版本/);
    await page.locator('[data-group="0"]').click();
    const filtered=await api('/api/clips?grouped=true&q='+encodeURIComponent('同一首歌')+'&source_id='+fixture.source_ids[0]);
    assert.deepEqual(await page.locator('#clip-rows [data-select]').evaluateAll(inputs=>inputs.map(input=>input.dataset.select)),filtered.groups[0].clip_ids);
    await page.locator('#source-filter').selectOption('');
    await until(async()=>(await page.locator('[data-group="0"]').textContent()).includes('50 个版本'));
    await page.locator('#search').fill('');await until(async()=>await page.locator('.song-group-row').count()===40);
    if(await page.locator('#clip-rows [data-select]').count())await page.locator('[data-group="0"]').click();
    pass('Search and source filters operate before grouping and display only the complete matching set of recordings');

    await api('/api/listening-history','DELETE');
    const historyIds=[fixture.ids[0],fixture.ids[51],fixture.ids[2]];
    for(const id of historyIds)await api('/api/listening-history','POST',{clip_id:id});
    const alter=spawnSync(python,['-X','utf8','-c',"import sqlite3,sys; con=sqlite3.connect(sys.argv[1]); con.execute(\"UPDATE videos SET availability_status='unavailable' WHERE bvid=?\",(sys.argv[2],)); con.commit(); con.close()",path.join(dataDir,'catalog.sqlite3'),historyIds[1].split(':')[0]],{encoding:'utf8',windowsHide:true});
    assert.equal(alter.status,0,alter.stderr);
    await page.locator('#listening-history-open').click();await until(async()=>await page.locator('.history-play').count()===3);
    let history=await api('/api/listening-history');assert.deepEqual(history.items.map(item=>item.id),[...historyIds].reverse());
    assert.equal(await page.locator('.history-play:disabled').count(),1);
    assert.match(await page.locator('.history-play:disabled').textContent(),/当前不可用/);
    await page.screenshot({path:path.join(output,'history-desktop.png'),fullPage:false});
    await page.locator('#listening-history-dialog .close-dialog').first().click();
    assert.equal(recoveryChecks,0);
    const emptyRecovery=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/backup/recovery');
    await page.locator('#account-toggle').click();
    assert.deepEqual(await(await emptyRecovery).json(),{available:false});
    assert.equal(await page.locator('#backup-recovery').isHidden(),true);
    const downloadPromise=page.waitForEvent('download');await page.locator('#backup-download').click();
    const download=await downloadPromise;assert.match(download.suggestedFilename(),/^farida-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const backupFile=path.join(output,'manual-history-backup.json');await download.saveAs(backupFile);
    const snapshot=JSON.parse(fs.readFileSync(backupFile,'utf8'));
    assert.equal(snapshot.version,2);assert.equal(snapshot.tables.listening_history.length,3);
    await page.locator('#account-toggle').click();
    const beforeOverview=await api('/api/overview'),beforePlaylist=await api('/api/playlists/'+playlistId);
    await page.locator('#listening-history-open').click();await page.locator('#listening-history-clear').click();
    await page.locator('#listening-history-empty').waitFor({state:'visible'});
    assert.equal((await api('/api/listening-history')).items.length,0);
    assert.equal((await api('/api/overview')).entries,beforeOverview.entries);
    assert.deepEqual((await api('/api/playlists/'+playlistId)).items,beforePlaylist.items);
    assert.equal(await page.locator('#listening-history-clear').isDisabled(),true);
    await page.locator('#listening-history-dialog .close-dialog').first().click();
    pass('Recent history uses actual POST/GET/DELETE APIs, orders unique songs, disables unavailable recordings, and clearing preserves catalog and playlists');

    async function restoreFromUI(data,name){
      const loaded=page.waitForEvent('load');
      await page.locator('#backup-file').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
      await loaded;await page.locator('.song-group-row').first().waitFor();
      assert.equal(await page.locator('#group-songs').isChecked(),true);
    }
    await restoreFromUI(snapshot,'history-v2.json');
    assert.equal((await api('/api/listening-history')).items.length,3);
    assert.equal((await api('/api/playlists/'+playlistId)).items.length,50);
    const legacy=structuredClone(snapshot);legacy.version=1;delete legacy.tables.listening_history;
    await restoreFromUI(legacy,'legacy-v1.json');
    assert.equal((await api('/api/listening-history')).items.length,0);
    assert.equal((await api('/api/overview')).entries,94);
    assert.equal((await api('/api/playlists/'+playlistId)).items.length,50);
    assert.equal(dialogs.filter(text=>text.startsWith('恢复完成')).length,2);
    const recoveryFiles=fs.readdirSync(path.join(dataDir,'backups')).filter(name=>name.startsWith('before-restore-'));
    assert.equal(recoveryFiles.length,2);
    const recoveryHistory=recoveryFiles.map(name=>JSON.parse(fs.readFileSync(path.join(dataDir,'backups',name),'utf8')).tables.listening_history.length);
    assert.deepEqual(recoveryHistory.sort(),[0,3]);
    pass('Manual v2 backup download/restoration preserves history; legacy v1 restores without foreign-key errors and keeps a recovery copy of previous history');
    assert.equal(recoveryChecks,1);  // Reloads and catalog polling perform no recovery checks.
    await page.locator('#account-toggle').click();await page.locator('#backup-recovery').waitFor();
    const priorDownload=page.waitForEvent('download');await page.locator('#backup-recovery').click();
    const priorFile=await priorDownload;assert.ok(recoveryFiles.includes(priorFile.suggestedFilename()));
    const priorPath=path.join(output,'downloaded-before-restore.json');await priorFile.saveAs(priorPath);
    assert.equal(JSON.parse(fs.readFileSync(priorPath,'utf8')).tables.listening_history.length,3);
    assert.equal((await api('/api/listening-history')).items.length,0);
    assert.equal(recoveryChecks,2);await page.locator('#account-toggle').click();
    pass('Restoring exposes the latest pre-restore backup in the account menu only on demand; downloading preserves the current catalog');

    await page.screenshot({path:path.join(output,'groups-desktop.png'),fullPage:false});
    await api('/api/listening-history','POST',{clip_id:historyIds[0]});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Grouped catalog overflows mobile viewport');
    assert.equal(await page.locator('nav [data-view]').count(),2);
    await page.screenshot({path:path.join(output,'groups-mobile.png'),fullPage:false});
    await page.locator('#listening-history-open').click();await until(async()=>await page.locator('.history-play').count()===1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'History dialog overflows mobile viewport');
    assert.ok(await page.locator('#listening-history-dialog').isVisible());
    await page.screenshot({path:path.join(output,'history-mobile.png'),fullPage:false});
    assert.deepEqual(errors,[]);pass('Grouped catalog and history fit a 390px viewport, retain two navigation tabs, and produce no JavaScript errors');
    await page.locator('#listening-history-dialog .close-dialog').first().click();
    await page.locator('#filter-button').click();
    const range = page.getByRole('group',{name:'上传日期（本地时间）'});
    for (const width of [320,360,390]) {
      await page.setViewportSize({width,height:844});
      for (const label of ['起始上传日期','结束上传日期']) {
        const input = range.getByLabel(label);
        await input.scrollIntoViewIfNeeded();
        assert.ok(await input.evaluate(element=>{
          const rect=element.getBoundingClientRect();
          const picker=document.elementFromPoint(rect.right-6,rect.top+rect.height/2);
          return rect.left>=0 && rect.right<=innerWidth && picker===element;
        }), width+'px: '+label+' calendar edge must be fully reachable');
      }
    }
    await range.getByLabel('起始上传日期').focus();
    for (let step=0;step<6 && !(await page.locator('#before').evaluate(el=>el===document.activeElement));step++)
      await page.keyboard.press('Tab');
    assert.equal(await page.locator('#before').evaluate(el=>el===document.activeElement),true);
    await range.getByLabel('起始上传日期').fill('2020-01-01');
    const filteredDates = page.waitForRequest(request=>{
      const url=new URL(request.url());
      return url.pathname==='/api/clips' && url.searchParams.get('after')==='2020-01-01T00:00:00.000Z' &&
        url.searchParams.get('before')==='2030-01-01T23:59:59.000Z';
    });
    await range.getByLabel('结束上传日期').fill('2030-01-01');await filteredDates;
    pass('Both upload dates and picker edges fit 320–390px widths; keyboard navigation and combined range requests work');
    async function checkLocalDays(zone, boundaries) {
      const local=await browser.newContext({locale:'zh-CN',timezoneId:zone});
      const view=await local.newPage();
      try {
        await local.route('**/*',route=>{
          const url=new URL(route.request().url());
          if(url.origin!==base)return route.abort();
          if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'日期测试'},message:''}});
          return route.continue();
        });
        await view.goto(base+'/#catalog');
        await view.locator('#filter-button').click();
        for(const [day,start,end] of boundaries){
          const filtered=view.waitForRequest(request=>{
            const url=new URL(request.url());
            return url.pathname==='/api/clips' && url.searchParams.get('after')===start && url.searchParams.get('before')===end;
          });
          await view.locator('#after').fill(day);
          await view.locator('#before').fill(day);
          await filtered;
        }
      }finally{await local.close();}
    }
    await checkLocalDays('Asia/Shanghai',[
      ['2026-03-02','2026-03-01T16:00:00.000Z','2026-03-02T15:59:59.000Z']
    ]);
    await checkLocalDays('Europe/London',[
      ['2026-03-29','2026-03-29T00:00:00.000Z','2026-03-29T22:59:59.000Z'],
      ['2026-10-25','2026-10-24T23:00:00.000Z','2026-10-25T23:59:59.000Z']
    ]);
    pass('Upload dates follow the displayed local calendar in Shanghai and on both the 23-hour and 25-hour London days');
    await page.close();await until(()=>service.exitCode!==null);assert.equal(service.exitCode,0);
    fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({checks,errors,output,packaged:!!exe,blockedExternalRequests:blocked.length},null,2));
  }finally{await browser.close();if(service.exitCode===null)spawnSync('taskkill',['/PID',String(service.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
