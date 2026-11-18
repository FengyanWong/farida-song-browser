import { $ } from './ui.js';

/** A second set of controls for the single video owned by PlaylistPlayer. */
export class MiniPlayer {
  constructor(mainPlayer) {
    this.player=mainPlayer;this.video=mainPlayer.video;
    this.main=$('#music-player');this.element=$('#mini-player');this.lastVolume=this.video.volume||1;
    this.sync=this.sync.bind(this);this.schedule=this.schedule.bind(this);
    $('#mini-player-toggle').onclick=()=>$('#player-toggle').click();
    $('#mini-player-prev').onclick=()=>$('#player-prev').click();
    $('#mini-player-next').onclick=()=>$('#player-next').click();
    $('#mini-player-show').onclick=()=>this.showMain();
    $('#mini-player-mute').onclick=()=>{
      if(this.video.muted||this.video.volume===0){if(!this.video.volume)this.video.volume=this.lastVolume;this.video.muted=false;}
      else this.video.muted=true;
    };
    $('#mini-player-volume').oninput=event=>{this.video.volume=Number(event.target.value)/100;this.video.muted=false;};
    this.observer=new IntersectionObserver(this.schedule,{threshold:0});this.observer.observe(this.main);
    this.mutations=new MutationObserver(this.schedule);
    this.mutations.observe(this.main,{attributes:true,attributeFilter:['hidden','class']});
    for(const section of this.main.querySelectorAll('.player-heading,.player-controls')){
      this.mutations.observe(section,{attributes:true,childList:true,characterData:true,subtree:true});
    }
    this.resize=new ResizeObserver(()=>this.reserveSpace());this.resize.observe(this.element);
    for(const event of ['playing','pause','volumechange','ended','emptied'])this.video.addEventListener(event,this.schedule);
    window.addEventListener('resize',this.schedule);
    this.sync();
  }
  schedule() {
    if(this.frame)return;
    this.frame=requestAnimationFrame(()=>{this.frame=null;this.sync();});
  }
  showMain() {
    if(this.main.hidden)return;
    if(this.main.classList.contains('compact'))$('#player-compact').click();
    this.main.scrollIntoView({behavior:'instant',block:'start'});
    $('#player-compact').focus({preventScroll:true});this.sync();
  }
  reserveSpace() {
    const space=this.element.hidden?0:Math.ceil(this.element.getBoundingClientRect().height)+30;
    document.documentElement.style.setProperty('--mini-player-space',space+'px');
  }
  sync() {
    const box=this.main.getBoundingClientRect(),active=!this.main.hidden&&!!this.player.queue[this.player.index];
    const outside=box.bottom<=0||box.top>=window.innerHeight;
    const show=active&&outside;
    if(!show&&!this.element.hidden&&this.element.contains(document.activeElement)&&active){
      const ids={'mini-player-toggle':'player-toggle','mini-player-prev':'player-prev','mini-player-next':'player-next','mini-player-original':'player-original'};
      const control=$('#'+(ids[document.activeElement.id]||'player-compact'));
      if(!outside)control.focus({preventScroll:true});
    }
    if(this.element.hidden===show){
      this.element.hidden=!show;
      document.body.classList.toggle('has-mini-player',show);
      this.reserveSpace();
    }
    if(!show)return;
    const title=$('#player-title').textContent;
    $('#mini-player-title').textContent=title;$('#mini-player-show').title='展开播放器：'+title;
    $('#mini-player-show').setAttribute('aria-label','展开播放器：'+title);
    $('#mini-player-position').textContent=$('#player-position').textContent;
    $('#mini-player-status').textContent=$('#player-status').textContent;
    const toggle=$('#mini-player-toggle');toggle.textContent=this.player.failed?'重试':this.video.paused?'播放':'暂停';
    toggle.setAttribute('aria-label',this.player.failed?'重试播放':this.video.paused?'播放':'暂停');
    toggle.disabled=!!this.player.loading||$('#player-toggle').disabled;
    $('#mini-player-prev').disabled=$('#player-prev').disabled;$('#mini-player-next').disabled=$('#player-next').disabled;
    const original=$('#mini-player-original'),mainOriginal=$('#player-original');
    original.href=mainOriginal.href;original.dataset.open=mainOriginal.dataset.open||'';
    const volume=Math.round(this.video.volume*100),muted=this.video.muted||this.video.volume===0;
    if(this.video.volume>0)this.lastVolume=this.video.volume;
    $('#mini-player-volume').value=String(volume);$('#mini-player-volume').setAttribute('aria-valuetext',volume+'%'+(muted?'，已静音':''));
    $('#mini-player-mute').textContent=muted?'有声':'静音';$('#mini-player-mute').setAttribute('aria-label',muted?'取消静音':'静音');
    $('#mini-player-mute').setAttribute('aria-pressed',String(muted));
  }
  destroy() {
    cancelAnimationFrame(this.frame);this.observer.disconnect();this.mutations.disconnect();this.resize.disconnect();
    for(const event of ['playing','pause','volumechange','ended','emptied'])this.video.removeEventListener(event,this.schedule);
    window.removeEventListener('resize',this.schedule);
    this.element.hidden=true;document.body.classList.remove('has-mini-player');this.reserveSpace();
  }
}
