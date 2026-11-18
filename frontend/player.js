import { $, $$, escape as e, icon, toast, writeClipboard } from './ui.js';
import { bindPlaylistDrag } from './playlist-drag.js';

const maxPlaylistItems = 20000;

export class PlaylistPlayer {
  constructor(api, parameters, selectedClips, canPlay) {
    this.canPlay=canPlay;
    this.api=api;this.parameters=parameters;this.selectedClips=selectedClips;
    this.queue=[];this.index=-1;this.generation=0;this.queueRequest=0;this.segments=[];this.segment=0;this.editing=null;
    this.playlistListRequest=0;this.editRequest=0;
    this.video=$('#song-video');this.preferencesReady=false;this.compact=false;
    this.shuffle=false;this.repeat='off';this.skipUnavailable=false;this.unavailable=new Set();this.logicalPlay=null;this.recoveryAttempts=0;this.resumePoint=null;this.visited=new Set();this.history=[];this.saveChain=Promise.resolve();
    $('#player-shuffle').onclick=()=>{this.shuffle=!this.shuffle;this.visited=new Set([this.index]);this.history=[];this.modeButtons();this.remember();};
    $('#player-skip-unavailable').onclick=()=>{this.skipUnavailable=!this.skipUnavailable;this.modeButtons();this.remember();};
    $('#player-repeat').onclick=()=>{this.repeat={off:'all',all:'one',one:'off'}[this.repeat];this.modeButtons();this.remember();};
    $('#player-remembered').onclick=()=>this.resumeRemembered();
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
    $('#playlist-import-add').onclick=()=>this.importPlaylistLinks();
    $('#playlist-import-text').oninput=()=>{if(this.editing)this.editing.linksChecked=false;};
    $('#playlist-save').onsubmit=event=>{event.preventDefault();this.save();};
    $('#playlist-delete').onclick=()=>this.remove();
    $('#playlist-save-copy').onclick=()=>this.save(true);
    $('#playlist-reload').onclick=()=>this.reloadPlaylist();
    const editor = $('#playlist-dialog');
    const hasDraft = () => this.hasPlaylistChanges() || !!$('#playlist-import-text').value.trim();
    this.warnBeforeUnload = event => {
      if (editor.open && hasDraft()) {
        event.preventDefault();
        event.returnValue = true;
      }
    };
    const discard = () => {
      if (this.editing?.saving) return confirm('歌单操作尚未完成，关闭编辑器？');
      return !hasDraft() || confirm('放弃未保存的歌单修改？');
    };
    editor.addEventListener('cancel', event => { if (!discard()) event.preventDefault(); });
    editor.addEventListener('click', event => {
      if (event.target.closest('.close-dialog') && !discard()) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    editor.addEventListener('close', () => {
      if (!editor.open) {
        window.removeEventListener('beforeunload', this.warnBeforeUnload);
        this.editing = null;
        if (this.refreshListsOnClose) this.loadPlaylists().catch(error=>toast(error.message));
      }
    });
    $('#player-save').onclick=()=>this.edit({name:this.name,items:this.queue});
    $('#player-close').onclick=()=>this.stop(true);
    $('#player-prev').onclick=()=>this.previous();
    $('#player-next').onclick=()=>this.next(false);
    $('#player-retry').onclick=()=>this.retry();
    $('#player-resume').onclick=()=>this.resume(this.generation);
    $('#player-toggle').onclick=()=>{if(this.failed){this.retry();return;}if(this.video.getAttribute('src'))this.video.paused?this.resume(this.generation):this.video.pause();};
    $('#player-compact').onclick=()=>this.setCompact(!this.compact);
    const queueList = $('#player-queue');
    queueList.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End');
    queueList.addEventListener('focusin', event => this.setQueueTabStop(event.target.closest('[data-queue-index]')));
    queueList.onkeydown = event => {
      const row = event.target.closest('[data-queue-index]')?.parentElement;
      if (!row || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      let next;
      switch (event.key) {
        case 'ArrowUp': next = row.previousElementSibling; break;
        case 'ArrowDown': next = row.nextElementSibling; break;
        case 'Home': next = queueList.firstElementChild; break;
        case 'End': next = queueList.lastElementChild; break;
        default: return;
      }
      event.preventDefault();
      next?.querySelector('button')?.focus();
    };
    queueList.onclick=event=>{
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
    let composing=false;
    const update=()=>{
      clear.hidden=!input.value;
      if(input.dataset.appliedQuery!==input.value)render();
    };
    input.addEventListener('compositionstart',()=>{composing=true;});
    input.addEventListener('compositionend',()=>{composing=false;update();});
    input.oninput=event=>{if(!composing&&!event.isComposing)update();};
    input.onkeydown=event=>{
      if(composing||event.isComposing||event.keyCode===229)return;
      if(event.key==='Enter')event.preventDefault();
      if(event.key==='Escape'&&input.value){event.preventDefault();event.stopPropagation();input.value='';update();}
    };
    clear.onclick=()=>{input.value='';update();input.focus();};
  }
  matchingItems(items,query) {
    const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('zh-CN')
      .replace(/fareeda|farida|法里達/g,'法里达');
    const terms=normalize(query).trim().split(/\s+/).filter(Boolean);
    const rows=items.map((item,index)=>({item,index}));
    if(!terms.length)return rows;
    return rows.filter(({item})=>{
      const text=normalize([item.display_song_title,item.uploader_name,item.raw_title,item.raw_part_title].join(' '));
      return terms.every(term=>text.includes(term));
    });
  }
  setQueueTabStop(button) {
    if (this.queueTabStop === button) return;
    if (this.queueTabStop) this.queueTabStop.tabIndex = -1;
    if (button) button.tabIndex = 0;
    this.queueTabStop = button;
  }
  renderQueue() {
    const input=$('#player-queue-search'),query=input.value,rows=this.matchingItems(this.queue,query);
    input.dataset.appliedQuery=query;
    $('#player-queue-count').textContent=query.trim()?`${rows.length} / ${this.queue.length} 首`:`共 ${this.queue.length} 首`;
    const list = $('#player-queue'), hadFocus = list.contains(document.activeElement);
    list.innerHTML=rows.length?rows.map(({item,index})=>`<li><button tabindex="-1" data-queue-index="${index}" ${index===this.index?'aria-current="true"':''} title="${e(item.raw_title||item.display_song_title)}"><span>${index+1}</span><b>${e(item.display_song_title)}</b><small>${e(item.uploader_name)}</small></button></li>`).join(''):'<li class="playlist-search-empty">没有匹配的歌曲</li>';
    this.setQueueTabStop(list.querySelector('[aria-current]') || list.querySelector('button'));
    if (hadFocus) (this.queueTabStop || $('#player-queue-search')).focus();
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
    if(!this.canPlay()||!this.queue[this.index])return;
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
    if(this.persistenceSuspended||!logical||logical.recorded||logical.pending)return;
    logical.pending=true;logical.recorded=true;
    try {
      await this.api('/api/listening-history',{method:'POST',body:JSON.stringify({clip_id:logical.id})});
      document.dispatchEvent(new Event('farida-history-change'));
    } catch { /* A history write must not interrupt playback. */ }
    finally {logical.pending=false;}
  }
  async initialize() {
    const lists=this.loadPlaylists().catch(()=>toast('暂时无法读取本地歌单。刷新页面可重试。'));
    try {
      this.saved=await this.api('/api/player-state?compact=true');
      this.preferenceWriter=this.saved.preference_writer;this.preferenceSequence=0;
      this.video.volume=this.saved.volume??1;this.video.muted=!!this.saved.muted;
      this.setCompact(!!this.saved.compact,false);
      this.lastPreferenceBody=JSON.stringify(this.preferences());this.preferencesReady=true;
      this.shuffle=this.saved.shuffle;this.repeat=this.saved.repeat;this.skipUnavailable=!!this.saved.skip_unavailable;this.modeButtons();
      this.updateResumeButton();
    } catch { /* Playback memory must not prevent opening the library. */ }
    await lists;
  }
  updateResumeButton() {
    const button=$('#player-remembered');
    const canShow=this.saved && !this.persistenceSuspended && this.canPlay() && $('#music-player').hidden;
    const clip=canShow && (this.saved.items===this.queue ? this.queue[this.index]
      : this.saved.items.find(item=>item.id===this.saved.current_id));
    button.hidden=!clip;
    if (clip) button.textContent='继续播放：'+clip.display_song_title;
  }
  resumeRemembered() {
    const saved=this.saved;
    if (!saved || this.persistenceSuspended || !this.canPlay()) return;
    if (saved.items===this.queue) {
      // The queue, its progress key, shuffle history and search results are still in memory.
      this.saved=null;
      $('#player-remembered').hidden=true;
      $('#music-player').hidden=false;
      this.logicalPlay=saved.logicalPlay;
      this.recoveryAttempts=0;
      this.play(this.index,saved,!!this.logicalPlay);
    } else {
      this.start(saved.items,saved.name,saved.current_id,saved);
    }
    if (!$('#music-player').hidden) $('#player-compact').focus({preventScroll:true});
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
    if(!this.canPlay()||!this.queue.length)return;
    const target=this.nextIndex(ended);
    if(target===undefined){this.status('歌单已播放完');this.remember();return;}
    if(target!==this.index)this.history.push(this.index);
    this.play(target);
  }
  previous() {
    if (!this.canPlay()) return;
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
    if(keepalive&&queueSave.key){
      const finalSave=save().catch(()=>{});
      this.saveChain=Promise.all([this.saveChain,finalSave]).then(()=>{});
      return finalSave;
    }
    this.saveChain=this.saveChain.then(save).catch(()=>{});
    return this.saveChain;
  }
  async results() {
    const params=this.parameters();params.delete('page');params.delete('page_size');
    return (await this.api('/api/play-queue?'+params)).items;
  }
  async fromResults(id) {
    if (!this.canPlay()) return;
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
    if (!this.canPlay()) return;
    ++this.queueRequest;$('#play-all').disabled=false;
    const seen=new Set();
    const playable=items.filter(item=>item.playback_url&&!seen.has(item.id)&&seen.add(item.id));
    if(!playable.length){toast('这个列表中还没有可播放的片段。');return;}
    if(id&&!playable.some(item=>item.id===id)){toast('此片段当前不可播放。');return;}
    this.remember();this.segments=[];
    this.queueSave={key:null,sequence:0};
    this.saved=null;
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
    if(!this.canPlay()||index<0||index>=this.queue.length)return;
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
    const list=$('#player-queue'), selected=$(`[data-queue-index="${index}"]`,list);
    selected?.setAttribute('aria-current','true');
    // When browsing with the keyboard, automatic playback keeps the focused row in view.
    if (selected && !list.contains(document.activeElement)) {
      this.setQueueTabStop(selected);
      list.scrollTop=selected.offsetTop-list.offsetTop-45;
    }
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
    if (generation!==this.generation || !this.canPlay()) return;
    try {await this.video.play();}
    catch(error) {
      if(generation!==this.generation||error.name==='AbortError')return;
      if(error.name==='NotAllowedError'){
        this.status('点击播放，开始连续播放歌单');$('#player-resume').hidden=false;
      } else if(this.video.error)this.mediaFailure(generation);
      else this.handleFailure(Object.assign(new Error('暂时无法播放，请重试或打开原视频。'),{category:error.name==='NotSupportedError'?'unsupported':'network'}),generation);
    }
  }
  stop(keepResume=false) {
    const panel=$('#music-player'), remembered=$('#player-remembered'), current=this.queue[this.index];
    if (keepResume && !this.persistenceSuspended) {
      if (current && !panel.hidden)
        this.saved={items:this.queue,current_id:current.id,logicalPlay:this.logicalPlay,...this.position()};
    } else if (!panel.hidden || this.saved?.items===this.queue) {
      this.saved=null;
    }
    this.persistPreferences();
    // Closing removes the media source, so pagehide cannot capture this checkpoint later.
    this.remember(keepResume);
    ++this.generation;++this.queueRequest;this.abort?.abort();this.segments=[];this.logicalPlay=null;this.handlingFailure=null;this.failed=false;
    this.video.pause();this.video.removeAttribute('src');this.video.load();
    panel.hidden=true;$('#play-all').disabled=false;
    if (keepResume) {
      this.updateResumeButton();
      if (!remembered.hidden) remembered.focus({preventScroll:true});
    } else remembered.hidden=true;
  }
  async loadPlaylists(id, editor) {
    this.refreshListsOnClose=false;
    const select=$('#playlist-select'), initial=select.value, request=++this.playlistListRequest;
    const result=await this.api('/api/playlists');
    if (request!==this.playlistListRequest) return;
    const previous=id!=null && (!editor || this.currentEditor(editor)) && initial===select.value ? id : select.value;
    select.innerHTML='<option value="">我的歌单</option>'+result.items.map(list=>`<option value="${list.id}">${e(list.name)} (${list.count})</option>`).join('');
    if([...$('#playlist-select').options].some(option=>option.value===String(previous)))$('#playlist-select').value=String(previous);
    this.updatePlaylistButtons();
  }
  updatePlaylistButtons() {
    const empty=!$('#playlist-select').value;
    $('#playlist-play').disabled=empty;$('#playlist-edit').disabled=empty;
  }
  async playSaved() {
    if (!this.canPlay()) return;
    const request=++this.queueRequest;
    try {
      const result=await this.api('/api/playlists/'+$('#playlist-select').value);
      if(request!==this.queueRequest)return;
      this.start(result.items,result.name);
    } catch(error) {toast(error.message);}
  }
  async editSelected(add=[]) {
    const id=$('#playlist-select').value, request=++this.editRequest;
    try {
      const result=id?await this.api('/api/playlists/'+id):null;
      if(request===this.editRequest && id===$('#playlist-select').value) this.edit(result,add);
    } catch(error) {
      if (request!==this.editRequest || id!==$('#playlist-select').value) return;
      toast(error.message);
      if (error.status===404) this.loadPlaylists().catch(error=>toast(error.message));
    }
  }
  async refreshAfterPlaylistChange(edit) {
    if (this.editing!==edit && $('#playlist-dialog').open) this.refreshListsOnClose=true;
    else await this.loadPlaylists();
  }
  currentEditor(edit) {return edit===this.editing && $('#playlist-dialog').open;}
  updateEditorActions() {
    const edit=this.editing, busy=!!(edit.saving || edit.resolving);
    $('#playlist-import-text').readOnly=busy;
    $('#playlist-import-add').disabled=busy;
    $('#playlist-save-button').disabled=busy;
    $('#playlist-save-button').hidden=!!edit.conflict;
    $('#playlist-delete').hidden=!edit.id || !!edit.conflict;
    $('#playlist-delete').disabled=busy;
    $('#playlist-save-copy').hidden=!edit.conflict;
    $('#playlist-save-copy').disabled=busy;
    $('#playlist-reload').hidden=!edit.conflict || !!edit.deleted;
    $('#playlist-reload').disabled=busy;
  }
  hasPlaylistChanges() {
    const edit = this.editing;
    if (!edit) return false;
    return $('#playlist-name').value.trim() !== edit.savedName ||
      edit.items.length !== edit.savedIds.length ||
      edit.items.some((item, index) => item.id !== edit.savedIds[index]);
  }
  edit(list=null,add=[]) {
    if ($('#playlist-dialog').open) return;
    ++this.editRequest;
    this.setDraft(list,add);
    $('#playlist-dialog').showModal();$('#playlist-name').focus();
    window.addEventListener('beforeunload', this.warnBeforeUnload);
  }
  setDraft(list, add=[]) {
    const items = list?.items ?? [];
    this.editing = {id:list?.id ?? null, revision:list?.revision, savedName:list?.name ?? '',
                    savedIds:items.map(item=>item.id), items:[...items]};
    this.addItems(add);
    $('#playlist-import').open=false;
    $('#playlist-import-text').value='';
    $('#playlist-import-status').textContent='';
    $('#playlist-add-results').disabled=false;
    this.updateEditorActions();
    $('#playlist-search').value='';$('#playlist-search-clear').hidden=true;
    $('#playlist-name').value=this.editing.savedName;
    $('#playlist-error').textContent='';
    $('#playlist-dialog-title').textContent=this.editing.id?'编辑歌单':'新建歌单';
    this.renderEditing();
  }
  addItems(items, limit=Infinity) {
    const current=this.editing.items, ids=new Set(current.map(item=>item.id));
    let added=0, existing=0, overflow=0;
    for (const item of items) {
      if (ids.has(item.id)) { existing++; continue; }
      if (current.length>=limit) { overflow++; continue; }
      current.push(item);ids.add(item.id);added++;
    }
    return {added,existing,overflow};
  }
  async importPlaylistLinks() {
    const edit=this.editing, input=$('#playlist-import-text'), status=$('#playlist-import-status');
    if (!edit || edit.resolving || edit.saving) return;
    const links=input.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    if (!links.length) {
      status.textContent='请先粘贴视频链接或 BV 号。';input.focus();return;
    }
    if (links.length>maxPlaylistItems || links.some(line=>line.length>2048 && [...line].length>2048)) {
      status.textContent='每次最多添加 20,000 行，每行最多 2,048 个字符。';return;
    }
    edit.resolving=true;
    this.updateEditorActions();
    status.textContent='正在查找本机片段…';
    try {
      const result=await this.api('/api/playlists/resolve-links',{method:'POST',body:JSON.stringify({links})});
      if (edit!==this.editing || !$('#playlist-dialog').open) return;
      const {added,existing,overflow}=this.addItems(result.items,maxPlaylistItems);
      if (added) this.renderEditing();
      const counts=[`已加入 ${added} 首`];
      if (existing) counts.push(`歌单已有 ${existing} 首`);
      if (result.duplicates) counts.push(`重复输入 ${result.duplicates} 行`);
      if (result.invalid) counts.push(`格式无效 ${result.invalid} 行`);
      if (result.missing) counts.push(`本机未找到 ${result.missing} 行`);
      if (result.unavailable) counts.push(`不可播放 ${result.unavailable} 行`);
      if (overflow) counts.push(`歌单已满，另有 ${overflow} 首未加入`);
      status.textContent=counts.join('，')+'。';
      if (!overflow && !result.invalid && !result.missing && !result.unavailable) input.value='';
      edit.linksChecked=true;
    } catch (error) {
      if (edit===this.editing && $('#playlist-dialog').open) status.textContent=error.message;
    } finally {
      edit.resolving=false;
      if (this.currentEditor(edit)) this.updateEditorActions();
    }
  }
  async addResults() {
    const edit=this.editing;
    try {
      $('#playlist-add-results').disabled=true;
      const items=await this.results();
      if(edit!==this.editing||!$('#playlist-dialog').open)return;
      this.addItems(items);this.renderEditing();
    } catch(error) {if(this.currentEditor(edit))$('#playlist-error').textContent=error.message;}
    finally {if(this.currentEditor(edit))$('#playlist-add-results').disabled=false;}
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
    const input=$('#playlist-search'),query=input.value,items=this.editing.items,rows=this.matchingItems(items,query);
    input.dataset.appliedQuery=query;
    $('#playlist-item-count').textContent=query.trim()?`${rows.length} / ${items.length} 首 · 仅筛选显示`:`${items.length} 首 · 按此顺序播放`;
    $('#playlist-items').innerHTML=rows.length?rows.map(({item,index})=>`<li><button type="button" class="playlist-drag-handle" data-drag-index="${index}" aria-label="拖动调整 ${e(item.display_song_title)} 的顺序" title="拖动调整顺序">⠿</button><span>${index+1}</span><b title="${e(item.raw_title||item.display_song_title)}">${e(item.display_song_title)}${item.playback_url?'':' · 当前不可用'}<small>${e(item.uploader_name)}</small></b><button type="button" class="icon-button" data-move="-1" data-item="${index}" aria-label="上移 ${e(item.display_song_title)}" ${index===0?'disabled':''}>↑</button><button type="button" class="icon-button" data-move="1" data-item="${index}" aria-label="下移 ${e(item.display_song_title)}" ${index===items.length-1?'disabled':''}>↓</button><button type="button" class="icon-button" data-remove="${index}" aria-label="移除 ${e(item.display_song_title)}">${icon('x')}</button></li>`).join(''):`<li class="playlist-search-empty">${items.length?'没有匹配的歌曲':'在列表中勾选歌曲后加入歌单，或添加当前筛选结果。'}</li>`;
  }
  editItem(event) {
    const button=event.target.closest('button[data-move], button[data-remove]');
    if (!button || button.disabled) return;
    const list=$('#playlist-items'), items=this.editing.items;
    const keepFocus=document.activeElement===button, scroll=list.scrollTop;
    let targetSelector;
    if (button.dataset.remove!==undefined) {
      const index=Number(button.dataset.remove), row=button.closest('li');
      const neighbor=row.nextElementSibling || row.previousElementSibling;
      if (neighbor) {
        const previousIndex=Number(neighbor.querySelector('[data-remove]').dataset.remove);
        targetSelector=`[data-remove="${previousIndex > index ? previousIndex-1 : previousIndex}"]`;
      }
      items.splice(index,1);
    } else {
      const from=Number(button.dataset.item), to=from+Number(button.dataset.move);
      [items[from],items[to]]=[items[to],items[from]];
      const direction=(to===0 || to===items.length-1) ? -Number(button.dataset.move) : Number(button.dataset.move);
      targetSelector=`[data-item="${to}"][data-move="${direction}"]`;
    }
    this.renderEditing();
    list.scrollTop=scroll;
    if (keepFocus) {
      const next=targetSelector && list.querySelector(targetSelector);
      (next || $('#playlist-search')).focus({preventScroll:true});
    }
  }
  showEditorError(edit,error) {
    if (!this.currentEditor(edit)) return;
    if (error.status===409 && error.category==='playlist_conflict') {
      edit.conflict=true;
      $('#playlist-error').textContent='原歌单已被其他页面修改或删除。本页修改已保留，可另存为新歌单或载入已保存版本。';
      $('#playlist-error').focus();
    } else $('#playlist-error').textContent=error.message;
  }
  revisionHeaders(edit) {
    if (!edit.revision) throw Error('无法确认歌单版本，请重新打开歌单。');
    return {'X-Farida-Playlist-Revision':edit.revision};
  }
  async reloadPlaylist() {
    const edit=this.editing;
    if (!edit?.conflict || edit.saving || edit.resolving) return;
    edit.saving=true;this.updateEditorActions();
    try {
      const result=await this.api('/api/playlists/'+edit.id);
      if (this.currentEditor(edit) && confirm('放弃本页歌单修改，载入已保存版本？')) {
        this.setDraft(result);$('#playlist-name').focus();
      }
    } catch(error) {
      if (!this.currentEditor(edit)) return;
      if (error.status===404) {
        edit.deleted=true;this.refreshListsOnClose=true;
        $('#playlist-error').textContent='原歌单已被删除。本页修改已保留，可另存为新歌单。';
      } else this.showEditorError(edit,error);
    } finally {
      edit.saving=false;if(this.currentEditor(edit))this.updateEditorActions();
    }
  }
  async save(asCopy=false) {
    const edit=this.editing,name=$('#playlist-name').value.trim();
    if (!edit || edit.saving || edit.resolving || asCopy!==!!edit.conflict) return;
    if (!edit.linksChecked && $('#playlist-import-text').value.trim()) {
      $('#playlist-import').open=true;
      $('#playlist-import-status').textContent='请先点击「加入歌单」查找这些链接，或清空后保存。';
      $('#playlist-import-add').focus();
      return;
    }
    if(!name){$('#playlist-error').textContent='请输入歌单名称。';$('#playlist-name').focus();return;}
    const ids=edit.items.map(item=>item.id), updating=!!edit.id && !asCopy;
    edit.saving=true;this.updateEditorActions();
    try {
      const result=await this.api('/api/playlists'+(updating?'/'+edit.id:''),{
        method:updating?'PATCH':'POST',headers:updating?this.revisionHeaders(edit):{},body:JSON.stringify({name,clip_ids:ids})});
      if (!this.currentEditor(edit)) {await this.refreshAfterPlaylistChange(edit);return;}
      edit.id=result.id;edit.revision=result.revision;edit.savedName=name;edit.savedIds=ids;edit.conflict=false;
      $('#playlist-error').textContent='';$('#playlist-dialog-title').textContent='编辑歌单';
      await this.loadPlaylists(result.id,edit);
      if (!this.currentEditor(edit)) return;
      if (!this.hasPlaylistChanges()) $('#playlist-dialog').close();
      toast(this.hasPlaylistChanges()?'已保存。之后的修改请再次保存。':asCopy?'已另存为新歌单。':'歌单已保存在此电脑。');
    } catch(error) {this.showEditorError(edit,error);}
    finally {
      edit.saving=false;if(this.currentEditor(edit))this.updateEditorActions();
    }
  }
  async remove() {
    const edit=this.editing;
    if (!edit?.id || edit.conflict || edit.saving || edit.resolving || !confirm('删除这个歌单并放弃本页修改？已采集的片段和收藏会保留。')) return;
    const name=$('#playlist-name').value, ids=edit.items.map(item=>item.id);
    edit.saving=true;this.updateEditorActions();
    try {
      await this.api('/api/playlists/'+edit.id,{method:'DELETE',headers:this.revisionHeaders(edit)});
      if (this.currentEditor(edit)) {
        if (name!==$('#playlist-name').value || ids.length!==edit.items.length || ids.some((id,i)=>id!==edit.items[i].id)) {
          edit.conflict=true;edit.deleted=true;
          $('#playlist-error').textContent='原歌单已删除。删除期间的修改已保留，可另存为新歌单。';
        } else $('#playlist-dialog').close();
      }
      await this.refreshAfterPlaylistChange(edit);
      toast('歌单已删除，片段仍然保留。');
    } catch(error) {this.showEditorError(edit,error);}
    finally {
      edit.saving=false;if(this.currentEditor(edit))this.updateEditorActions();
    }
  }
}
