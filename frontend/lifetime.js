// One connection per document; hidden tabs remain connected without timers.
export class AppLifetime {
  constructor() {
    this.socket=null;this.timer=null;this.token=null;this.paused=false;this.stopped=false;
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
    socket.addEventListener('close',event=>{
      if(this.socket!==socket)return;
      this.socket=null;
      if(!this.stopped&&!this.paused&&event.code!==1008)this.timer=setTimeout(()=>this.connect(),500);
    });
  }
  disconnect() {
    clearTimeout(this.timer);
    const socket=this.socket;this.socket=null;
    if(socket)socket.close();
  }
  stop() {this.stopped=true;this.disconnect();}
}
