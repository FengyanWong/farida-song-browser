import { $, $$, escape as e, icon, hydrateIcons, toast, dateTime, writeClipboard } from './ui.js';
import { Pet } from './pet.js';
import { AccountLogin } from './account.js';
import { AppLifetime } from './lifetime.js';
import { PlaylistPlayer } from './player.js';
import { MiniPlayer } from './mini-player.js';
import { connectMediaControls } from './media-controls.js';

hydrateIcons();
const pet = new Pet(); pet.initialize();
const appLifetime = new AppLifetime();
const state = {view:'catalog',filter:'included',page:1,pageSize:40,overview:null,clips:null,token:null,preview:false,stopping:false,selected:new Map(),expandedGroups:new Set(),grouped:false,editSource:null,request:0};
const failedCovers = new Set();
const clipFilters = {included:'已收录',bookmarked:'星标收藏',needs_review:'待确认',all:'全部候选',excluded:'已排除'};
const labels = {queued:'等待采集',running:'采集中',paused:'访问受限',failed:'采集未完成',interrupted:'上次运行中断',cancelled:'已取消',completed:'已完成'};
const sourceTypes = {uploader:'UP 主',season:'合集',series:'系列列表',favorites:'收藏夹',search:'标签发现',songlist:'整理歌单'};
let pollTimer, lastOverview, polling = false, refreshOnReturn = false;
let connecting=false, sessionRetried=false, sessionRetryTimer, startupOverviewError;
function schedulePoll(delay) {
  clearTimeout(pollTimer);
  if (!state.stopping && !document.hidden) pollTimer = setTimeout(poll, delay);
}
document.addEventListener('visibilitychange', () => {
  clearTimeout(pollTimer);
  if (!document.hidden && !state.stopping && !state.token && !$('#connection-retry').hidden) {
    initializeApp();
  } else if (!document.hidden && state.token && !state.stopping) {
    refreshOnReturn = true;
    schedulePoll(0);
  }
});

