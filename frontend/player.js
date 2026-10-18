import { $, $$, escape as e, icon, toast } from './ui.js';

export class PlaylistPlayer {
  constructor(api, parameters, selectedClips) {
    this.api=api;this.parameters=parameters;this.selectedClips=selectedClips;
    this.queue=[];this.index=-1;this.generation=0;this.queueRequest=0;this.segments=[];this.segment=0;this.editing=null;
    this.video=$('#song-video');
    $('#play-all').onclick=()=>this.fromResults();
    $('#play-selected').onclick=()=>this.start(this.selectedClips(),'选中片段');
    $('#playlist-new').onclick=()=>this.edit();
    $('#playlist-edit').onclick=()=>this.editSelected();
    $('#playlist-play').onclick=()=>this.playSaved();
    $('#playlist-select').onchange=()=>this.updatePlaylistButtons();
    $('#playlist-add-selected').onclick=()=>this.editSelected(this.selectedClips());
    $('#playlist-add-results').onclick=()=>this.addResults();
    $('#playlist-save').onsubmit=event=>{event.preventDefault();this.save();};
    $('#playlist-delete').onclick=()=>this.remove();
    $('#player-save').onclick=()=>this.edit({name:this.name,items:this.queue});
    $('#player-close').onclick=()=>this.stop();
    $('#player-prev').onclick=()=>this.play(this.index-1);
    $('#player-next').onclick=()=>this.play(this.index+1);
    $('#player-retry').onclick=()=>this.play(this.index);
    $('#player-resume').onclick=()=>this.resume(this.generation);
    $('#player-toggle').onclick=()=>{if(this.video.getAttribute('src'))this.video.paused?this.resume(this.generation):this.video.pause();};
    $('#player-compact').onclick=()=>{
      const compact=$('#music-player').classList.toggle('compact');
      $('#player-compact').textContent=compact?'展开播放器':'收起播放器';
      $('#player-compact').setAttribute('aria-expanded',String(!compact));
    };
    $('#player-queue').onclick=event=>{
      const button=event.target.closest('[data-queue-index]');
      if(button)this.play(Number(button.dataset.queueIndex));
    };
    $('#playlist-items').onclick=event=>this.editItem(event);
    this.video.addEventListener('ended',()=>{
      if(!this.video.ended||!this.segments.length)return;
      if(this.segment+1<this.segments.length){this.segment++;this.loadSegment(this.generation);}
      else if(this.index+1<this.queue.length)this.play(this.index+1);
      else this.status('歌单已播放完');
    });
    this.video.addEventListener('playing',()=>{this.status('正在播放');$('#player-resume').hidden=true;$('#player-toggle').textContent='暂停';});
    this.video.addEventListener('pause',()=>{if(this.segments.length&&!this.video.ended&&!this.loading)this.status('已暂停');$('#player-toggle').textContent='播放';});
    this.video.addEventListener('waiting',()=>{if(this.segments.length)this.status('正在缓冲…');});
    this.video.addEventListener('error',()=>{
      if(this.video.getAttribute('src')&&this.segments.length)this.failure('视频加载失败，请重试、选择下一首或打开原视频。');
    });
  }

