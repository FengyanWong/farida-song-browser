// Exercise pet changes on one local origin with real Edge IndexedDB. All files are fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require(process.argv[2]||process.env.FARIDA_PLAYWRIGHT_PATH||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(await check())return;await delay(100);}throw Error('Pet persistence check timed out');}
(async()=>{
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port,exe=process.argv[3],root=path.resolve('.local/pet-qa');fs.mkdirSync(root,{recursive:true});
 const args=exe?['--no-browser','--no-startup-scan','--port',String(port),'--data-dir',fs.mkdtempSync(path.join(root,'run-'))]:
   ['-B','-X','utf8','scripts/serve_qa.py','--port',String(port)];
 const server=spawn(path.resolve(exe||'.venv/Scripts/python.exe'),args,{stdio:'ignore',windowsHide:true});
 let browser;
 try{
  await until(async()=>{assert.equal(server.exitCode,null);try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext(),errors=[];
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
   if(url.pathname.startsWith('/api/auth'))return route.fulfill({json:{state:'connected',stored:true,account:{uid:'123',name:'宠物测试'}}});
   return route.continue();
  });
  await context.addInitScript(()=>{
   window.petReads=0;const get=IDBObjectStore.prototype.get;
   IDBObjectStore.prototype.get=function(key){if(this.name==='settings'&&key==='pet')window.petReads++;return get.call(this,key);};
  });
  const a=await context.newPage(),b=await context.newPage();
  for(const page of [a,b])page.on('pageerror',error=>errors.push(error.message));
  const nameIs=(page,name)=>page.waitForFunction(expected=>!!document.querySelector('#pet-sprite')?.style.backgroundImage&&document.querySelector('#pet-name').textContent===expected,name);
  const reads=page=>page.evaluate(()=>window.petReads);
  const settings=async page=>{if(!await page.locator('#pet-dialog').isVisible())await page.locator('#pet-settings').click();};
  const markHidden=(page,hidden)=>page.evaluate(hidden=>{
   Object.defineProperty(document,'hidden',{configurable:true,value:hidden});document.dispatchEvent(new Event('visibilitychange'));
  },hidden);
  await Promise.all([a.goto(base),b.goto(base)]);await Promise.all([nameIs(a,'Frida'),nameIs(b,'Frida')]);await settings(a);
  const v1=await a.evaluate(()=>{
   const canvas=document.createElement('canvas');canvas.width=1536;canvas.height=1872;
   const ctx=canvas.getContext('2d');for(let y=0;y<1872;y+=208)for(let x=0;x<1536;x+=192)ctx.fillRect(x,y,4,4);
   return canvas.toDataURL('image/png').split(',')[1];
  });
  const files=[{name:'v1.png',mimeType:'image/png',buffer:Buffer.from(v1,'base64')},
               {name:'v2.webp',mimeType:'image/webp',buffer:fs.readFileSync('frontend/assets/frida.webp')}];
  const choose=(page,version,name)=>page.locator('#pet-files').setInputFiles([files[version-1],{name:'pet.json',mimeType:'application/json',
       buffer:Buffer.from(JSON.stringify({displayName:name,spriteVersionNumber:version}))}]);
  const reset=async page=>{await settings(page);await page.locator('#pet-reset').click();await nameIs(page,'Frida');};
  const originalReads=await reads(b);
  await choose(a,1,'一号小伙伴');await Promise.all([nameIs(a,'一号小伙伴'),nameIs(b,'一号小伙伴')]);
  assert.equal(await reads(b),originalReads+1);
  // Earlier versions saved the same Blob but had no cross-tab change marker.
  await a.evaluate(()=>localStorage.removeItem('farida-pet-change'));await b.reload();await nameIs(b,'一号小伙伴');
  assert.equal(await reads(b),1);
  console.log('The original v1 IndexedDB record works after reload without migration; a peer reads a newly imported pet once.');

  await b.evaluate(async()=>{
   const {Pet}=await import('/pet.js'),tick=Pet.prototype.tick;window.petTicks=0;
   Pet.prototype.tick=function(){window.petTicks++;return tick.call(this);};
  });
  await markHidden(b,true);const hiddenReads=await reads(b);
  await b.evaluate(()=>window.petTicks=0);
  await choose(a,2,'二号小伙伴');await nameIs(a,'二号小伙伴');await reset(a);
  await choose(a,2,'最终二号');await nameIs(a,'最终二号');
  await a.locator('#pet-visible').uncheck();await a.locator('#pet-motion').uncheck();
  await b.waitForFunction(()=>!document.querySelector('#pet-visible').checked&&!document.querySelector('#pet-motion').checked);
  assert.equal(await b.locator('#pet-sprite').isHidden(),true);await delay(350);
  assert.equal(await reads(b),hiddenReads);assert.equal(await b.evaluate(()=>window.petTicks),0);
  await markHidden(b,false);await nameIs(b,'最终二号');assert.equal(await reads(b),hiddenReads+1);
  await b.emulateMedia({reducedMotion:'reduce'});
  await a.locator('#pet-visible').check();await a.locator('#pet-motion').check();
  await b.waitForFunction(()=>document.querySelector('#pet-visible').checked&&document.querySelector('#pet-motion').checked);
  await delay(350);assert.equal(await b.evaluate(()=>window.petTicks),0);assert.equal(await reads(b),hiddenReads+1);
  assert.equal(await b.locator('#pet-sprite').evaluate(el=>el.style.backgroundPosition),'0px 0px');
  await b.reload();await nameIs(b,'最终二号');
  console.log('Hidden tabs do zero pet reads or animation ticks during three changes, then read only the latest v2 once. Visibility and motion sync without image reads; OS reduced motion stays static.');

  for(const resetTab of [a,b]){
   await settings(a);await choose(a,2,'当前小伙伴');await Promise.all([nameIs(a,'当前小伙伴'),nameIs(b,'当前小伙伴')]);
   await a.evaluate(()=>{
    const decode=window.createImageBitmap.bind(window);window.finishPetDecode=null;window.decodeReturned=false;
    window.createImageBitmap=async(...args)=>{
     window.createImageBitmap=decode;const bitmap=await decode(...args);
     await new Promise(resolve=>window.finishPetDecode=resolve);window.decodeReturned=true;return bitmap;
    };
   });
   await choose(a,1,'旧请求');await a.waitForFunction(()=>!!window.finishPetDecode);
   await reset(resetTab);await Promise.all([nameIs(a,'Frida'),nameIs(b,'Frida')]);
   const before=await reads(b);
   await a.evaluate(()=>window.finishPetDecode());await a.waitForFunction(()=>window.decodeReturned);await delay(120);
   assert.equal(await a.locator('#pet-name').textContent(),'Frida');assert.equal(await reads(b),before);
   await a.reload();await nameIs(a,'Frida');
  }
  assert.deepEqual(errors,[]);console.log('Reset in either tab wins over a delayed valid import. Both tabs and a fresh page retain Frida; no stale database write is published.');
 }finally{if(browser)await browser.close();if(server.exitCode===null)spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{stdio:'ignore'});}
})().catch(error=>{console.error(error);process.exitCode=1;});
