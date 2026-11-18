import { $, $$, icon, toast } from './ui.js';

const labels={checking:'正在验证登录',signed_out:'未登录',saved:'等待验证',connected:'已登录',expired:'登录已失效',unknown:'状态待检查',unavailable:'登录信息无法读取',preview:'演示模式'};
const activeStates=new Set(['waiting','scanned']);

export class AccountLogin {
  constructor(api, changed) {
    this.api=api;this.changed=changed;this.preview=true;this.busy=false;this.loggingOut=false;this.initialized=false;this.stopped=false;
    this.generation=0;this.revision=0;this.attempt=null;this.operations=Promise.resolve();
    this.qrObserver=globalThis.crypto?.randomUUID?.();
    this.dialog=$('#login-dialog');
    $('#account-toggle').onclick=()=>this.toggleMenu();
    $('#login-button').onclick=()=>this.openQR();
    $('#login-retry').onclick=()=>this.generate();
    $('#check-login').onclick=()=>this.accountAction('check');
    $('#login-check').onclick=()=>this.accountAction('check');
    $('#logout-button').onclick=()=>this.accountAction('logout');
    this.dialog.addEventListener('cancel',event=>{if(!this.canCollect())event.preventDefault();});
    this.dialog.addEventListener('close',()=>this.closed());
    let qrHidden=document.hidden;
    document.addEventListener('visibilitychange',()=>{
      if (document.hidden===qrHidden) return;
      qrHidden=document.hidden;
      clearTimeout(this.timer);
      if (!qrHidden) this.poll(this.generation);
    });
    document.addEventListener('click',event=>{if(!event.target.closest('#account-menu-wrap'))this.toggleMenu(false);});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')this.toggleMenu(false);});
  }
  canCollect() {return this.initialized && !this.loggingOut && (this.preview||this.auth?.state==='connected');}
  stop() {
    this.stopped=true;++this.generation;++this.revision;clearTimeout(this.timer);
    this.attempt=null;this.hideImage();this.toggleMenu(false);
  }
  toggleMenu(open=$('#account-menu').hidden) {
    $('#account-menu').hidden=!open;$('#account-toggle').setAttribute('aria-expanded',String(open));
  }
  async initialize(preview) {
    this.preview=preview;
    if(preview){this.initialized=true;await this.refresh();return;}
    this.render({state:'checking',stored:false,account:null});
    await this.accountAction('check');
  }
  queue(operation) {
    // Serialize creation and cancellation so a late response from a closed
    // dialog cannot cancel a newly opened QR attempt.
    this.operations=this.operations.catch(()=>{}).then(operation);
    return this.operations;
  }
  async refresh() {
    if(this.stopped||!this.initialized||this.busy)return;
    const revision=++this.revision;
    try {
      const auth=await this.api('/api/auth');if(revision!==this.revision)return;
      if (JSON.stringify(auth) === JSON.stringify(this.auth)) return;
      const previous=this.auth?.state;this.render(auth);
      if(!this.preview&&previous!==auth.state)await this.settle(auth);
    }catch{ /* A local service outage is reported by the main connection status. */ }
  }
  render(auth) {
    if(this.stopped)return;
    this.auth=auth;const preview=this.preview||auth.state==='preview',account=auth.account;
    const name=account?.name||(account?.uid?`UID ${account.uid}`:'哔哩哔哩账号');
    $('#account-name').textContent=name;$('#account-name').title=name;
    const status=this.loggingOut?'正在退出登录':(labels[auth.state]||'状态待检查');
    $('#account-status').textContent=status;
    $('#account-toggle').classList.toggle('connected',auth.state==='connected');
    $('#account-toggle').setAttribute('aria-label',`${name}，${status}，账号设置`);
    const avatar=$('#account-avatar');if(account)avatar.textContent=Array.from(account.name||'B')[0];else avatar.innerHTML=icon('user');
    $('#account-uid').textContent=account?.uid?`UID ${account.uid}`:'';
    $('#account-detail').textContent=preview?'演示预览不连接真实账号。':auth.message||(auth.state==='connected'?'采集将使用此账号。':auth.stored?'本机已保存登录信息，验证后即可使用。':'请扫码登录，验证后开始采集。');
    $('#login-button').textContent=auth.stored?'更换账号':'扫码登录';$('#login-button').disabled=preview||this.busy;
    $('#check-login').hidden=!auth.stored||preview;$('#logout-button').hidden=!auth.stored||preview;
    $('#check-login').disabled=this.busy;$('#logout-button').disabled=this.busy;$('#login-check').disabled=this.busy;
    $$('.login-dismiss').forEach(button=>button.hidden=!this.canCollect());
    document.body.classList.toggle('login-required',!preview&&!this.canCollect());
    document.dispatchEvent(new Event('farida-auth-change'));
  }
  showDialog() {
    if(this.stopped)return;
    this.toggleMenu(false);
    if(!this.dialog.open)this.dialog.showModal();
    $$('.login-dismiss').forEach(button=>button.hidden=!this.canCollect());
  }
  showChecking() {
    this.showDialog();this.hideImage();$('#login-qr-box').hidden=false;$('#login-qr-placeholder').hidden=false;
    $('#login-title').textContent='正在验证本机登录';$('#login-instructions').textContent='验证成功后自动进入，并更新已启用的采集来源。';
    $('#login-message').textContent='正在检查登录状态…';$('#login-message').classList.remove('error');
    $('#login-expiry').textContent='';$('#login-retry').hidden=true;$('#login-check').hidden=true;
  }
  async settle(auth) {
    if(this.stopped)return;
    if(auth.state==='connected') {
      if(this.dialog.open)this.dialog.close();
      await this.changed();return;
    }
    this.showDialog();
    if(['signed_out','expired'].includes(auth.state)) {
      if(!this.attempt)this.generate();
    }else{
      this.failure(auth.message||'暂时无法验证登录，请稍后重新检查。');
      const unreadable=auth.state==='unavailable';
      $('#login-title').textContent=unreadable?'读取已保存的登录':'需要验证登录';
      $('#login-instructions').textContent=unreadable?'可以重试读取本机登录信息，也可以重新扫码。':'检查已保存的登录状态，验证成功后即可继续。';
      $('#login-check').textContent=unreadable?'重试读取登录信息':'检查登录';
      $('#login-check').hidden=!auth.stored;$('#login-retry').textContent='重新扫码';
    }
  }
  async accountAction(action) {
    if(this.stopped||this.busy||this.preview)return;
    this.busy=true;this.loggingOut=action==='logout';++this.revision;this.render(this.auth);this.toggleMenu(false);
    // Startup verification stays in the header. Open the login dialog only
    // after checking the saved session, so a valid login never flashes a QR box.
    if(action==='check'&&this.dialog.open&&!this.canCollect())this.showChecking();
    try {
      const auth=await this.api(`/api/auth/${action}`,{method:'POST'});
      if(this.stopped)return;
      this.loggingOut=false;this.initialized=true;this.render(auth);
      if(action==='logout'){await this.changed();toast('已退出本机账号，采集任务已停止。');}
      await this.settle(auth);
    }catch(error){
      if(this.stopped)return;
      this.initialized=true;
      if(this.loggingOut){this.loggingOut=false;this.render(this.auth);}
      $('#account-detail').textContent=error.message;
      if(!this.canCollect()){this.showDialog();this.failure(error.message);$('#login-check').hidden=false;}
      else toast(error.message);
    }finally{
      this.busy=false;if(!this.stopped){$('#login-button').disabled=this.preview;$('#check-login').disabled=false;$('#logout-button').disabled=false;$('#login-check').disabled=false;}
    }
  }
  async requireLogin() {await this.accountAction('check');}
  openQR() {if(this.preview||this.busy)return;this.showDialog();this.generate();}
  valid(generation) {return !this.stopped&&this.dialog.open&&generation===this.generation;}
  hideImage() {$('#login-qr').hidden=true;$('#login-qr').removeAttribute('src');}
  async cancel(id) {if(id&&!this.stopped)await this.api(`/api/auth/qr/${encodeURIComponent(id)}/cancel`,{method:'POST'}).catch(()=>{});}
  closed() {
    if(this.stopped)return;
    ++this.generation;clearTimeout(this.timer);this.hideImage();
    const id=this.attempt;this.attempt=null;this.queue(()=>this.cancel(id));
    if(!this.canCollect())this.settle(this.auth);
  }
  generate() {
    if(this.stopped||this.preview)return;
    const generation=++this.generation,old=this.attempt;this.attempt=null;clearTimeout(this.timer);
    this.hideImage();$('#login-qr-box').hidden=false;$('#login-qr-placeholder').hidden=false;
    $('#login-title').textContent=this.canCollect()?'更换哔哩哔哩账号':'登录后开始收藏';
    $('#login-instructions').textContent='打开哔哩哔哩手机 App，使用「扫一扫」，然后在手机上确认登录。';
    $('#login-message').textContent='正在获取二维码…';$('#login-message').classList.remove('error');
    $('#login-expiry').textContent='';$('#login-retry').hidden=true;$('#login-retry').textContent='刷新二维码';$('#login-check').hidden=true;
    this.queue(async()=>{
      await this.cancel(old);if(!this.valid(generation))return;
      try {
        const path=this.qrObserver ? '/api/auth/qr?observer='+this.qrObserver : '/api/auth/qr';
        const result=await this.api(path,{method:'POST'});
        if(!this.valid(generation)){await this.cancel(result.id);return;}
        this.attempt=result.id;
        if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.qr_image||''))throw new Error('二维码加载失败，请重新获取。');
        $('#login-qr').src=result.qr_image;$('#login-qr').hidden=false;$('#login-qr-placeholder').hidden=true;
        await this.update(result,generation);
      }catch(error){if(this.valid(generation))this.failure(error.message);}
    });
  }
  failure(message) {
    this.pollGeneration=null;clearTimeout(this.timer);this.hideImage();$('#login-qr-box').hidden=true;
    $('#login-message').textContent=message;$('#login-message').classList.add('error');
    $('#login-expiry').textContent='';$('#login-retry').hidden=false;
  }
  async update(result,generation) {
    if(!this.valid(generation))return;
    if(result.state==='authenticated'||result.state==='saved') {
      this.attempt=null;this.hideImage();$('#login-qr-box').hidden=true;$('#login-expiry').textContent='';
      ++this.revision;this.render(result.auth);await this.settle(result.auth);
      if(result.auth.state==='connected')toast('登录成功。');return;
    }
    if(!activeStates.has(result.state)){this.failure(result.message||(result.state==='expired'?'二维码已过期，请刷新后重新扫码。':'登录已结束，请重新获取二维码。'));return;}
    $('#login-message').textContent=result.state==='scanned'?'已扫码，请在手机上确认登录。':'等待扫码';
    $('#login-expiry').textContent=`二维码约 ${Math.max(0,Math.ceil(result.expires_in))} 秒后过期`;
    this.pollGeneration=generation;
    clearTimeout(this.timer);
    if (!document.hidden) this.timer=setTimeout(()=>this.poll(generation),Math.max(3000,result.poll_after_ms||3000));
  }
  async poll(generation) {
    if(document.hidden||!this.valid(generation)||!this.attempt||this.pollGeneration!==generation||this.polling===generation)return;
    this.polling=generation;
    try {await this.update(await this.api(`/api/auth/qr/${encodeURIComponent(this.attempt)}/poll`,{method:'POST'}),generation);}
    catch(error){if(this.valid(generation))this.failure(error.message);}
    finally{if(this.polling===generation)this.polling=null;}
  }
}
