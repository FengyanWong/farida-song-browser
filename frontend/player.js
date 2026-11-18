import { $, $$, escape as e, icon, toast, writeClipboard } from './ui.js';
import { bindPlaylistDrag } from './playlist-drag.js';

export class PlaylistPlayer {
  constructor(api, parameters, selectedClips) {
    this.api=api;this.parameters=parameters;this.selectedClips=selectedClips;
    this.queue=[];this.index=-1;this.generation=0;this.queueRequest=0;this.segments=[];this.segment=0;this.editing=null;
    this.video=$('#song-video');this.preferencesReady=false;this.compact=false;
    this.shuffle=false;this.repeat='off';this.skipUnavailable=false;this.unavailable=new Set();this.logicalPlay=null;this.recoveryAttempts=0;this.resumePoint=null;this.visited=new Set();this.history=[];this.saveChain=Promise.resolve();
    $('#player-shuffle').onclick=()=>{this.shuffle=!this.shuffle;this.visited=new Set([this.index]);this.history=[];this.modeButtons();this.remember();};
    $('#player-skip-unavailable').onclick=()=>{this.skipUnavailable=!this.skipUnavailable;this.modeButtons();this.remember();};
    $('#player-repeat').onclick=()=>{this.repeat={off:'all',all:'one',one:'off'}[this.repeat];this.modeButtons();this.remember();};
    $('#player-remembered').onclick=()=>{const saved=this.saved;if(saved)this.start(saved.items,saved.name,saved.current_id,saved);};
    this.video.addEventListener('timeupdate',()=>{if(Date.now()-(this.lastSave||0)>5000)this.remember();});
    this.video.addEventListener('pause',()=>this.remember());
    this.video.addEventListener('volumechange',()=>this.schedulePreferences());
    window.addEventListener('pagehide',()=>{this.remember(true);this.persistPreferences();});
    $('#play-all').onclick=()=>this.fromResults();
    $('#play-selected').onclick=()=>this.start(this.selectedClips(),'选中片段');
    $('#playlist-new').onclick=()=>this.edit();
    $('#playlist-edit').onclick=()=>this.editSelected();
    $('#playlist-play').onclick=()=>this.playSaved();
    $('#playlist-select').onchange=()=>this.updatePlaylistButtons();
    $('#playlist-add-selected').onclick=()=>this.editSelected(this.selectedClips());
    $('#playlist-add-results').onclick=()=>this.addResults();
    $('#playlist-copy-links').onclick=()=>this.copyPlaylistLinks();
    $('#playlist-save').onsubmit=event=>{event.preventDefault();this.save();};
    $('#playlist-delete').onclick=()=>this.remove();
    $('#player-save').onclick=()=>this.edit({name:this.name,items:this.queue});
    $('#player-close').onclick=()=>this.stop();
    $('#player-prev').onclick=()=>this.previous();
    $('#player-next').onclick=()=>this.next(false);
    $('#player-retry').onclick=()=>this.retry();
    $('#player-resume').onclick=()=>this.resume(this.generation);
    $('#player-toggle').onclick=()=>{if(this.failed){this.retry();return;}if(this.video.getAttribute('src'))this.video.paused?this.resume(this.generation):this.video.pause();};
    $('#player-compact').onclick=()=>this.setCompact(!this.compact);
    $('#player-queue').onclick=event=>{
      const button=event.target.closest('[data-queue-index]');
      if(button)this.play(Number(button.dataset.queueIndex));
    };
    $('#playlist-items').onclick=event=>this.editItem(event);
    this.playlistDrag=bindPlaylistDrag($('#playlist-items'),{
      getItems:()=>this.editing?.items||[],
      onMove:(from,to)=>{
        const items=this.editing?.items;
        if(!items||from===to||from<0||to<0||from>=items.length||to>=items.length)return;
        items.splice(to,0,items.splice(from,1)[0]);this.renderEditing();
      }
    });
    this.bindSearch('player-queue-search','player-queue-clear',()=>this.renderQueue());
    this.bindSearch('playlist-search','playlist-search-clear',()=>this.renderEditing());
    this.video.addEventListener('ended',()=>{
      if(!this.video.ended||!this.segments.length)return;
      if(this.segment+1<this.segments.length){this.segment++;this.resumePoint={segment:this.segment,position:0};this.loadSegment(this.generation);}
      else this.next(true);
    });
    this.video.addEventListener('playing',()=>{
      if(!this.segments.length||this.loading||this.handlingFailure===this.generation)return;
      this.status('正在播放');$('#player-resume').hidden=true;$('#player-toggle').textContent='暂停';this.recordHistory();
    });
    this.video.addEventListener('pause',()=>{if(this.segments.length&&!this.video.ended&&!this.loading&&this.handlingFailure!==this.generation&&!this.failed)this.status('已暂停');$('#player-toggle').textContent='播放';});
    this.video.addEventListener('waiting',()=>{if(this.segments.length&&!this.failed&&this.handlingFailure!==this.generation)this.status('正在缓冲…');});
    this.video.addEventListener('error',()=>{
      if(this.video.getAttribute('src')&&this.segments.length)this.mediaFailure(this.generation);
    });
  }

