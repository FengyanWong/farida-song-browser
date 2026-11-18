// Collection-status browser regression checks. Runs an isolated local database;
// all account/status responses are fixtures and external requests are blocked.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(100);}throw Error('Collection status check timed out');}
(async()=>{
  const root=path.resolve('.local/collection-status-qa');fs.mkdirSync(root,{recursive:true});
  const output=fs.mkdtempSync(path.join(root,'run-'));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const base=`http://127.0.0.1:${port}`,exe=process.argv[3];
  const args=[...(exe?[]:['-X','utf8',path.resolve('run.py')]),'--no-browser','--no-startup-scan','--port',String(port),'--data-dir',path.join(output,'数据')];
  const service=spawn(path.resolve(exe||'.venv/Scripts/python.exe'),args,{cwd:path.resolve('.'),stdio:'ignore',windowsHide:true});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({locale:'zh-CN',timezoneId:'Asia/Shanghai',viewport:{width:1440,height:1000}});
  const page=await context.newPage(),checks=[],errors=[],resumeRequests=[];
  const pass=message=>{checks.push(message);console.log('Passed: '+message);};
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await until(async()=>{assert.equal(service.exitCode,null);try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
    const overview=await(await fetch(base+'/api/overview')).json();
    const uploaders=overview.sources.filter(source=>source.source_type==='uploader');
    const search=overview.sources.find(source=>source.source_type==='search');
    assert.equal(uploaders.length,4);assert.ok(search);
    const [complete,paused,unstarted,legacy]=uploaders;
    const stamp='2026-10-22T09:25:00+00:00',success='2026-10-20T10:15:00+00:00';
    const restricted={source_id:paused.id,category:'restricted',upstream_code:-412,message:'test restriction',retry_at:'2026-09-06T10:01:30+00:00'};
    const unavailable={bvid:'BV0000000123',category:'unavailable',upstream_code:-404};
    const freshStatus={state:'idle',last_success_at:null,last_attempt_at:null,finished_at:null,processed:0,added_clips:null,added_included:null,skipped:0,error:null,job_id:null,mode:null,current_page:null,scope:null,can_resume:false,unavailable:[]};
    for(const source of overview.sources)source.collection_status={...freshStatus};
    const indexed=overview.sources.find(source=>source.source_type==='songlist');
    indexed.collection_status={...freshStatus,state:'not_started',index_fetched_at:stamp,added_clips:0,added_included:0};
    Object.assign(complete,{last_refresh_at:success,verification_status:'verified'});
    complete.collection_status={...freshStatus,state:'completed',last_success_at:success,last_attempt_at:stamp,finished_at:stamp,processed:24,added_clips:2,added_included:1,job_id:'status-task',mode:'incremental'};
    paused.collection_status={...freshStatus,state:'paused',last_success_at:success,last_attempt_at:stamp,finished_at:stamp,processed:8,added_clips:3,added_included:2,skipped:1,error:restricted,job_id:'status-task',mode:'full',current_page:2,can_resume:true,unavailable:[unavailable]};
    unstarted.collection_status={...freshStatus,state:'not_started',added_clips:0,added_included:0,job_id:'status-task',mode:'full',can_resume:true};
    legacy.collection_status={...freshStatus,state:'completed',last_success_at:success,last_attempt_at:success,finished_at:success,processed:18,job_id:'legacy-task',mode:'full'};
    search.collection_status={...freshStatus,state:'completed',last_success_at:success,last_attempt_at:stamp,finished_at:stamp,processed:20,added_clips:0,added_included:0,job_id:'search-task',mode:'incremental',scope:'discovery'};
    const cp=(source,state)=>({state,source_url:source.canonical_url,processed:source.collection_status.processed,added_clips:source.collection_status.added_clips,added_included:source.collection_status.added_included,unavailable:source.collection_status.unavailable,current_page:source.collection_status.current_page});
    const task={id:'status-task',state:'paused',mode:'full',source_ids:[complete.id,paused.id,unstarted.id],started_at:stamp,finished_at:stamp,processed:32,cancel_requested:0,errors:[restricted],checkpoints:{[complete.id]:cp(complete,'completed'),[paused.id]:cp(paused,'failed'),[unstarted.id]:cp(unstarted,'pending')}};
    overview.jobs=[task,{...task,id:'older-stale',state:'failed',source_ids:[complete.id],errors:[],checkpoints:{[complete.id]:{state:'failed',unavailable:[{...unavailable,bvid:'BV0000000999'}]}}}];
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==base)return route.abort();
      if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'采集状态测试'},message:''}});
      if(url.pathname==='/api/overview')return route.fulfill({json:overview});
      if(url.pathname==='/api/sync/status-task/resume'){
        resumeRequests.push(url.pathname);task.state='running';task.errors=[];task.finished_at=null;
        task.checkpoints[paused.id].state='running';task.checkpoints[paused.id].current_page=3;task.processed=35;
        Object.assign(paused.collection_status,{state:'running',error:null,finished_at:null,processed:11,current_page:3,can_resume:false});
        Object.assign(unstarted.collection_status,{state:'queued',can_resume:false});
        return route.fulfill({json:task});
      }
      if(url.pathname.startsWith('/api/sync'))return route.fulfill({status:409,json:{detail:'QA prevents upstream collection'}});
      return route.continue();
    });
    const songlist=overview.sources.find(source=>source.source_type==='songlist');
    const missingPath='/api/sources/'+songlist.id+'/missing-links', missingRequests=[];
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.pathname===missingPath)missingRequests.push(url.search);
    });
    await page.goto(base+'/#sources');await page.locator('.source-card').first().waitFor();
    const card=source=>page.locator('.source-card').filter({has:page.locator(`[data-scan-source="${source.id}"]`)});
    const text=source=>card(source).textContent();
    const completedText=await text(complete);
    assert.match(completedText,/更新完成/);assert.match(completedText,/上次成功更新：2026/);
    assert.match(completedText,/新增 2 个片段.*其中 1 个已收录/);
    assert.match(completedText,/本次检查最近投稿/);
    assert.equal(await card(complete).locator('[data-resume]').count(),0);
    assert.equal(await card(complete).locator('.unavailable-videos').count(),0);
    assert.doesNotMatch(completedText,/BV0000000999/);
    pass('Completed source shows success date and new clips without a retry button or stale skipped videos from another job');
    const pausedText=await text(paused);
    assert.match(pausedText,/访问受限，已暂停/);assert.match(pausedText,/新增 3 个片段.*其中 2 个已收录/);
    assert.match(pausedText,/上次成功更新：2026/);assert.match(pausedText,/B站暂时限制访问/);assert.match(pausedText,/18:01:30（本机时间）后点击「继续任务」/);
    assert.match(pausedText,/跳过 1 个不可访问视频/);assert.match(pausedText,/BV0000000123/);
    assert.equal(await card(paused).locator('[data-resume]').isEnabled(),true);
    assert.match(await page.locator('#job-banner').textContent(),/新增 5 个片段（已收录 3）/);
    pass('Paused partial collection retains previous success and additions, lists unavailable videos, and explains how to retry');
    assert.match(await text(indexed),/视频资料待补全/);
    assert.match(await text(indexed),/整理歌单已更新/);
    const unstartedText=await text(unstarted),legacyText=await text(legacy);
    assert.match(unstartedText,/本次尚未执行/);assert.match(unstartedText,/前序来源停止/);
    assert.doesNotMatch(unstartedText,/最近尝试|旧任务/);assert.match(unstartedText,/新增 0 个片段/);
    assert.match(legacyText,/旧任务未记录新增数/);assert.doesNotMatch(legacyText,/新增 0 个片段/);
    assert.match(await text(search),/标签搜索仅检查限定页数，不代表全部视频/);
    pass('Unstarted sources are distinct from legacy unknown counts, and tag discovery explains its bounded coverage');
    await card(paused).locator('[data-resume]').click();await until(()=>resumeRequests.length===1);
    await until(async()=>(await page.locator('#job-banner').textContent()).includes('第 3 页'));
    assert.match(await page.locator('#job-banner').textContent(),new RegExp(paused.display_name));
    assert.match(await page.locator('#job-banner').textContent(),/已检查 35 个视频/);
    assert.match(await text(paused),/正在采集.*已检查 11 个视频.*第 3 页/s);
    assert.match(await text(unstarted),/等待采集/);
    assert.equal(await card(paused).locator('[data-scan-source]').isDisabled(),true);
    task.state='completed';task.finished_at=stamp;task.processed=50;task.checkpoints[paused.id].state='completed';task.checkpoints[unstarted.id].state='completed';
    Object.assign(paused.collection_status,{state:'completed',finished_at:stamp,last_success_at:stamp,can_resume:false});
    Object.assign(unstarted.collection_status,{state:'completed',finished_at:stamp,last_success_at:stamp,last_attempt_at:stamp,can_resume:false});
    await until(async()=>(await page.locator('#job-banner').textContent()).includes('已完成'));
    assert.equal(await page.locator('#job-banner .spinner').count(),0);
    assert.equal(await card(paused).locator('[data-resume]').count(),0);
    assert.equal(await card(paused).locator('[data-scan-source]').isEnabled(),true);
    assert.match(await text(paused),/更新完成/);
    pass('Retry routes to the selected task; resumed active progress and terminal completion refresh the banner and source actions');
    await page.screenshot({path:path.join(output,'collection-status-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Sources page overflows mobile viewport');
    assert.ok(await card(paused).isVisible());
    await page.screenshot({path:path.join(output,'collection-status-mobile.png'),fullPage:false});
    assert.deepEqual(errors,[]);pass('Collection status fits a 390px mobile viewport with no JavaScript errors');
    const action=card(songlist).getByRole('button',{name:'查看待补全链接'}), dialog=page.locator('#missing-links-dialog');
    const list=page.locator('#missing-links-list'), status=page.locator('#missing-links-status'), more=page.locator('#missing-links-more');
    assert.equal(await page.getByRole('button',{name:'查看待补全链接'}).count(),1);
    assert.deepEqual(missingRequests,[]);
    await action.click();
    const real=await(await fetch(base+missingPath+'?after_id=0&limit=40')).json();
    await until(async()=>/已显示|当前没有/.test(await status.textContent()));
    assert.equal(await list.locator('li').count(),real.items.length);
    for (const [i,item] of real.items.entries()) {
      assert.equal(await list.locator('li a').nth(i).getAttribute('href'),item.url);
      assert.equal(await list.locator('strong').nth(i).textContent(),item.song_title||item.bvid);
    }
    assert.equal(await dialog.getByRole('link',{name:/CLANNADOR/}).getAttribute('href'),real.source_url);
    assert.equal(await page.locator('nav [data-view]').count(),2);
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert.deepEqual(missingRequests,['?after_id=0&limit=40']);
    pass('Only the curated Sources card opens missing BV entries, on demand, with the original songlist attribution and real local catalog links');

    const pattern='**'+missingPath+'?**';
    const entries=Array.from({length:42},(_,i)=>{
      const bvid='BV'+String(i+1).padStart(10,'0');
      return {id:i+1,song_title:i<2?'同名 <夜曲>':'歌曲 '+(i+1),original_artist:i===1?'':'原唱 '+(i+1),bvid,url:'https://www.bilibili.com/video/'+bvid+'/'};
    });
    const fixturePage=(items,next_after_id)=>({items,next_after_id,attribution:'CLANNADOR',source_url:'https://fareeda.songlist.cc/'});
    let failMore=true;
    const pages=async route=>{
      const after=new URL(route.request().url()).searchParams.get('after_id');
      if(after==='0')return route.fulfill({json:fixturePage(entries.slice(0,40),40)});
      assert.equal(after,'40');
      if(failMore){failMore=false;return route.fulfill({status:503,json:{detail:'读取失败测试'}});}
      return route.fulfill({json:fixturePage(entries.slice(40),null)});
    };
    await page.route(pattern,pages);
    await action.click();await until(async()=>await list.locator('li').count()===40);
    assert.equal(await list.getByText('同名 <夜曲>',{exact:true}).count(),2);
    assert.equal(await list.locator('li').nth(0).locator('small').textContent(),'原唱：原唱 1');
    assert.equal(await list.locator('li').nth(1).locator('small').count(),0);
    assert.doesNotMatch(await list.textContent(),/CLANNADOR|UP 主|上传时间/);
    await more.click();await until(async()=>await more.textContent()==='重试');
    assert.equal(await status.textContent(),'读取失败测试');assert.equal(await list.locator('li').count(),40);
    await more.click();await until(async()=>await list.locator('li').count()===42);
    assert.ok(await more.isHidden());assert.equal(await status.textContent(),'已显示 42 条');
    assert.deepEqual(await list.locator('a').evaluateAll(nodes=>nodes.map(a=>a.href)),entries.map(item=>item.url));
    assert.equal(await list.locator('li a').nth(40).evaluate(el=>el===document.activeElement),true);
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    await page.unroute(pattern,pages);
    pass('Missing-link pagination retains distinct songlist entries and original artists; retry uses the same cursor and keyboard focus moves to the next page');

    let signalStart,release,finished;
    const started=new Promise(resolve=>{signalStart=resolve;}), hold=new Promise(resolve=>{release=resolve;}), late=new Promise(resolve=>{finished=resolve;});
    await page.route(pattern, async route=>{
      if(signalStart){
        signalStart();signalStart=null;await hold;
        try {await route.fulfill({json:fixturePage(entries.slice(0,1),null)});} catch {} finally {finished();}
      } else await route.fulfill({json:fixturePage([],null)});
    });
    await action.click();await started;await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    await action.click();await until(async()=>await status.textContent()==='当前没有待补全的链接。');
    release();await late;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    assert.equal(await list.locator('li').count(),0);assert.ok(await more.isHidden());
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert.deepEqual(errors,[]);pass('Closing and reopening during a slow lookup preserves the new empty state');
    await page.close();await until(()=>service.exitCode!==null);assert.equal(service.exitCode,0);
    fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({checks,errors,output,packaged:!!exe},null,2));
  }finally{await browser.close();if(service.exitCode===null)spawnSync('taskkill',['/PID',String(service.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