async function api(path, {asBlob=false, ...options}={}) {
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Farida-Token':state.token || '',...options.headers}});
  if (asBlob && response.ok) return response.blob();
  let data;try {data=await response.json();}catch {throw new Error('本地服务返回异常，请重新启动应用。');}
  if (!response.ok) {const error=new Error(typeof data.detail==='string'?data.detail:'请检查输入内容后重试。');error.status=response.status;error.category=response.headers.get('X-Farida-Error');throw error;}
  return data;
}
function notice(message, error=false) { const el=$('#notice');el.textContent=message;el.hidden=!message;el.classList.toggle('error',error); }
let initialViewReady = false;
const accountLogin = new AccountLogin(api, async()=>{
  notice('');
  if(initialViewReady)await refresh();
});
const playlistPlayer = new PlaylistPlayer(api, requestParameters, selectedClips, ()=>accountLogin.canCollect() && !state.stopping);
const miniPlayer = new MiniPlayer(playlistPlayer);
connectMediaControls(playlistPlayer);
async function quitApp() {
  if(state.stopping)return;
  state.stopping=true;playlistPlayer.updateResumeButton();clearTimeout(pollTimer);
  $$('[data-quit-app]').forEach(button=>button.disabled=true);
  try {
    await playlistPlayer.persistPreferences();
    await playlistPlayer.remember();
    await api('/api/shutdown',{method:'POST'});
    appLifetime.stop();
    pet.setPageActive(false);
    playlistPlayer.stop();
    accountLogin.stop();
    $$('dialog[open]').forEach(dialog=>dialog.close());
    $('#shutdown-dialog').showModal();
    $('#connection-label').textContent='应用已退出';
    $('.status-dot').style.background='var(--muted)';
  } catch(error) {
    state.stopping=false;playlistPlayer.updateResumeButton();schedulePoll(10000);
    $$('[data-quit-app]').forEach(button=>button.disabled=false);
    toast(error.message);
  }
}
$$('[data-quit-app]').forEach(button=>button.onclick=quitApp);
$('#shutdown-dialog').addEventListener('cancel',event=>event.preventDefault());
document.addEventListener('farida-auth-change',()=>{renderJob();if(!accountLogin.canCollect())playlistPlayer.stop(accountLogin.loggingOut);else playlistPlayer.updateResumeButton();if(state.view==='sources')renderSources();});
const searchLimitMessage = '搜索内容最多 2,048 个字符。请缩短分享文字或删除链接中的跟踪参数，并保留分 P 参数。';
function parameters() {
  const query = $('#search').value;
  // Browser lengths count UTF-16 code units; the API limits Unicode characters.
  if (query.length > 2048 && (query.length > 4096 || [...query].length > 2048)) return null;
  const result=new URLSearchParams({status:state.filter==='bookmarked'?'all':state.filter,sort:$('#sort').value,page:state.page,page_size:state.pageSize});
  const inputs={q:'#search',source_id:'#source-filter',uploader:'#uploader-filter'};
  for(const [key,selector] of Object.entries(inputs)) if($(selector).value) result.set(key,$(selector).value);
  for(const key of ['after','before']){
    const value=$('#'+key).value;
    if(!value)continue;
    const boundary=new Date(value+'T00:00:00');
    if(key==='before'){
      // A local day can have 23 or 25 hours when clocks change.
      boundary.setHours(24,0,0,0);
      boundary.setTime(boundary.getTime()-1000);
    }
    result.set(key,Number.isFinite(boundary.getTime())?boundary.toISOString():value);
  }
  if(state.filter==='bookmarked')result.set('bookmarked','true');
  if(state.grouped)result.set('grouped','true');
  return result;
}
function requestParameters() {
  const params = parameters();
  if (!params) throw new Error(searchLimitMessage);
  return params;
}
function saveRoute(rememberView=false) {
  const hash='#'+state.view+(state.filter==='included'?'':'?filter='+state.filter);
  if(location.hash===hash)return;
  if(rememberView)history.pushState(null,'',hash);
  else history.replaceState(null,'',hash);
}
function readRoute() {
  const [view,query]=location.hash.slice(1).split('?');
  const filter=({bookmarks:'bookmarked',review:'needs_review'})[view] || new URLSearchParams(query).get('filter');
  const nextFilter=Object.hasOwn(clipFilters,filter)?filter:'included';
  if(nextFilter!==state.filter) {
    state.filter=nextFilter;state.page=1;state.expandedGroups.clear();clearSelection();
  }
  setView(view);
}
function setView(view, rememberView=false) {
  if(!['catalog','sources'].includes(view))view='catalog';
  if (state.view!==view) ++detailRequest;
  state.view=view;closePageJump();
  $$('.nav-item').forEach(el=>{el.classList.toggle('active',el.dataset.view===view);if(el.dataset.view===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  const names={catalog:'片段收藏',sources:'采集来源'};
  $('#page-title').innerHTML=e(names[view])+'<span class="title-dot">.</span>';
  $('#catalog-view').hidden=view==='sources';$('#sources-view').hidden=view!=='sources';
  $('#clip-filter').value=state.filter;$('#export-button').hidden=view==='sources';
  saveRoute(rememberView);renderJob();
  if(view==='sources'){renderSources();accountLogin.refresh();}else loadClips();
}
function optionList(selector, rows, getValue, getLabel, first) {
  const el=$(selector),selected=el.value;
  el.innerHTML=`<option value="">${first}</option>`+rows.map(r=>`<option value="${e(getValue(r))}">${e(getLabel(r))}</option>`).join('');
  if([...el.options].some(o=>o.value===selected))el.value=selected;
}
let overviewRequest = 0;
async function loadOverview() {
  const request = ++overviewRequest;
  let o;
  try {
    o = await api('/api/overview?compact=true');
  } catch (error) {
    if (request !== overviewRequest || state.stopping) return;
    throw error;
  }
  // A poll started before a manual update may finish after its newer snapshot.
  if (request !== overviewRequest || state.stopping) return;
  schedulePoll(o.jobs.some(j=>['running','queued'].includes(j.state)) ? 1500 : 10000);
  $('#connection-label').textContent='本地运行 · 自动保存';$('.status-dot').style.background='var(--green)';
  if (startupOverviewError && $('#notice').textContent===startupOverviewError) notice('');
  startupOverviewError=null;
  const signature = JSON.stringify(o);
  if (signature === lastOverview) return;
  lastOverview = signature;
  state.overview = o;
  $('#nav-included').textContent=o.included;
  for(const option of $('#clip-filter').options)option.textContent=`${clipFilters[option.value]} (${option.value==='all'?o.entries:o[option.value]})`;
  $('#count-included').textContent=o.included.toLocaleString();$('#count-submissions').textContent=o.submissions.toLocaleString();
  const configured=o.sources.filter(s=>s.enabled && s.source_type!=='search');const complete=configured.filter(s=>s.last_complete_scan_at);
  $('#coverage-summary').textContent=complete.length?`${complete.length} / ${configured.length} 个来源完成过完整扫描`:'尚未完成完整扫描';
  optionList('#source-filter',o.sources,s=>s.id,s=>s.display_name,'全部来源');
  optionList('#uploader-filter',o.uploaders,s=>s.uid,s=>s.name,'全部 UP 主');
  renderJob();if(state.view==='sources')renderSources();
}
let displayedCatalogScope, catalogLoadError, bookmarksDuringRead;
const pendingBookmarks=new Set();
function catalogScope(params) {
  if (!params) return null;
  const scope=new URLSearchParams(params);
  scope.delete('page');
  return scope.toString();
}
const sortSelect=$('#sort');
const sortButtons=$$('th .column-sort');
function showColumnOrder(order) {
  for(const button of sortButtons){
    const {first,reverse}=button.dataset,header=button.closest('th');
    if(order===first || order===reverse){
      const ascending=['oldest','title','uploader'].includes(order);
      header.setAttribute('aria-sort',ascending?'ascending':'descending');
    }else header.removeAttribute('aria-sort');
    const next=sortSelect.value===first?reverse:first;
    button.title=sortSelect.querySelector('option[value="'+next+'"]').textContent;
  }
}
for(const button of sortButtons){
  button.onclick=()=>{
    const {first,reverse}=button.dataset;
    sortSelect.value=sortSelect.value===first?reverse:first;
    filtersChanged();
  };
}
showColumnOrder(sortSelect.value);
function guardCatalogResults(scope) {
  const stale=displayedCatalogScope!==undefined && displayedCatalogScope!==scope;
  $('#clip-rows').inert=stale;
  $('#select-page').inert=stale;
  $('.table-footer').inert=stale;
  $('#bulk-bar').inert=stale;
  if (stale && state.selected.size) clearSelection();
}
async function loadClips() {
  const request=++state.request, params=parameters(), scope=catalogScope(params);
  const newerBookmarks=new Map();bookmarksDuringRead=newerBookmarks;
  guardCatalogResults(scope);
  try {
    if (!params) throw new Error(searchLimitMessage);
    params.set('compact','true');
    const result=await api('/api/clips?'+params);
    if (request!==state.request || scope!==catalogScope(parameters())) return;
    // The database may have answered this GET before a star update was committed.
    if (newerBookmarks.size && params.has('bookmarked')) return loadClips();
    if (newerBookmarks.size) for (const item of result.items) {
      if (newerBookmarks.has(item.id)) item.bookmarked=newerBookmarks.get(item.id);
    }
    const lastPage = Math.max(1, Math.ceil(result.total/state.pageSize));
    if (state.page > lastPage) {
      state.page = lastPage;
      if (result.total) return loadClips();
      result.page=lastPage;
    }
    const focus=scope===displayedCatalogScope && state.view==='catalog' ? bookmarkFocus() : null;
    displayedCatalogScope=scope;
    showColumnOrder(params.get('sort'));
    state.clips=result;
    if (state.selected.size) {
      result.items.forEach((clip, index) => {
        if (state.selected.has(clip.id)) selectClip(clip, index, true);
      });
    }
    renderClips();
    guardCatalogResults(scope);
    if (focus) restoreBookmarkFocus(focus);
    if (catalogLoadError && $('#notice').textContent===catalogLoadError) notice('');
    catalogLoadError=null;
  } catch(error) {
    if (request!==state.request || scope!==catalogScope(parameters())) return;
    // Relative navigation starts from the page that is still on screen after a failed request.
    state.page=displayedCatalogScope===scope && state.clips ? state.clips.page : 1;
    catalogLoadError=error.message;
    notice(error.message,true);
  } finally {
    if (bookmarksDuringRead===newerBookmarks) bookmarksDuringRead=null;
  }
}
function coverImage(raw) {
  let src='';
  if(typeof raw==='string' && raw.trim()) {
    try {
      const url=new URL(raw,location.origin);
      const bili=['http:','https:'].includes(url.protocol) && url.hostname.endsWith('.hdslb.com') && !url.port;
      if(bili)url.protocol='https:';
      const demo=state.preview && url.origin===location.origin && url.pathname==='/assets/demo-cover.svg';
      if((bili || demo) && !url.username && !url.password)src=url.href;
    } catch { /* Missing or malformed covers use the same quiet placeholder. */ }
  }
  if (src && failedCovers.has(src)) {
    return `<button type="button" class="clip-cover" data-retry-cover="${e(src)}" aria-label="重新加载封面" title="封面暂时无法加载，点击重试">${icon('refresh')}</button>`;
  }
  const label=src?'视频封面':'暂无封面';
  return `<span class="clip-cover" role="img" aria-label="${label}" title="${label}">${icon('music')}${src?`<img src="${e(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="104" height="59">`:''}</span>`;
}
document.addEventListener('error',event=>{
  if(!event.target.matches?.('.clip-cover img'))return;
  const img=event.target;
  failedCovers.add(img.src);
  img.parentElement.outerHTML=coverImage(img.src);
},true);

function retryCovers(src) {
  if (src) failedCovers.delete(src);
  else failedCovers.clear();
  for (const cover of $$('#clip-rows [data-retry-cover]')) {
    if (!src || cover.dataset.retryCover === src) {
      // Other parts may share this artwork. Native lazy loading still applies.
      if (cover === document.activeElement) {
        cover.closest('tr')?.querySelector('a.row-title, [data-detail]')?.focus({preventScroll:true});
      }
      cover.outerHTML = coverImage(cover.dataset.retryCover);
    }
  }
}
$('#clip-rows').addEventListener('click', event => {
  const cover = event.target.closest('[data-retry-cover]');
  if (cover) retryCovers(cover.dataset.retryCover);
});
function retryCoversOnReconnect() {
  if (!failedCovers.size || state.stopping || !navigator.onLine) return;
  if (document.hidden) {
    document.addEventListener('visibilitychange', retryCoversOnReconnect, {once:true});
    return;
  }
  retryCovers();
}
window.addEventListener('online', retryCoversOnReconnect);
function clipRow(clip) {
    const dates=dateTime(clip.published_at).split(' ');
    const target=clip.playback_url;
    const title=target?`<a class="row-title" href="${e(target)}" target="_blank" rel="noopener noreferrer" data-play="${e(clip.id)}" title="在此页面播放">${e(clip.display_song_title)}</a>`:`<span class="row-title">${e(clip.display_song_title)}</span>`;
    const status=clip.inclusion_status!=='included'?`<span class="badge ${clip.inclusion_status==='needs_review'?'warn':'muted'}">${clip.inclusion_status==='needs_review'?'待确认':'已排除'}</span>`:'';
    return `<tr><td class="check-col"><input type="checkbox" data-select="${e(clip.id)}" aria-label="选择 ${e(clip.display_song_title)}" ${state.selected.has(clip.id)?'checked':''}></td><td><div class="clip-content">${coverImage(clip.thumbnail_url)}<div class="clip-text">${title}<div class="row-subtitle">${clip.part_count>1?`<span class="part-badge">P${clip.part_number}</span>`:''}<span class="original-title" title="${e(clip.raw_title)}">${clip.raw_title!==clip.display_song_title?e(clip.raw_title):''}</span>${status}${clip.has_curated_credit?'<span class="badge">歌单 · CLANNADOR</span>':''}${!target?'<span class="badge warn">当前不可用</span>':''}</div></div></div></td><td class="row-uploader-cell"><span class="row-uploader" title="UID ${e(clip.uploader_uid)}">${e(clip.uploader_name)}</span></td><td class="row-date">${e(dates[0])}<small>${e(dates.slice(1).join(' '))}</small></td><td><div class="row-actions"><button class="icon-button ${clip.bookmarked?'active':''}" data-bookmark="${e(clip.id)}" aria-label="收藏 ${e(clip.display_song_title)}" aria-pressed="${!!clip.bookmarked}" ${pendingBookmarks.has(clip.id)?'aria-disabled="true"':''} title="${clip.bookmarked?'取消收藏':'收藏'}">${icon('star')}</button><button class="icon-button" data-detail="${e(clip.id)}" aria-label="查看 ${e(clip.display_song_title)} 的详情" title="详情与修正">${icon('more')}</button></div></td></tr>`;
}
function bookmarkButton(id) {
  return $('#clip-rows').querySelector(`[data-bookmark="${CSS.escape(id)}"]`);
}
function bookmarkFocus() {
  const button=document.activeElement;
  if (!button.matches('#clip-rows [data-bookmark]')) return null;
  return {id:button.dataset.bookmark, index:$$('#clip-rows [data-bookmark]').indexOf(button), page:state.clips.page,
          group:state.clips.groups?.findIndex(group=>group.clip_ids.includes(button.dataset.bookmark))};
}
function restoreBookmarkFocus(previous) {
  let target=bookmarkButton(previous.id);
  if (!target && state.filter==='bookmarked') {
    const stars=$$('#clip-rows [data-bookmark]'), groups=$$('#clip-rows [data-group]');
    const index=state.clips.page<previous.page ? stars.length-1 : Math.min(previous.index,stars.length-1);
    target=stars[index] || groups[Math.min(previous.group??0,groups.length-1)] || $('#clip-filter');
  }
  target?.focus({preventScroll:true});
}
async function toggleBookmark(button) {
  const id=button.dataset.bookmark, clip=state.clips?.items.find(item=>item.id===id);
  if (!clip || pendingBookmarks.has(id) || $('#clip-rows').inert) return;
  pendingBookmarks.add(id);
  // aria-disabled keeps the keyboard on this control while duplicate activation is ignored.
  button.setAttribute('aria-disabled','true');
  try {
    const result=await api('/api/clips/'+encodeURIComponent(id)+'/bookmark',{
      method:'PATCH',body:JSON.stringify({bookmarked:!clip.bookmarked})});
    bookmarksDuringRead?.set(id,result.bookmarked);
    const current=state.clips?.items.find(item=>item.id===id);
    if (current) current.bookmarked=result.bookmarked;
    const star=bookmarkButton(id);
    if (star) {
      star.classList.toggle('active',result.bookmarked);
      star.setAttribute('aria-pressed',String(result.bookmarked));
      star.title=result.bookmarked?'取消收藏':'收藏';
    }
    if (!result.bookmarked && state.filter==='bookmarked' && state.selected.delete(id)) updateSelection();
  } finally {
    pendingBookmarks.delete(id);
    bookmarkButton(id)?.removeAttribute('aria-disabled');
  }
  if (state.view==='catalog' && state.filter==='bookmarked') await Promise.all([loadOverview(),loadClips()]);
  else await loadOverview();
}
function renderClips() {
  const result=state.clips;
  const byId=new Map(result.items.map(clip=>[clip.id,clip]));
  $('#clip-rows').innerHTML=state.grouped?(result.groups||[]).map((group,index)=>{
    const members=group.clip_ids.map(id=>byId.get(id)).filter(Boolean),expanded=state.expandedGroups.has(group.key);
    const uploaders=[...new Set(members.map(clip=>clip.uploader_name))].join('、');
    return `<tr class="song-group-row"><td class="check-col"><input type="checkbox" data-select-group="${index}" aria-label="选择 ${e(group.title)} 的全部 ${group.count} 个版本"></td><td colspan="4"><div class="song-group-heading"><button class="song-group-toggle" data-group="${index}" aria-expanded="${expanded}" aria-label="${expanded?'收起':'展开'} ${e(group.title)} 的 ${group.count} 个版本">${icon(expanded?'chevron-down':'chevron-right')}<span><b>${e(group.title)}</b><small title="${e(uploaders)}">${group.count} 个版本 · ${e(uploaders)}</small></span></button><button class="icon-button" data-play-group="${index}" aria-label="播放 ${e(group.title)} 的所有版本" title="播放这些版本">${icon('play')}</button></div></td></tr>${expanded?members.map(clipRow).join(''):''}`;
  }).join(''):result.items.map(clipRow).join('');
  const empty=$('#empty-state');empty.hidden=result.total>0;
  if(!result.total) {
    const o=state.overview || {}, filtered=$('#search').value||$('#source-filter').value||$('#after').value||$('#before').value||$('#uploader-filter').value;
    const heading=filtered?'没有找到匹配的片段':state.filter==='bookmarked'?'把喜欢的片段留在这里':state.filter==='needs_review'?'目前没有待确认的片段':o.entries?'暂时没有符合此状态的片段':'等待歌声汇聚';
    const description=filtered?'试试其他关键词，或调整筛选条件。':state.filter==='bookmarked'?'点击片段旁的星标，就能加入收藏。':state.filter==='needs_review'?'新发现的模糊内容会在这里等待你确认。':o.entries?'在筛选菜单中选择「全部候选」或「待确认」完善收录。':'启动并验证登录后，会自动检查所有已启用来源。<br>采集到的片段会逐条出现在这里。';
    $('h2',empty).textContent=heading;$('p',empty).innerHTML=description;
    $('#first-scan').hidden=!!(filtered||o.entries||state.filter!=='included');
  }
  $('#result-count').textContent=`${state.grouped?`${result.total.toLocaleString()} 首歌 · ${(result.total_clips??result.items.length).toLocaleString()} 个版本`:`${result.total.toLocaleString()} 个片段`}${result.total?` · 显示 ${(state.page-1)*state.pageSize+1}–${Math.min(state.page*state.pageSize,result.total)}`:''}`;
  const pages=Math.max(1,Math.ceil(result.total/state.pageSize));
  $('#page-number').textContent=`${state.page} / ${pages}`;
  $('#page-number').setAttribute('aria-label',`第 ${state.page} 页，共 ${pages} 页，跳到指定页`);
  $('#page-number').disabled=pages===1;
  $('#page-target').max=String(pages);
  if(pages===1)closePageJump();
  $('#prev-page').disabled=state.page===1;$('#next-page').disabled=state.page*state.pageSize>=result.total;
  updateSelection();
}
function errorText(error) {
  if(!error)return '';
  const retry=Number.isFinite(Date.parse(error.retry_at)) ?
    `来源建议在 ${dateTime(error.retry_at,true)}（本机时间）后点击「继续任务」。` : '请稍后点击「继续任务」。';
  if(error.category==='restricted')return 'B站暂时限制访问，采集已暂停。已保存的歌曲仍可使用。'+retry;
  if(error.category==='authentication')return '登录已失效，请在右上角账号菜单重新登录后再采集。';
  if(error.category==='network')return '无法连接来源网站。请检查网络后点击「继续任务」，已保存的歌曲不会丢失。';
  if(error.category==='pagination')return '分页未完整结束；已保存进度，尚不能确认完整覆盖。';
  if(error.category==='identity')return '返回的身份与配置不一致，请检查来源 UID。';
  if(error.category==='video_identity')return '某条投稿的主投稿人或联合创作者未能与来源核对，已保存进度。';
  if(error.category==='schema')return '来源网站返回的数据格式有变化，已保留采集进度。若持续失败，需要更新应用。';
  if(error.category==='server')return '来源网站暂时不可用。'+retry;
  if(error.category==='retry_later')return '来源网站要求稍后重试，采集已暂停。'+retry;
  if(error.category==='internal')return '本地采集出现错误，已保存进度。可重新启动应用，或查看使用说明中的排查方法。';
  return error.message || '采集未完成，已保存进度。';
}
function jobAdditions(job) {
  const checkpoints=Object.values(job?.checkpoints||{});
  if(!checkpoints.length||checkpoints.some(cp=>cp.added_clips==null))return '新增数未记录';
  return `新增 ${checkpoints.reduce((n,cp)=>n+cp.added_clips,0)} 个片段（已收录 ${checkpoints.reduce((n,cp)=>n+(cp.added_included||0),0)}）`;
}
function renderJob() {
  const jobs=state.overview?.jobs || [];const active=jobs.find(j=>['running','queued'].includes(j.state));
  const blocked=!!active||!accountLogin.canCollect();
  $('#sync-button').disabled=blocked;$('#first-scan').disabled=blocked;$('#full-scan').disabled=blocked;
  const banner=$('#job-banner');banner.hidden=!jobs.length;
  if(active) {
    const running=Object.entries(active.checkpoints).find(([,p])=>p.state==='running');
    const source=state.overview.sources.find(s=>String(s.id)===running?.[0]);
    const progress=running?.[1];
    banner.innerHTML=`<span class="spinner"></span><span>${active.mode==='full'?'完整采集':'采集更新'} · ${e(source?.display_name || '准备中')} ${progress?.current_page?`· 第 ${progress.current_page} 页`:''} · 已检查 ${active.processed} 个视频 · ${jobAdditions(active)}</span><button class="button secondary small" data-cancel="${e(active.id)}" ${active.cancel_requested?'disabled':''}>${active.cancel_requested?'正在取消…':'取消采集'}</button>`;
    pet.setStatus('running');
  } else if(jobs[0]) {
    const job=jobs[0],failed=['paused','failed','interrupted'].includes(job.state);
    const error=job.errors[0];
    const message=error?errorText(error):job.state==='interrupted'?'上次应用退出时采集未完成，已保存进度。':job.state==='cancelled'?'采集已取消，已保存的歌曲仍然保留。':'';
    banner.innerHTML=`<span><b>${e(labels[job.state]||job.state)}</b> · ${jobAdditions(job)}${message?`<br><small>${e(message)}</small>`:''}</span>${['paused','failed','interrupted','cancelled'].includes(job.state)?`<button class="button secondary small" data-resume="${e(job.id)}" ${blocked?'disabled':''}>继续任务</button>`:''}`;
    pet.setStatus(failed?'failed':state.view==='catalog'&&state.filter==='needs_review'?'waiting':'idle');
  } else pet.setStatus('idle');
}
function collectionStatus(source) {
  const status=source.collection_status||{state:'idle'};
  const indexReady=source.source_type==='songlist' && !!status.index_fetched_at;
  const names={idle:'尚未采集',queued:indexReady?'等待补全视频':'等待采集',running:'正在采集',completed:'更新完成',paused:status.error?.category==='authentication'?'需要重新登录':status.error?.category==='restricted'?'访问受限，已暂停':'采集已暂停',failed:'未完成',cancelled:'已取消',interrupted:'上次采集中断',not_started:indexReady?'视频资料待补全':'本次尚未执行'};
  const detail=status.state==='not_started'?(indexReady?'整理歌单已更新。继续任务后会检查 B 站视频资料。':'任务在前序来源停止，此来源未开始采集。'):status.state==='queued'?'等待前序来源完成。':status.state==='running'?`已检查 ${status.processed} 个视频${status.current_page?` · 第 ${status.current_page} 页`:''}`:'';
  const scope=source.source_type==='search'?'标签搜索仅检查限定页数，不代表全部视频。':status.mode==='incremental'&&source.source_type!=='songlist'?'本次检查最近投稿，完整历史需使用「完整扫描」。':'';
  const counted=status.added_clips!=null;
  const additions=counted?`新增 ${status.added_clips} 个片段 · 其中 ${status.added_included||0} 个已收录${status.skipped?` · 跳过 ${status.skipped} 个不可访问视频`:''}`:status.last_attempt_at?'旧任务未记录新增数':'';
  return `<div class="source-dates collection-result"><span class="badge ${status.state==='completed'?'ok':['failed','paused','interrupted'].includes(status.state)?'warn':''}">${e(names[status.state]||'未完成')}</span><br><span>上次成功更新：${dateTime(status.last_success_at)}</span>${status.last_attempt_at?`<br><span>最近尝试：${dateTime(status.last_attempt_at)}</span>`:''}${detail?`<br>${e(detail)}`:''}${additions?`<br><span title="仅计算这次任务新增到本机的片段；重复视频与恢复重放不会重复计数。">${e(additions)}</span>`:''}${scope?`<br><small>${e(scope)}</small>`:''}</div>`;
}
function skippedVideos(job) {
  const items=[...new Map(Object.values(job?.checkpoints || {}).flatMap(cp=>cp.unavailable || []).map(item=>[item.bvid,item])).values()];
  if(!items.length)return '';
  const reasons={'62012':'仅 UP 主自己可见','-404':'视频不存在或已移除','62002':'视频当前不可见','62004':'视频审核中'};
  return `<details class="unavailable-videos"><summary>已跳过 ${items.length} 个不可访问视频</summary><ul>${items.map(item=>`<li><code>${e(item.bvid)}</code> · ${e(reasons[String(item.upstream_code)] || '暂时无法访问')}</li>`).join('')}</ul><p>已保留来源记录，不影响其他视频的采集。</p></details>`;
}
function renderSources() {
  if(!state.overview)return;
  const active=state.overview.jobs.some(j=>['running','queued'].includes(j.state))||!accountLogin.canCollect();
  $('#source-list').innerHTML=state.overview.sources.map(source=>{
    const verified=source.verification_status==='verified',search=source.source_type==='search',curated=source.source_type==='songlist';
    const skipped=skippedVideos({checkpoints:{[source.id]:{unavailable:source.collection_status?.unavailable||[]}}});
    const subtitle=curated?'CLANNADOR 整理':search?'法里达 + 直播切片':`UID ${e(source.uid)}`;
    const dates=curated?`${source.listed_songs || 0} 首歌 · ${source.linked_songs || 0} 个 BV 链接<br>歌单读取：${dateTime(source.collection_status?.index_fetched_at || source.list_fetched_at)}<br>每次更新重读歌单，补齐新增视频。<br><a href="https://fareeda.songlist.cc/" target="_blank" rel="noopener noreferrer">查看原歌单 ↗</a><button type="button" class="text-button missing-links-open" data-missing-links="${e(source.id)}" aria-haspopup="dialog" aria-controls="missing-links-dialog">查看待补全链接</button>`:search?`上次标签发现：${dateTime(source.last_discovery_at)}<br>仅保留实际标签同时匹配的歌唱内容；其他候选待确认。`:`完整扫描：${source.last_complete_scan_at?dateTime(source.last_complete_scan_at):'尚未完成'}<br>最近更新：${dateTime(source.last_refresh_at)}`;
    return `<article class="source-card ${source.enabled?'':'disabled'}"><div class="source-card-top"><span class="source-avatar">${search?icon('search'):e(source.display_name[0])}</span><div><h3>${e(source.display_name)}</h3><small>${subtitle}${source.resolved_name && source.resolved_name!==source.display_name?` · 当前名称 ${e(source.resolved_name)}`:''}</small></div>${!search&&!curated?`<button class="icon-button" data-edit-source="${source.id}" title="编辑来源" aria-label="编辑 ${e(source.display_name)}" ${active?'disabled':''}>${icon('settings')}</button>`:''}</div><div class="source-meta"><span class="badge">${sourceTypes[source.source_type]}</span><span class="badge ${verified?'ok':'warn'}">${curated?(verified?'歌单已读取':'等待读取'):search?'有限搜索发现':verified?'身份已核对':'身份待核对'}</span>${!source.enabled?'<span class="badge muted">已停用</span>':''}</div><div class="source-stats"><span>${source.submissions} 个原视频</span><span>${source.entries} 个片段</span></div><div class="source-dates">${dates}</div>${collectionStatus(source)}${skipped}${source.collection_status?.error?`<div class="source-error">${e(errorText(source.collection_status.error))}</div>`:''}<div class="source-actions">${source.collection_status?.can_resume?`<button class="button small" data-resume="${e(source.collection_status.job_id)}" ${active||!source.enabled?'disabled':''}>继续任务</button>`:''}<button class="button small" data-scan-source="${source.id}" ${active||!source.enabled?'disabled':''}>${curated?'更新歌单':search?'发现片段':'采集更新'}</button>${!search&&!curated?`<button class="button small" data-full-source="${source.id}" ${active||!source.enabled?'disabled':''}>完整扫描</button>`:''}<button class="text-button" data-toggle-source="${source.id}" ${active?'disabled':''}>${source.enabled?'停用':'启用'}</button></div></article>`;
  }).join('');
  $('#job-history').innerHTML=state.overview.jobs.length?state.overview.jobs.map(job=>`<div class="history-item"><span class="badge ${job.state==='completed'?'ok':job.state==='running'?'':'warn'}">${labels[job.state] || e(job.state)}</span><span>${job.mode==='full'?'完整采集':'最近更新'} · ${job.processed} 个视频 · ${jobAdditions(job)}</span><span class="history-time">${dateTime(job.started_at)}</span>${['failed','paused','interrupted','cancelled'].includes(job.state)?`<button class="button small" data-resume="${e(job.id)}" ${active?'disabled':''}>继续任务</button>`:''}${job.errors.length?`<div class="history-error">${e(errorText(job.errors[0]))}</div>`:''}${skippedVideos(job)}</div>`).join(''):'<div class="history-empty">还没有采集记录</div>';
}
let missingLinksView;
const missingLinksDialog=$('#missing-links-dialog');
function openMissingLinks(sourceId) {
  missingLinksView?.controller.abort();
  missingLinksView={sourceId,after:0,count:0,loading:false,controller:new AbortController()};
  $('#missing-links-list').replaceChildren();
  $('#missing-links-more').hidden=true;
  missingLinksDialog.showModal();
  loadMissingLinks();
}
async function loadMissingLinks() {
  const view=missingLinksView;
  if (!view || view.loading || view.after===null) return;
  const more=$('#missing-links-more'), status=$('#missing-links-status'), list=$('#missing-links-list');
  view.loading=true;
  more.setAttribute('aria-disabled','true');
  status.textContent='正在读取本机歌单…';
  try {
    const page=await api(`/api/sources/${view.sourceId}/missing-links?after_id=${view.after}&limit=40`,{signal:view.controller.signal});
    if (view!==missingLinksView || !missingLinksDialog.open) return;
    const previous=view.count;
    // Each songlist entry is independent, even if other entries share its title or BV.
    const rows=page.items.map(song=>`<li><span><strong>${e(song.song_title||song.bvid)}</strong>${song.original_artist?`<small class="muted">原唱：${e(song.original_artist)}</small>`:''}</span><a href="${e(song.url)}" target="_blank" rel="noopener noreferrer" aria-label="打开原视频 ${e(song.bvid)}">${e(song.bvid)} ↗</a></li>`);
    list.insertAdjacentHTML('beforeend',rows.join(''));
    view.count+=page.items.length;
    view.after=page.next_after_id;
    status.textContent=view.count?`已显示 ${view.count} 条`:'当前没有待补全的链接。';
    if (document.activeElement===more) {
      const firstNew=list.children[previous]?.querySelector('a');
      (firstNew || missingLinksDialog.querySelector('.close-dialog')).focus();
    }
    more.hidden=view.after===null;
    more.textContent='加载更多';
  } catch(error) {
    if (view!==missingLinksView || !missingLinksDialog.open || error.name==='AbortError') return;
    status.textContent=error.message;
    more.hidden=false;
    more.textContent='重试';
  } finally {
    view.loading=false;
    if (view===missingLinksView) more.removeAttribute('aria-disabled');
  }
}
$('#missing-links-more').onclick=loadMissingLinks;
missingLinksDialog.addEventListener('close',()=>{
  if (missingLinksDialog.open || !missingLinksView) return;
  const {sourceId,controller}=missingLinksView;
  controller.abort();
  missingLinksView=null;
  $('#missing-links-list').replaceChildren();
  if (state.view==='sources' && document.activeElement===document.body)
    $(`[data-missing-links="${sourceId}"]`)?.focus({preventScroll:true});
});
async function startSync(mode='incremental',sourceIds=[]) {
  try {notice('');await api('/api/sync',{method:'POST',body:JSON.stringify({mode,source_ids:sourceIds})});await loadOverview();toast('采集任务已启动，内容会逐条保存。');}
  catch(error){notice(error.message,true);if(error.status===401)await accountLogin.requireLogin();}
}
async function refresh() {try {await loadOverview();if(state.view!=='sources')await loadClips();}catch(error){notice(error.message,true);$('#connection-label').textContent='本地服务未连接';$('.status-dot').style.background='var(--danger)';}}
function selectClip(clip, index, checked) {
  if (!checked) {
    state.selected.delete(clip.id);
    return;
  }
  const {id, display_song_title, uploader_name, raw_title, raw_part_title, playback_url} = clip;
  // A page reload can refresh the label and location of the same selection.
  // A deselect/reselect starts a new selection with its own observed status.
  const selection=state.selected.get(id) || {expectedStatus:clip.inclusion_status};
  selection.page=state.clips.page;selection.index=index;
  selection.clip={id, display_song_title, uploader_name, raw_title, raw_part_title, playback_url};
  state.selected.set(id,selection);
}
function selectedClips() {
  return [...state.selected.values()].sort((a,b)=>a.page-b.page || a.index-b.index).map(row=>row.clip);
}
function clearSelection() {state.selected.clear();updateSelection();}
function updateSelection() {
  $('#bulk-bar').hidden=!state.selected.size;
  const items=state.clips?.items || [],selected=items.filter(i=>state.selected.has(i.id)).length;
  $('#selected-count').textContent = `已选择 ${state.selected.size} 项` + (selected < state.selected.size ? `（本页 ${selected} 项）` : '');
  $('#select-page').checked=items.length>0 && selected===items.length;
  $('#select-page').indeterminate=selected>0 && selected<items.length;
  $$('[data-select-group]').forEach(input=>{
    const ids=state.clips.groups[Number(input.dataset.selectGroup)].clip_ids,count=ids.filter(id=>state.selected.has(id)).length;
    input.checked=ids.length>0&&count===ids.length;input.indeterminate=count>0&&count<ids.length;
  });
  $$('[data-select]').forEach(el=>el.checked=state.selected.has(el.dataset.select));
}
function filtersChanged() {clearTimeout(searchTimer);closePageJump();state.page=1;state.expandedGroups.clear();clearSelection();loadClips();}
function updateSingingCollectionControl() {
  const checkbox=$('#singing-collection');
  let collection=false;
  try {
    const url=new URL($('#source-url').value.trim()),params=url.searchParams;
    if(url.protocol==='https:' && url.hostname==='space.bilibili.com') {
      collection=!!(params.get('fid') || params.get('sid') || /^\/\d+\/lists\/\d+(?:\/|$)/.test(url.pathname));
    } else if(url.protocol==='https:' && url.hostname==='www.bilibili.com') {
      collection=/^\/medialist\/play\/\d+\/?$/.test(url.pathname) && !!params.get('business_id')
        && ['space_series','space_collection'].includes(params.get('business'));
    }
  } catch {}
  checkbox.disabled=!collection;
  if(!collection)checkbox.checked=false;
}
$('#source-url').addEventListener('input',updateSingingCollectionControl);
function setSourceSaving(saving) {
  const submit=$('#source-form button[type=submit]');
  submit.disabled=saving;
  submit.textContent=saving?'正在保存…':'保存来源';
  $('#source-name').readOnly=saving;
  $('#source-url').readOnly=saving;
  if(saving)$('#singing-collection').disabled=true;
  else updateSingingCollectionControl();
}
function showSource(source) {
  state.editSource={source,saving:false};
  $('#source-name').value=source?.display_name || '';
  $('#source-url').value=source?.canonical_url || '';
  $('#singing-collection').checked=!!source?.singing_collection;
  setSourceSaving(false);
  $('#source-form-error').textContent='';
  $('#source-dialog-title').textContent=source?'编辑来源':'添加来源';
  $('#source-dialog').showModal();
}
const detailDialog = $('#detail-dialog');
let detailRequest=0, detailEditor=null;
function annotationChanges(editor) {
  return Object.fromEntries([...new FormData(editor.form)].filter(([field,value])=>editor.original[field]!==value));
}
function allowDetailClose() {
  if (!detailEditor) return true;
  if (detailEditor.saving) return confirm('修改正在保存，仍要关闭片段详情吗？');
  return !Object.keys(annotationChanges(detailEditor)).length || confirm('放弃未保存的片段修改？');
}
detailDialog.addEventListener('cancel',event=>{if(!allowDetailClose())event.preventDefault();});
detailDialog.addEventListener('click',event=>{
  if (event.target.closest('.close-dialog') && !allowDetailClose()) {
    event.preventDefault();event.stopPropagation();
  }
});
detailDialog.addEventListener('close',()=>{if(!detailDialog.open)detailEditor=null;});
async function showDetail(id) {
  const request=++detailRequest;
  let clip;
  try { clip=await api('/api/clips/'+encodeURIComponent(id)); }
  catch (error) { if (request===detailRequest && !state.stopping) throw error; return; }
  if (request!==detailRequest || state.stopping || document.querySelector('dialog[open]')) return;
  const el=$('#detail-content');
  const credit=clip.songlist_credits?.length?`<dt>歌单整理</dt><dd><a href="https://fareeda.songlist.cc/" target="_blank" rel="noopener noreferrer">CLANNADOR · 小法的歌单 ↗</a><br>${clip.songlist_credits.map(song=>`${e(song.song_title)}${song.original_artist?` · 原唱 ${e(song.original_artist)}`:''}`).join('<br>')}</dd>`:'';
  el.innerHTML=`<div class="dialog-heading"><h2>片段详情</h2><button class="icon-button close-dialog" aria-label="关闭">${icon('x')}</button></div><h3 class="detail-title">${e(clip.display_song_title)}</h3><div class="detail-original">${e(clip.raw_title)}</div><dl class="detail-grid"><dt>UP 主</dt><dd>${e(clip.uploader_name)} · UID ${e(clip.uploader_uid)}</dd><dt>上传时间</dt><dd>${dateTime(clip.published_at)}（当前时区）</dd><dt>分 P 信息</dt><dd>P${clip.part_number} · ${e(clip.raw_part_title)} · CID ${e(clip.cid)}</dd><dt>判断依据</dt><dd data-detail-reason>${e(clip.classification_reason)}${clip.manual_fields.length?' · 含手动修正':''}</dd><dt>来源</dt><dd>${clip.sources.map(s=>e(s.display_name)).join('、')}</dd>${credit}</dl><div class="tag-list">${clip.tags.map(tag=>`<span class="badge">${e(tag)}</span>`).join('')}</div><div class="review-actions"><button class="button primary small" data-classify="included" data-id="${e(id)}">确认收录</button><button class="button secondary small" data-classify="excluded" data-id="${e(id)}">排除此片段</button><button class="button secondary small" data-classify="needs_review" data-id="${e(id)}">保留待确认</button>${clip.playback_url?`<a class="button secondary small" href="${e(clip.playback_url)}" data-open="${e(id)}" target="_blank" rel="noopener noreferrer">${icon('external')}打开原视频</a><button type="button" class="button secondary small" data-copy-url="${e(clip.playback_url)}">复制链接</button>`:''}</div><p id="detail-feedback" class="field-help" role="status" hidden></p><details><summary>修改歌名、分组与备注</summary><button type="button" class="text-button" id="detail-auto-title" ${clip.manual_fields.includes('display_song_title')?'':'hidden'}>使用自动歌名</button><form id="annotation-form" data-id="${e(id)}"><label class="field">显示歌名<input name="display_song_title" required maxlength="500" value="${e(clip.display_song_title)}"></label><label class="field">歌曲分组<input name="song_group" maxlength="200" value="${e(clip.song_group)}" placeholder="用于归拢不同演唱版本"></label><label class="field">个人备注<input name="notes" maxlength="5000" value="${e(clip.notes)}"></label><button class="button primary small">保存修正</button></form></details><details><summary>原始描述与数据来源</summary><div class="detail-description">${e(clip.description || '暂无描述')}</div><p class="detail-stats">${Object.entries(clip.statistics).map(([key,v])=>`${({view:'播放',like:'点赞',coin:'投币',favorite:'收藏',share:'分享',reply:'评论',danmaku:'弹幕'})[key]}：${v==null?'未知':v.toLocaleString()}`).join(' · ')}<br>以上为整个原视频的统计，不是此分 P 的单独统计。<br>获取于 ${dateTime(clip.stats_fetched_at)} · ${e(clip.provenance.details)}</p></details>`;
  const form=el.querySelector('#annotation-form');
  detailEditor={id,form,original:Object.fromEntries(new FormData(form)),saving:false};
  detailDialog.showModal();
}
async function saveAnnotation(editor, patch, message, {automaticTitle=false}={}) {
  if (!editor || editor!==detailEditor || !detailDialog.open || editor.saving) return;
  const titleInput=editor.form.elements.namedItem('display_song_title'), submittedTitle=titleInput.value;
  if (automaticTitle) {
    const prompt=submittedTitle===editor.original.display_song_title
      ? '使用自动歌名？当前手动歌名将被替换，后续会随采集更新。'
      : '显示歌名还有未保存的修改。放弃这些歌名修改并使用自动歌名？';
    if (!confirm(prompt)) return;
  } else if (!Object.keys(patch).length) { detailDialog.close(); return; }
  editor.saving=true;
  const selection=state.selected.get(editor.id);
  const autoButton=$('#detail-auto-title');
  const buttons=detailDialog.querySelectorAll('[data-classify], #annotation-form button, #detail-auto-title');
  buttons.forEach(button=>button.disabled=true);
  const feedback=$('#detail-feedback');
  feedback.hidden=true;
  try {
    const path='/api/clips/'+encodeURIComponent(editor.id);
    const clip=automaticTitle
      ? await api(path+'/automatic-title',{method:'POST'})
      : await api(path+'/annotation',{method:'PATCH',body:JSON.stringify(patch)});
    if (patch.inclusion_status && selection && selection===state.selected.get(editor.id)) {
      if (state.filter!=='all' && state.filter!=='bookmarked' && state.filter!==clip.inclusion_status) state.selected.delete(editor.id);
      else selection.expectedStatus=clip.inclusion_status;
      updateSelection();
    }
    if (detailDialog.open && editor===detailEditor) {
      Object.assign(editor.original,patch);
      if (automaticTitle) {
        // Text inputs strip line breaks; an imported title containing one is still unedited.
        const automaticValue=clip.display_song_title.replace(/[\r\n]/g,'');
        editor.original.display_song_title=automaticValue;
        if (titleInput.value===submittedTitle) titleInput.value=automaticValue;
      }
      const hasDraft=Object.keys(annotationChanges(editor)).length>0;
      if (automaticTitle || hasDraft) {
        // The user can keep typing during a save. Preserve edits newer than the submitted values.
        detailDialog.querySelector('.detail-title').textContent=clip.display_song_title;
        detailDialog.querySelector('[data-detail-reason]').textContent=clip.classification_reason+(clip.manual_fields.length?' · 含手动修正':'');
        autoButton.hidden=!clip.manual_fields.includes('display_song_title');
        if (automaticTitle && (document.activeElement===document.body || document.activeElement===autoButton)) titleInput.focus({preventScroll:true});
        feedback.textContent=(automaticTitle?message:'本次修改已保存。')+(hasDraft?'其他改动仍待保存。':'');
        feedback.hidden=false;
      } else {
        detailDialog.close();toast(message);
      }
    }
  } catch(error) {
    if (detailDialog.open && editor===detailEditor) {feedback.textContent=error.message;feedback.hidden=false;}
    return;
  } finally {
    editor.saving=false;
    buttons.forEach(button=>button.disabled=false);
  }
  await refresh();
}

document.addEventListener('click',async event=>{
  const button=event.target.closest('button,a');if(!button || button.disabled)return;
  try {
    if(button.matches('.close-dialog'))button.closest('dialog').close();
    if(button.dataset.view)setView(button.dataset.view,true);
    if(button.dataset.group!==undefined){
      const group=state.clips.groups[Number(button.dataset.group)];
      state.expandedGroups.has(group.key)?state.expandedGroups.delete(group.key):state.expandedGroups.add(group.key);
      renderClips();$(`[data-group="${button.dataset.group}"]`).focus();
    }
    if(button.dataset.playGroup!==undefined){
      const group=state.clips.groups[Number(button.dataset.playGroup)],ids=new Set(group.clip_ids);
      playlistPlayer.start(state.clips.items.filter(item=>ids.has(item.id)),group.title+' · 不同版本');
    }
    if(button.dataset.play && !(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)) {
      event.preventDefault();await playlistPlayer.fromResults(button.dataset.play);
    }
    if(button.dataset.copyUrl) {
      const url=button.dataset.copyUrl;
      if (await writeClipboard(url)) toast('已复制原视频链接。');
      else window.prompt('复制原视频链接',url);
    }
    if(button.dataset.open && !(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)) {
      event.preventDefault();const result=await api(`/api/clips/${encodeURIComponent(button.dataset.open)}/open`,{method:'POST'});
      if(!result.opened)toast('无法启动默认浏览器，请使用原视频链接。',result.url);
    }
    if(button.dataset.bookmark)await toggleBookmark(button);
    if(button.dataset.detail)await showDetail(button.dataset.detail);
    if(button.dataset.classify)await saveAnnotation(detailEditor,{inclusion_status:button.dataset.classify},'已保存你的决定，后续采集会保留。');
    if(button.id==='detail-auto-title')await saveAnnotation(detailEditor,{},'已使用自动歌名。',{automaticTitle:true});
    if(button.dataset.bulk){
      const selected=[...state.selected.values()].map(selection=>({id:selection.clip.id,selection,expected:selection.expectedStatus}));
      $$('[data-bulk]').forEach(el=>el.disabled=true);
      let saved=0, skipped=0;
      const resultMessage=()=>`已保存 ${saved} 个片段的决定。`+(skipped?`${skipped} 个片段的状态已改变或已移除，已跳过。`:'');
      try {
        for(let offset=0;offset<selected.length;offset+=100){
          const batch=selected.slice(offset,offset+100);
          const ids=batch.map(item=>item.id),expected_statuses=Object.fromEntries(batch.map(item=>[item.id,item.expected]));
          const result=await api('/api/review/bulk',{method:'PATCH',body:JSON.stringify({ids,inclusion_status:button.dataset.bulk,expected_statuses})});
          saved+=result.updated;skipped+=result.conflicts.length;
          for(const item of batch) if(state.selected.get(item.id)===item.selection) state.selected.delete(item.id);
          updateSelection();
        }
        await refresh();toast(resultMessage());
      } catch(error) {
        if(saved || skipped){await refresh();error.message=resultMessage()+'其余片段未能处理。'+error.message;}
        throw error;
      } finally{$$('[data-bulk]').forEach(el=>el.disabled=false);}
    }
    if(button.dataset.cancel){await api(`/api/sync/${button.dataset.cancel}/cancel`,{method:'POST'});await loadOverview();}
    if(button.dataset.resume){notice('');await api(`/api/sync/${button.dataset.resume}/resume`,{method:'POST'});await loadOverview();}
    if(button.dataset.missingLinks)openMissingLinks(button.dataset.missingLinks);
    if(button.dataset.scanSource)await startSync('incremental',[Number(button.dataset.scanSource)]);
    if(button.dataset.fullSource)await startSync('full',[Number(button.dataset.fullSource)]);
    if(button.dataset.editSource)showSource(state.overview.sources.find(s=>s.id===Number(button.dataset.editSource)));
    if(button.dataset.toggleSource){const source=state.overview.sources.find(s=>s.id===Number(button.dataset.toggleSource));await api('/api/sources/'+source.id,{method:'PATCH',body:JSON.stringify({enabled:!source.enabled})});await loadOverview();}
  }catch(error){notice(error.message,true);toast(error.message);if(error.status===401)await accountLogin.requireLogin();}
});
document.addEventListener('submit',async event=>{
  if(event.target.id!=='annotation-form')return;event.preventDefault();
  if (detailEditor?.form===event.target) await saveAnnotation(detailEditor,annotationChanges(detailEditor),'修正已保存。');
});
document.addEventListener('change',event=>{
  const input=event.target;
  if (!input.matches('[data-select-group],[data-select],#select-page')) return;
  const group=input.dataset.selectGroup;
  const ids=group===undefined ? null : new Set(state.clips.groups[Number(group)].clip_ids);
  state.clips?.items.forEach((clip,index)=>{
    if (input.id==='select-page' || clip.id===input.dataset.select || ids?.has(clip.id)) {
      selectClip(clip,index,input.checked);
    }
  });
  updateSelection();
});
$('#clear-selection').onclick=clearSelection;
try{state.grouped=localStorage.getItem('farida-grouped')==='true';}catch{}
$('#group-songs').checked=state.grouped;
$('#group-songs').onchange=()=>{state.grouped=$('#group-songs').checked;try{localStorage.setItem('farida-grouped',String(state.grouped));}catch{}filtersChanged();};
$('#filter-button').onclick=()=>{const panel=$('#extra-filters');panel.hidden=!panel.hidden;$('#filter-button').setAttribute('aria-expanded',String(!panel.hidden));};
$('#reset-filters').onclick=()=>{['#search','#source-filter','#uploader-filter','#after','#before'].forEach(s=>$(s).value='');$('#sort').value='newest';$('#clip-filter').value=state.filter='included';saveRoute();renderJob();filtersChanged();};
$('#clip-filter').onchange=()=>{state.filter=$('#clip-filter').value;saveRoute();renderJob();filtersChanged();};
const searchInput = $('#search');
let searchTimer, composingSearch = false;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(filtersChanged, 250);
}
searchInput.addEventListener('compositionstart', () => {
  composingSearch = true;
  clearTimeout(searchTimer);
});
searchInput.addEventListener('compositionend', () => {
  composingSearch = false;
  scheduleSearch();
});
searchInput.addEventListener('input', event => {
  guardCatalogResults(catalogScope(parameters()));
  if (!composingSearch && !event.isComposing) scheduleSearch();
});
['#source-filter','#uploader-filter','#after','#before','#sort'].forEach(s=>$(s).onchange=filtersChanged);
function closePageJump(focus=false) {
  $('#page-jump').hidden=true;
  $('#page-controls').hidden=false;
  if(focus)$('#page-number').focus({preventScroll:true});
}
async function goToPage(page) {
  if(!Number.isInteger(page) || page===state.page || page<1 || page>Number($('#page-target').max))return;
  const control=document.activeElement;
  state.page=page;
  await loadClips();
  if(state.view==='catalog' && state.page===page && state.clips?.page===page && document.activeElement===control) {
    const first=$('#clip-rows input[type=checkbox]');
    if(first) {
      first.focus({preventScroll:true});
      $('.table-scroll').scrollIntoView({block:'start',behavior:'instant'});
    }
  }
}
$('#prev-page').onclick=()=>goToPage(state.page-1);
$('#next-page').onclick=()=>goToPage(state.page+1);
$('#page-number').onclick=()=>{
  $('#page-controls').hidden=true;
  $('#page-jump').hidden=false;
  const target=$('#page-target');
  target.value=String(state.page);target.focus();target.select();
};
$('#page-jump').onsubmit=event=>{
  event.preventDefault();
  const target=$('#page-target').valueAsNumber;
  closePageJump(true);goToPage(target);
};
$('#page-jump').onkeydown=event=>{
  if(event.key==='Escape'){event.preventDefault();closePageJump(true);}
};
$('#page-jump').onfocusout=event=>{
  if(!$('#page-jump').contains(event.relatedTarget))closePageJump();
};
$('#sync-button').onclick=()=>startSync();$('#first-scan').onclick=()=>startSync();$('#full-scan').onclick=()=>startSync('full');
$('#export-button').onclick=async()=>{
  const params=parameters();
  if (!params) { notice(searchLimitMessage,true); return; }
  const scope=catalogScope(params);
  // A long query may be a valid video reference. Confirm it before starting a download.
  if (params.get('q')?.length>500 && scope!==displayedCatalogScope) {
    await loadClips();
    if (scope!==displayedCatalogScope || scope!==catalogScope(parameters())) return;
  }
  params.delete('page');params.delete('page_size');location.href='/api/export?'+params;
};
$('#add-source').onclick=()=>showSource();
$('#source-form').onsubmit=async event=>{
  event.preventDefault();
  const draft=state.editSource,dialog=$('#source-dialog');
  if(!dialog.open || !draft || draft.saving)return;
  const {source}=draft;
  const data={display_name:$('#source-name').value.trim(),url:$('#source-url').value.trim(),singing_collection:$('#singing-collection').checked};
  if(!data.display_name && source)data.display_name=source.display_name;
  if(source && data.url===source.canonical_url)delete data.url;
  draft.saving=true;
  setSourceSaving(true);
  $('#source-form-error').textContent='';
  try {
    await api('/api/sources'+(source?'/'+source.id:''),{method:source?'PATCH':'POST',body:JSON.stringify(data)});
    if(state.editSource===draft && dialog.open)dialog.close();
  }catch(error){
    if(state.editSource===draft && dialog.open)$('#source-form-error').textContent=error.message;
    else toast(error.message);
    return;
  }finally{
    draft.saving=false;
    if(state.editSource===draft)setSourceSaving(false);
  }
  toast('来源已保存。');
  try {await loadOverview();}
  catch(error){notice('来源已保存，列表暂时未能刷新。'+error.message,true);}
};
document.addEventListener('keydown',event=>{if(event.key==='/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')){event.preventDefault();if(state.view==='sources')setView('catalog',true);$('#search').focus();}});
window.addEventListener('hashchange',readRoute);
async function poll() {
  if (state.stopping || document.hidden || polling) return;
  polling = true;
  const previousOverview = state.overview;
  try {
    await loadOverview();
    if (document.hidden || state.stopping) return;
    await accountLogin.refresh();
    if (document.hidden || state.stopping) return;
    if (!composingSearch) {
      if ((previousOverview !== state.overview || refreshOnReturn) && state.view === 'catalog') await loadClips();
      refreshOnReturn = false;
    }
  } catch {
    if (state.stopping) return;
    $('#connection-label').textContent='本地服务未连接';$('.status-dot').style.background='var(--danger)';
  } finally {
    polling = false;
    const active = state.overview?.jobs.some(job=>['running','queued'].includes(job.state));
    schedulePoll(active ? 1500 : 10000);
  }
}
async function initializeApp() {
  if(connecting || state.token || state.stopping)return;
  connecting=true;clearTimeout(sessionRetryTimer);
  const retry=$('#retry-session');
  retry.disabled=true;
  let session;
  try {
    session=await api('/api/session');
  } catch {
    $('#connection-retry').hidden=false;
    if(!sessionRetried) {
      sessionRetried=true;
      sessionRetryTimer=setTimeout(()=>{if(!document.hidden)initializeApp();},1200);
    }
    return;
  } finally {
    connecting=false;retry.disabled=false;
  }
  $('#connection-retry').hidden=true;
  state.token=session.token;
  state.preview=!!session.preview_mode;
  if(session.close_with_page)appLifetime.start(state.token);
  $('#preview-notice').hidden=!state.preview;
  $$('[data-quit-app]').forEach(button=>button.hidden=!session.can_shutdown);
  accountLogin.initialize(state.preview);
  const overview=loadOverview().catch(error=>{
    startupOverviewError='暂时无法读取采集状态，将自动重试。'+error.message;
    notice(startupOverviewError,true);
    $('#connection-label').textContent='正在重试本地连接';
    $('.status-dot').style.background='var(--danger)';
    schedulePoll(1500);
  });
  await Promise.all([overview,playlistPlayer.initialize()]);
  readRoute();
  initialViewReady=true;
}
$('#retry-session').onclick=initializeApp;
await initializeApp();

const backupImportLimit=64*1024*1024;
$('#backup-download').onclick=async()=>{
  try {
    await playlistPlayer.persistPreferences();
    await playlistPlayer.remember();
    const file=await api('/api/backup',{asBlob:true});
    const url=URL.createObjectURL(file);
    const link=document.createElement('a');link.href=url;link.download='farida-backup-'+new Date().toISOString().slice(0,10)+'.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast(file.size>backupImportLimit?'已导出完整备份。此文件超过应用可恢复的 64 MiB 上限。':'备份已下载，不含登录凭据。');
  }catch(error){toast(error.message);}
};
$('#backup-restore').onclick=()=>$('#backup-file').click();
$('#backup-file').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  if(file.size>backupImportLimit){toast('可恢复的 JSON 备份上限为 64 MiB。');return;}
  if(!confirm('恢复将替换本机的歌曲目录、来源、收藏、备注和歌单。应用会先保存一份恢复前备份；登录信息不变。继续？'))return;
  $('#backup-restore').disabled=true;
  try {
    await playlistPlayer.persistPreferences();
    await playlistPlayer.remember();
    // Keep the current player intact while validating the file. Once replaced,
    // stale saves from this page must never reach the restored catalog.
    playlistPlayer.persistenceSuspended=true;
    playlistPlayer.updateResumeButton();
    await playlistPlayer.saveChain;
    await api('/api/restore',{method:'POST',body:file});
    playlistPlayer.preferencesReady=false;
    clearTimeout(playlistPlayer.preferencesTimer);
    playlistPlayer.stop();
    alert('恢复完成。你可以在右上角的账号菜单下载上次恢复前的备份。');
    location.reload();
  } catch(error){
    playlistPlayer.persistenceSuspended=false;
    playlistPlayer.updateResumeButton();
    playlistPlayer.persistPreferences();
    playlistPlayer.remember();
    if(!playlistPlayer.video.paused)playlistPlayer.recordHistory();
    toast(error.message);
  } finally{$('#backup-restore').disabled=false;}
};


