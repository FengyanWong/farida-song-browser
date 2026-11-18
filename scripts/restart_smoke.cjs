// Exercise immediate relaunch while the old backend is still shutting down.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await delay(200);}throw Error('Restart timed out');}
(async()=>{
 const root=path.resolve('.local/restart-qa');fs.mkdirSync(root,{recursive:true});
 const data=fs.mkdtempSync(path.join(root,'run-'));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
 const port=listener.address().port;await new Promise(r=>listener.close(r));
 const base=`http://127.0.0.1:${port}`;
 const exe=path.resolve(process.argv[2]);
 const args=['--no-browser','--no-startup-scan','--port',String(port),'--data-dir',data];
 const children=[];let socket;
 const start=()=>{const child=spawn(exe,args,{stdio:'ignore',windowsHide:true});children.push(child);return child;};
 async function session(){try {const r=await fetch(base+'/api/session');return r.ok?await r.json():null;}catch{return null;}}
 const quit=token=>fetch(base+'/api/shutdown',{method:'POST',headers:{'X-Farida-Token':token,'Content-Type':'application/json'},body:'{}'});
 try{
  const first=start();let original;
  await until(async()=>{original=await session();return !!original;});
  await quit(original.token);
  const second=start();let replacement;
  await until(async()=>{assert.equal(second.exitCode,null);replacement=await session();return replacement&&replacement.token!==original.token;});
  await until(()=>first.exitCode!==null);assert.equal(first.exitCode,0);
  assert.equal((await(await fetch(base+'/api/health')).json()).status,'ok');
  await quit(replacement.token);await until(()=>second.exitCode!==null);assert.equal(second.exitCode,0);
  console.log('PASS: immediate relaunch waits for the old backend and opens a new healthy instance');
 }finally{socket?.close();for(const child of children)if(child.exitCode===null)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