  setCompact(compact,persist=true) {
    this.compact=!!compact;$('#music-player').classList.toggle('compact',this.compact);
    $('#player-compact').textContent=this.compact?'展开播放器':'收起播放器';
    $('#player-compact').setAttribute('aria-expanded',String(!this.compact));
    if(persist)this.persistPreferences();
  }
  preferences() {return {volume:this.video.volume,muted:this.video.muted,compact:this.compact};}
  schedulePreferences() {
    if(!this.preferencesReady)return;
    clearTimeout(this.preferencesTimer);this.preferencesTimer=setTimeout(()=>this.persistPreferences(),180);
  }
  persistPreferences() {
    clearTimeout(this.preferencesTimer);
    if(!this.preferencesReady||this.persistenceSuspended)return Promise.resolve();
    const body=JSON.stringify(this.preferences());
    if(body===this.lastPreferenceBody)return this.saveChain;
    const previous=this.lastPreferenceBody?JSON.parse(this.lastPreferenceBody):{};
    const values=this.preferences();
    const fields=Object.keys(values).filter(key=>values[key]!==previous[key]);
    this.lastPreferenceBody=body;
    const sequence=++this.preferenceSequence;
    const headers=this.preferenceWriter?{
      'X-Farida-Preference-Writer':this.preferenceWriter,
      'X-Farida-Preference-Sequence':String(sequence),
      'X-Farida-Preference-Fields':fields.join(',')
    }:{};
    // Start the small request immediately so closing the page cannot strand it
    // behind a pending queue save. The backend rejects older sequence numbers.
    const request=this.api('/api/player-preferences',{method:'PATCH',body,headers,keepalive:true}).catch(()=>{
      if(this.preferenceSequence===sequence)this.lastPreferenceBody=null;
    });
    this.saveChain=Promise.all([this.saveChain,request]).then(()=>{});
    return this.saveChain;
  }

