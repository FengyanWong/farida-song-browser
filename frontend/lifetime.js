// One connection per document; hidden tabs remain connected without timers.
const initialRetryMs=500, maxRetryMs=30000;

export class AppLifetime {
  constructor(onStopping) {
    this.onStopping=onStopping;
    this.socket=null;this.timer=null;this.token=null;this.paused=false;this.stopped=false;
    this.retryMs=initialRetryMs;
    window.addEventListener('pagehide',()=>{this.paused=true;this.disconnect();});
    window.addEventListener('pageshow',()=>{this.paused=false;this.connect();});
  }
  start(token) {this.token=token;this.connect();}
  connect() {
    if(!this.token||this.stopped||this.paused||this.socket)return;
    clearTimeout(this.timer);
    const url=new URL('/api/window',location.href);
    url.protocol=location.protocol==='https:'?'wss:':'ws:';
    const socket=this.socket=new WebSocket(url);
    socket.addEventListener('open',()=>{
      if(this.socket===socket&&!this.stopped&&!this.paused)socket.send(JSON.stringify({token:this.token}));
      else socket.close();
    });
    socket.addEventListener('message',event=>{
      if(this.socket!==socket)return;
      let message;
      try {message=JSON.parse(event.data);} catch {return;}
      if(message?.state==='connected') this.retryMs=initialRetryMs;
      if(message?.state==='stopping') {this.stop();this.onStopping();}
    });
    socket.addEventListener('close',event=>{
      if(this.socket!==socket)return;
      this.socket=null;
      if(this.stopped||this.paused||event.code===1008)return;
      this.timer=setTimeout(()=>this.connect(),this.retryMs);
      this.retryMs=Math.min(this.retryMs*2,maxRetryMs);
    });
  }
  disconnect() {
    clearTimeout(this.timer);
    const socket=this.socket;this.socket=null;
    if(socket)socket.close();
  }
  stop() {this.stopped=true;this.disconnect();}
}