let listeningHistory=[],historyRequest=0;
async function loadListeningHistory() {
  const request=++historyRequest;$('#listening-history-error').textContent='';
  try {
    const result=await api('/api/listening-history');if(request!==historyRequest)return;
    listeningHistory=result.items;
    $('#listening-history-list').innerHTML=listeningHistory.map((clip,index)=>`<li><button class="history-play" data-history-play="${index}" ${clip.playback_url?'':'disabled'}><span><b>${e(clip.display_song_title)}</b><small>${e(clip.uploader_name)} · ${dateTime(clip.last_played_at)}</small></span>${clip.playback_url?icon('play'):'<small>当前不可用</small>'}</button></li>`).join('');
    $('#listening-history-empty').hidden=!!listeningHistory.length;
    $('#listening-history-clear').disabled=!listeningHistory.length;
    $('#listening-history-count').textContent=`最近 ${listeningHistory.length} 首 · 仅保存在此电脑`;
  }catch(error){if(request===historyRequest)$('#listening-history-error').textContent=error.message;}
}
$('#listening-history-open').onclick=()=>{$('#listening-history-dialog').showModal();loadListeningHistory();};
$('#listening-history-refresh').onclick=loadListeningHistory;
$('#listening-history-list').onclick=event=>{
  const button=event.target.closest('[data-history-play]');if(!button||button.disabled)return;
  const clip=listeningHistory[Number(button.dataset.historyPlay)];
  $('#listening-history-dialog').close();playlistPlayer.start(listeningHistory,'最近播放',clip.id);
};
$('#listening-history-clear').onclick=async()=>{
  if(!confirm('清空最近播放记录？歌曲、歌单和收藏会保留。'))return;
  $('#listening-history-clear').disabled=true;
  try{await api('/api/listening-history',{method:'DELETE'});await loadListeningHistory();toast('最近播放记录已清空。');}
  catch(error){$('#listening-history-error').textContent=error.message;$('#listening-history-clear').disabled=false;}
};
document.addEventListener('farida-history-change',()=>{if($('#listening-history-dialog').open)loadListeningHistory();});