  bindSearch(inputId,clearId,render) {
    const input=$('#'+inputId),clear=$('#'+clearId);
    const update=()=>{clear.hidden=!input.value;render();};
    input.oninput=update;
    input.onkeydown=event=>{
      if(event.key==='Enter')event.preventDefault();
      if(event.key==='Escape'&&input.value){event.preventDefault();event.stopPropagation();input.value='';update();}
    };
    clear.onclick=()=>{input.value='';update();input.focus();};
  }
  matchingItems(items,query) {
    const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('zh-CN');
    const terms=normalize(query).trim().split(/\s+/).filter(Boolean);
    const rows=items.map((item,index)=>({item,index}));
    if(!terms.length)return rows;
    return rows.filter(({item})=>{
      const text=normalize([item.display_song_title,item.uploader_name,item.raw_title,item.raw_part_title].join(' '));
      return terms.every(term=>text.includes(term));
    });
  }
  renderQueue() {
    const query=$('#player-queue-search').value,rows=this.matchingItems(this.queue,query);
    $('#player-queue-count').textContent=query.trim()?`${rows.length} / ${this.queue.length} 首`:`共 ${this.queue.length} 首`;
    $('#player-queue').innerHTML=rows.length?rows.map(({item,index})=>`<li><button data-queue-index="${index}" ${index===this.index?'aria-current="true"':''} title="${e(item.raw_title||item.display_song_title)}"><span>${index+1}</span><b>${e(item.display_song_title)}</b><small>${e(item.uploader_name)}</small></button></li>`).join(''):'<li class="playlist-search-empty">没有匹配的歌曲</li>';
  }
  status(message) {$('#player-status').textContent=message;}
  failure(message) {
    this.loading=false;this.failed=true;this.video.pause();this.status(message);$('#player-retry').hidden=false;
    $('#player-resume').hidden=true;$('#player-toggle').textContent='播放';this.remember();
  }
  position() {
    if(this.resumePoint)return {...this.resumePoint};
    return {segment:this.segment,position:Number.isFinite(this.video.currentTime)?this.video.currentTime:0};
  }
  retry(automatic=false) {
    if(!this.queue[this.index])return;
    const position=this.position();
    if(!automatic){this.recoveryAttempts=0;this.unavailable.delete(this.index);}
    return this.play(this.index,position,true);
  }
  async handleFailure(error,generation) {
    if(generation!==this.generation||error.name==='AbortError')return;
    this.handlingFailure=generation;this.resumePoint=this.position();this.video.pause();
    const category=error.category||(error.status===401?'authentication':error.status===429?'restricted':error instanceof TypeError?'network':'upstream');
    if(category==='network'&&this.recoveryAttempts<1){
      this.recoveryAttempts++;this.status('连接中断，正在恢复播放…');return this.retry(true);
    }
    if(this.skipUnavailable&&['unavailable','unsupported'].includes(category)){
      this.unavailable.add(this.index);
      const target=this.nextIndex(false,true);
      if(target!==undefined){this.history.push(this.index);return this.play(target);}
      this.failure('队列中已没有可继续播放的歌曲。可重试当前歌曲，或打开原视频。');return;
    }
    this.failure(error.message||'暂时无法播放，请重试或打开原视频。');
  }
  async mediaFailure(generation) {
    if(generation!==this.generation||this.handlingFailure===generation)return;
    this.handlingFailure=generation;this.resumePoint=this.position();this.video.pause();
    const code=this.video.error?.code,key=this.video.getAttribute('src')?.split('/').pop();
    let detail={};
    try {if(key)detail=await this.api('/api/playback/status/'+encodeURIComponent(key),{signal:this.abort.signal});}
    catch(error){if(error.name==='AbortError')return;detail={category:'network',message:'视频连接中断，请重试或打开原视频。'};}
    if(generation!==this.generation)return;
    const error=new Error(detail.message||((code===3||code===4)?'此视频格式暂不支持页面内播放，请打开原视频。':'视频连接中断，请重试或打开原视频。'));
    error.category=detail.category||((code===3||code===4)?'unsupported':'network');
    return this.handleFailure(error,generation);
  }
  async recordHistory() {
    const logical=this.logicalPlay;
    if(!logical||logical.recorded||logical.pending)return;
    logical.pending=true;logical.recorded=true;
    try {
      await this.api('/api/listening-history',{method:'POST',body:JSON.stringify({clip_id:logical.id})});
      document.dispatchEvent(new Event('farida-history-change'));
    } catch { /* A history write must not interrupt playback. */ }
    finally {logical.pending=false;}
  }
  async initialize() {
    await this.loadPlaylists();
    try {
      this.saved=await this.api('/api/player-state?compact=true');
      this.preferenceWriter=this.saved.preference_writer;this.preferenceSequence=0;
      this.video.volume=this.saved.volume??1;this.video.muted=!!this.saved.muted;
      this.setCompact(!!this.saved.compact,false);
      this.lastPreferenceBody=JSON.stringify(this.preferences());this.preferencesReady=true;
      this.shuffle=this.saved.shuffle;this.repeat=this.saved.repeat;this.skipUnavailable=!!this.saved.skip_unavailable;this.modeButtons();
      const clip=this.saved.items.find(item=>item.id===this.saved.current_id);
      if(clip){$('#player-remembered').textContent='继续播放：'+clip.display_song_title;$('#player-remembered').hidden=false;}
    } catch { /* Playback memory must not prevent opening the library. */ }
  }
  modeButtons() {
    $('#player-shuffle').textContent=this.shuffle?'随机：开':'随机：关';
    $('#player-shuffle').setAttribute('aria-pressed',String(this.shuffle));
    $('#player-repeat').textContent={off:'循环：关',all:'列表循环',one:'单曲循环'}[this.repeat];
    $('#player-skip-unavailable').textContent=this.skipUnavailable?'跳过失效：开':'跳过失效：关';
    $('#player-skip-unavailable').setAttribute('aria-pressed',String(this.skipUnavailable));
    $('#player-prev').disabled=this.shuffle?!this.history.length:this.index<=0;
    $('#player-next').disabled=!this.queue.length;
  }
  nextIndex(ended,skipping=false) {
    const allowed=index=>!(this.skipUnavailable&&this.unavailable.has(index));
    if(ended&&this.repeat==='one'&&!skipping&&allowed(this.index))return this.index;
    if(this.shuffle){
      let choices=this.queue.map((_,i)=>i).filter(i=>allowed(i)&&!this.visited.has(i));
      if(!choices.length&&this.repeat==='all'){
        this.visited=new Set([this.index]);
        choices=this.queue.map((_,i)=>i).filter(i=>allowed(i)&&i!==this.index);
        if(!choices.length&&allowed(this.index)&&!skipping)choices=[this.index];
      }
      return choices.length?choices[Math.floor(Math.random()*choices.length)]:undefined;
    }
    for(let i=this.index+1;i<this.queue.length;i++)if(allowed(i))return i;
    if(this.repeat==='all')for(let i=0;i<=this.index;i++)if(allowed(i))return i;
    return undefined;
  }
  next(ended) {
    if(!this.queue.length)return;
    const target=this.nextIndex(ended);
    if(target===undefined){this.status('歌单已播放完');this.remember();return;}
    if(target!==this.index)this.history.push(this.index);
    this.play(target);
  }
  previous() {
    const target=this.shuffle?this.history.pop():this.index-1;
    if(target!==undefined&&target>=0){this.visited.delete(this.index);this.play(target);}
  }
  remember(keepalive=false) {
    const current=this.queue[this.index];
    if(this.persistenceSuspended||!current||this.loading||(!this.segments.length&&!this.failed)){
      return this.saveChain;
    }
    this.lastSave=Date.now();
    const queueSave=this.queueSave;
    const sequence=++queueSave.sequence;
    const progress={current_id:current.id,...this.position(),shuffle:this.shuffle,
      repeat:this.repeat,skip_unavailable:this.skipUnavailable};
    const queue=this.queue,name=this.name,preferences=this.preferences();
    const save=async()=>{
      if(this.persistenceSuspended)return;
      if(queueSave.key){
        const body=JSON.stringify({...progress,queue_key:queueSave.key,sequence});
        await this.api('/api/player-state',{method:'PATCH',body,keepalive});
      }else{
        // Send the full order only when establishing a queue (including a resumed queue).
        const body=JSON.stringify({name,clip_ids:queue.map(item=>item.id),...progress,...preferences});
        const headers=this.preferenceWriter?{'X-Farida-Preference-Writer':this.preferenceWriter}:{};
        const result=await this.api('/api/player-state',{method:'PUT',body,headers,keepalive:keepalive&&body.length<50000});
        queueSave.key=result.queue_key;
      }
    };
    if(keepalive&&queueSave.key)return save().catch(()=>{});
    this.saveChain=this.saveChain.then(save).catch(()=>{});
    return this.saveChain;
  }
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
  start(items,name,id,resume=null) {
    ++this.queueRequest;$('#play-all').disabled=false;
    const seen=new Set();
    const playable=items.filter(item=>item.playback_url&&!seen.has(item.id)&&seen.add(item.id));
    if(!playable.length){toast('这个列表中还没有可播放的片段。');return;}
    if(id&&!playable.some(item=>item.id===id)){toast('此片段当前不可播放。');return;}
    this.remember();this.segments=[];
    this.queueSave={key:null,sequence:0};
    this.queue=playable;this.name=name;this.visited=new Set();this.history=[];this.unavailable=new Set();
    $('#player-remembered').hidden=true;
    $('#player-queue-name').textContent=name;
    $('#player-queue-search').value='';$('#player-queue-clear').hidden=true;
    this.index=-1;this.renderQueue();
    $('#music-player').hidden=false;
    if(items.length>playable.length)toast(`已跳过 ${items.length-playable.length} 个不可用或重复片段。`);
    this.play(id?playable.findIndex(item=>item.id===id):0,resume);
  }
  async play(index,resume=null,recovering=false) {
    if(index<0||index>=this.queue.length)return;
    this.remember();
    const generation=++this.generation;
    this.abort?.abort();this.abort=new AbortController();
    this.index=index;this.visited.add(index);this.segments=[];this.loading=true;this.failed=false;this.handlingFailure=null;
    if(!recovering){this.logicalPlay={id:this.queue[index].id,recorded:false,pending:false};this.recoveryAttempts=0;}
    this.resumePoint={segment:resume?.segment||0,position:resume?.position||0};
    this.video.pause();this.video.removeAttribute('src');this.video.load();
    const clip=this.queue[index];
    $('#player-title').textContent=clip.display_song_title;
    $('#player-position').textContent=`${index+1} / ${this.queue.length}`;
    $('#player-original').href=clip.playback_url;$('#player-original').dataset.open=clip.id;
    this.modeButtons();
    $('#player-retry').hidden=true;$('#player-resume').hidden=true;
    $$('#player-queue [aria-current]').forEach(button=>button.removeAttribute('aria-current'));
    const selected=$(`[data-queue-index="${index}"]`,$('#player-queue'));
    selected?.setAttribute('aria-current','true');
    if(selected){const list=$('#player-queue');list.scrollTop=selected.offsetTop-list.offsetTop-45;}
    this.status('正在读取视频…');
    try {
      const result=await this.api(`/api/clips/${encodeURIComponent(clip.id)}/play`,{method:'POST',signal:this.abort.signal});
      if(generation!==this.generation)return;
      if(!result.segments?.length||result.segments.some(part=>!/^\/api\/playback\/media\/[A-Za-z0-9_-]+$/.test(part.url)))throw Object.assign(new Error('播放地址异常，请打开原视频。'),{category:'upstream'});
      this.segments=result.segments;this.segment=Math.min(resume?.segment||0,this.segments.length-1);
      this.seekPosition=resume?.position||0;
      this.loadSegment(generation);
    } catch(error) {
      if(generation!==this.generation||error.name==='AbortError')return;
      this.handleFailure(error,generation);
    }
  }
  loadSegment(generation) {
    if(generation!==this.generation)return;
    this.loading=false;
    const position=this.seekPosition||0;this.seekPosition=0;
    this.video.onloadedmetadata=()=>{
      if(generation!==this.generation)return;
      if(position>0){
        const maximum=Number.isFinite(this.video.duration)?Math.max(0,this.video.duration-0.1):position;
        this.video.currentTime=Math.min(position,maximum);
      }
      this.resumePoint=null;this.remember();
    };
    this.video.src=this.segments[this.segment].url;
    this.resume(generation);
  }
  async resume(generation) {
    try {await this.video.play();}
    catch(error) {
      if(generation!==this.generation||error.name==='AbortError')return;
      if(error.name==='NotAllowedError'){
        this.status('点击播放，开始连续播放歌单');$('#player-resume').hidden=false;
      } else if(this.video.error)this.mediaFailure(generation);
      else this.handleFailure(Object.assign(new Error('暂时无法播放，请重试或打开原视频。'),{category:error.name==='NotSupportedError'?'unsupported':'network'}),generation);
    }
  }
  stop() {
    this.persistPreferences();this.remember();
    ++this.generation;++this.queueRequest;this.abort?.abort();this.segments=[];this.logicalPlay=null;this.handlingFailure=null;this.failed=false;
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
    $('#playlist-search').value='';$('#playlist-search-clear').hidden=true;
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
  async copyPlaylistLinks() {
    const edit = this.editing;
    const links = edit.items.map(item => item.playback_url).filter(Boolean);
    const skipped = edit.items.length - links.length;
    const status = $('#playlist-copy-status');
    const fallback = $('#playlist-copy-text');
    fallback.hidden = true;
    const suffix = skipped ? `，跳过 ${skipped} 个不可用片段` : '';
    if (!links.length) {
      status.textContent = '没有可复制的链接' + suffix + '。';
      return;
    }
    const text = links.join('\n');
    const copied = await writeClipboard(text);
    if (edit !== this.editing || !$('#playlist-dialog').open) return;
    if (copied) {
      status.textContent = `已复制 ${links.length} 个链接${suffix}。`;
    } else {
      status.textContent = `请手动复制以下 ${links.length} 个链接${suffix}。`;
      fallback.value = text;
      fallback.hidden = false;
      fallback.focus();
      fallback.select();
    }
  }
  renderEditing() {
    this.playlistDrag?.cancel();
    $('#playlist-copy-links').disabled = !this.editing.items.length;
    $('#playlist-copy-status').textContent = '';
    $('#playlist-copy-text').hidden = true;
    $('#playlist-copy-text').value = '';
    const items=this.editing.items,query=$('#playlist-search').value,rows=this.matchingItems(items,query);
    $('#playlist-item-count').textContent=query.trim()?`${rows.length} / ${items.length} 首 · 仅筛选显示`:`${items.length} 首 · 按此顺序播放`;
    $('#playlist-items').innerHTML=rows.length?rows.map(({item,index})=>`<li><button type="button" class="playlist-drag-handle" data-drag-index="${index}" aria-label="拖动调整 ${e(item.display_song_title)} 的顺序" title="拖动调整顺序">⠿</button><span>${index+1}</span><b title="${e(item.raw_title||item.display_song_title)}">${e(item.display_song_title)}${item.playback_url?'':' · 当前不可用'}<small>${e(item.uploader_name)}</small></b><button type="button" class="icon-button" data-move="-1" data-item="${index}" aria-label="上移 ${e(item.display_song_title)}" ${index===0?'disabled':''}>↑</button><button type="button" class="icon-button" data-move="1" data-item="${index}" aria-label="下移 ${e(item.display_song_title)}" ${index===items.length-1?'disabled':''}>↓</button><button type="button" class="icon-button" data-remove="${index}" aria-label="移除 ${e(item.display_song_title)}">${icon('x')}</button></li>`).join(''):`<li class="playlist-search-empty">${items.length?'没有匹配的歌曲':'在列表中勾选歌曲后加入歌单，或添加当前筛选结果。'}</li>`;
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