  status(message) {$('#player-status').textContent=message;}
  failure(message) {this.loading=false;this.status(message);$('#player-retry').hidden=false;}
  async initialize() {await this.loadPlaylists();}
  async results() {
    const params=this.parameters();params.delete('page');params.delete('page_size');
    return (await this.api('/api/play-queue?'+params)).items;
  }
  async fromResults(id) {
    const request=++this.queueRequest;
    try {
      $('#play-all').disabled=true;
      const items=await this.results();
      if(request!==this.queueRequest)return;
      this.start(items,'当前筛选结果',id);
    } catch(error) {toast(error.message);}
    finally {if(request===this.queueRequest)$('#play-all').disabled=false;}
  }
  start(items,name,id) {
    ++this.queueRequest;$('#play-all').disabled=false;
    const seen=new Set();
    const playable=items.filter(item=>item.playback_url&&!seen.has(item.id)&&seen.add(item.id));
    if(!playable.length){toast('这个列表中还没有可播放的片段。');return;}
    if(id&&!playable.some(item=>item.id===id)){toast('此片段当前不可播放。');return;}
    this.queue=playable;this.name=name;
    $('#player-queue-name').textContent=name;
    $('#player-queue').innerHTML=playable.map((item,index)=>`<li><button data-queue-index="${index}"><span>${index+1}</span><b>${e(item.display_song_title)}</b><small>${e(item.uploader_name)}</small></button></li>`).join('');
    $('#music-player').hidden=false;
    if(items.length>playable.length)toast(`已跳过 ${items.length-playable.length} 个不可用或重复片段。`);
    this.play(id?playable.findIndex(item=>item.id===id):0);
  }
  async play(index) {
    if(index<0||index>=this.queue.length)return;
    const generation=++this.generation;
    this.abort?.abort();this.abort=new AbortController();
    this.index=index;this.segments=[];this.loading=true;
    this.video.pause();this.video.removeAttribute('src');this.video.load();
    const clip=this.queue[index];
    $('#player-title').textContent=clip.display_song_title;
    $('#player-position').textContent=`${index+1} / ${this.queue.length}`;
    $('#player-original').href=clip.playback_url;$('#player-original').dataset.open=clip.id;
    $('#player-prev').disabled=index===0;$('#player-next').disabled=index===this.queue.length-1;
    $('#player-retry').hidden=true;$('#player-resume').hidden=true;
    $$('#player-queue [aria-current]').forEach(button=>button.removeAttribute('aria-current'));
    const selected=$(`[data-queue-index="${index}"]`,$('#player-queue'));
    selected?.setAttribute('aria-current','true');
    if(selected){const list=$('#player-queue');list.scrollTop=selected.offsetTop-list.offsetTop-45;}
    this.status('正在读取视频…');
    try {
      const result=await this.api(`/api/clips/${encodeURIComponent(clip.id)}/play`,{method:'POST',signal:this.abort.signal});
      if(generation!==this.generation)return;
      if(!result.segments?.length||result.segments.some(part=>!/^\/api\/playback\/media\/[A-Za-z0-9_-]+$/.test(part.url)))throw new Error('播放地址异常，请打开原视频。');
      this.segments=result.segments;this.segment=0;
      this.loadSegment(generation);
    } catch(error) {
      if(generation!==this.generation||error.name==='AbortError')return;
      this.failure(error.message);
    }
  }
  loadSegment(generation) {
    if(generation!==this.generation)return;
    this.loading=false;this.video.src=this.segments[this.segment].url;
    this.resume(generation);
  }
  async resume(generation) {
    try {await this.video.play();}
    catch(error) {
      if(generation!==this.generation||error.name==='AbortError')return;
      if(error.name==='NotAllowedError'){
        this.status('点击播放，开始连续播放歌单');$('#player-resume').hidden=false;
      } else this.failure('暂时无法播放，请重试或打开原视频。');
    }
  }
  stop() {
    ++this.generation;++this.queueRequest;this.abort?.abort();this.segments=[];
    this.video.pause();this.video.removeAttribute('src');this.video.load();
    $('#music-player').hidden=true;$('#play-all').disabled=false;
  }
  async loadPlaylists(id) {
    const previous=id??$('#playlist-select').value;
    const result=await this.api('/api/playlists');
    $('#playlist-select').innerHTML='<option value="">我的歌单</option>'+result.items.map(list=>`<option value="${list.id}">${e(list.name)} (${list.count})</option>`).join('');
    if([...$('#playlist-select').options].some(option=>option.value===String(previous)))$('#playlist-select').value=String(previous);
    this.updatePlaylistButtons();
  }
  updatePlaylistButtons() {
    const empty=!$('#playlist-select').value;
    $('#playlist-play').disabled=empty;$('#playlist-edit').disabled=empty;
  }
  async playSaved() {
    const request=++this.queueRequest;
    try {
      const result=await this.api('/api/playlists/'+$('#playlist-select').value);
      if(request!==this.queueRequest)return;
      this.start(result.items,result.name);
    } catch(error) {toast(error.message);}
  }
  async editSelected(add=[]) {
    try {
      const id=$('#playlist-select').value;
      const result=id?await this.api('/api/playlists/'+id):null;
      this.edit(result,add);
    } catch(error) {toast(error.message);}
  }
  edit(list=null,add=[]) {
    this.editing={id:list?.id??null,name:list?.name??'',items:[...(list?.items??[])]};
    this.addItems(add);
    $('#playlist-name').value=this.editing.name;
    $('#playlist-error').textContent='';$('#playlist-delete').hidden=!this.editing.id;
    $('#playlist-dialog-title').textContent=this.editing.id?'编辑歌单':'新建歌单';
    this.renderEditing();$('#playlist-dialog').showModal();$('#playlist-name').focus();
  }
  addItems(items) {
    const ids=new Set(this.editing.items.map(item=>item.id));
    for(const item of items)if(!ids.has(item.id)){this.editing.items.push(item);ids.add(item.id);}
  }
  async addResults() {
    const edit=this.editing;
    try {
      $('#playlist-add-results').disabled=true;
      const items=await this.results();
      if(edit!==this.editing||!$('#playlist-dialog').open)return;
      this.addItems(items);this.renderEditing();
    } catch(error) {$('#playlist-error').textContent=error.message;}
    finally {$('#playlist-add-results').disabled=false;}
  }
  renderEditing() {
    const items=this.editing.items;
    $('#playlist-item-count').textContent=`${items.length} 首 · 按此顺序播放`;
    $('#playlist-items').innerHTML=items.length?items.map((item,index)=>`<li><span>${index+1}</span><b>${e(item.display_song_title)}${item.playback_url?'':' · 当前不可用'}</b><button type="button" class="icon-button" data-move="-1" data-item="${index}" aria-label="上移 ${e(item.display_song_title)}" ${index===0?'disabled':''}>↑</button><button type="button" class="icon-button" data-move="1" data-item="${index}" aria-label="下移 ${e(item.display_song_title)}" ${index===items.length-1?'disabled':''}>↓</button><button type="button" class="icon-button" data-remove="${index}" aria-label="移除 ${e(item.display_song_title)}">${icon('x')}</button></li>`).join(''):'<li class="muted">在列表中勾选歌曲后加入歌单，或添加当前筛选结果。</li>';
  }
  editItem(event) {
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.remove!==undefined)this.editing.items.splice(Number(button.dataset.remove),1);
    if(button.dataset.move){
      const from=Number(button.dataset.item),to=from+Number(button.dataset.move),items=this.editing.items;
      if(to>=0&&to<items.length)[items[from],items[to]]=[items[to],items[from]];
    }
    const scroll=$('#playlist-items').scrollTop;this.renderEditing();$('#playlist-items').scrollTop=scroll;
  }
  async save() {
    const edit=this.editing,name=$('#playlist-name').value.trim();
    if(!name){$('#playlist-error').textContent='请输入歌单名称。';return;}
    $('#playlist-save-button').disabled=true;
    try {
      const result=await this.api('/api/playlists'+(edit.id?'/'+edit.id:''),{
        method:edit.id?'PATCH':'POST',body:JSON.stringify({name,clip_ids:edit.items.map(item=>item.id)})});
      edit.id=result.id;
      await this.loadPlaylists(result.id);
      if(this.editing===edit)$('#playlist-dialog').close();
      toast('歌单已保存在此电脑。');
    } catch(error) {$('#playlist-error').textContent=error.message;}
    finally {$('#playlist-save-button').disabled=false;}
  }
  async remove() {
    if(!this.editing.id||!confirm('删除这个歌单？已采集的片段和收藏会保留。'))return;
    try {
      await this.api('/api/playlists/'+this.editing.id,{method:'DELETE'});
      $('#playlist-dialog').close();await this.loadPlaylists();toast('歌单已删除，片段仍然保留。');
    } catch(error) {$('#playlist-error').textContent=error.message;}
  }
}
