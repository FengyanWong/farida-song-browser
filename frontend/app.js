import { $, $$, escape as e, icon, hydrateIcons, toast, dateTime } from './ui.js';
import { Pet } from './pet.js';
import { AccountLogin } from './account.js';

hydrateIcons();
const pet = new Pet(); pet.initialize();
const state = {view:'catalog',filter:'included',page:1,pageSize:40,overview:null,clips:null,token:null,preview:false,stopping:false,selected:new Set(),editSource:null,request:0};
const failedCovers = new Set();
const clipFilters = {included:'已收录',bookmarked:'星标收藏',needs_review:'待确认',all:'全部候选',excluded:'已排除'};
const labels = {queued:'等待采集',running:'采集中',paused:'访问受限',failed:'采集未完成',interrupted:'上次运行中断',cancelled:'已取消',completed:'已完成'};
const sourceTypes = {uploader:'UP 主',season:'合集',series:'系列列表',favorites:'收藏夹',search:'标签发现',songlist:'整理歌单'};
let pollTimer;
function schedulePoll(delay) { clearTimeout(pollTimer); if(!state.stopping)pollTimer=setTimeout(poll,delay); }

async function api(path, options={}) {
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Farida-Token':state.token || '',...options.headers}});
  let data;try {data=await response.json();}catch {throw new Error('本地服务返回异常，请重新启动应用。');}
  if (!response.ok) {const error=new Error(typeof data.detail==='string'?data.detail:'请检查输入内容后重试。');error.status=response.status;throw error;}
  return data;
}
function notice(message, error=false) { const el=$('#notice');el.textContent=message;el.hidden=!message;el.classList.toggle('error',error); }
const accountLogin = new AccountLogin(api, async()=>{notice('');await refresh();});
async function quitApp() {
  if(state.stopping)return;
  state.stopping=true;clearTimeout(pollTimer);
  $$('[data-quit-app]').forEach(button=>button.disabled=true);
  try {
    await api('/api/shutdown',{method:'POST'});
    accountLogin.stop();
    $$('dialog[open]').forEach(dialog=>dialog.close());
    $('#shutdown-dialog').showModal();
    $('#connection-label').textContent='应用已退出';
    $('.status-dot').style.background='var(--muted)';
  } catch(error) {
    state.stopping=false;schedulePoll(10000);
    $$('[data-quit-app]').forEach(button=>button.disabled=false);
    toast(error.message);
  }
}
$$('[data-quit-app]').forEach(button=>button.onclick=quitApp);
$('#shutdown-dialog').addEventListener('cancel',event=>event.preventDefault());
document.addEventListener('farida-auth-change',()=>{renderJob();if(state.view==='sources')renderSources();});
function parameters() {
  const result=new URLSearchParams({status:state.filter==='bookmarked'?'all':state.filter,sort:$('#sort').value,page:state.page,page_size:state.pageSize});
  const inputs={q:'#search',source_id:'#source-filter',uploader:'#uploader-filter',after:'#after',before:'#before'};
  for(const [key,selector] of Object.entries(inputs)) if($(selector).value) result.set(key,$(selector).value);
  if(state.filter==='bookmarked')result.set('bookmarked','true');
  return result;
}
function saveRoute() {
  history.replaceState(null,'',`#${state.view}${state.filter==='included'?'':`?filter=${state.filter}`}`);
}
function readRoute() {
  const [view,query]=location.hash.slice(1).split('?');
  const filter=({bookmarks:'bookmarked',review:'needs_review'})[view] || new URLSearchParams(query).get('filter');
  state.filter=Object.hasOwn(clipFilters,filter)?filter:'included';
  setView(view);
}
function setView(view) {
  if(!['catalog','sources'].includes(view))view='catalog';
  state.view=view;state.page=1;clearSelection();
  $$('.nav-item').forEach(el=>{el.classList.toggle('active',el.dataset.view===view);if(el.dataset.view===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  const names={catalog:'片段收藏',sources:'采集来源'};
  $('#page-title').innerHTML=e(names[view])+'<span class="title-dot">.</span>';
  $('#catalog-view').hidden=view==='sources';$('#sources-view').hidden=view!=='sources';
  $('#clip-filter').value=state.filter;$('#export-button').hidden=view==='sources';
  saveRoute();renderJob();
  if(view==='sources'){renderSources();accountLogin.refresh();}else loadClips();
}
function optionList(selector, rows, getValue, getLabel, first) {
  const el=$(selector),selected=el.value;
  el.innerHTML=`<option value="">${first}</option>`+rows.map(r=>`<option value="${e(getValue(r))}">${e(getLabel(r))}</option>`).join('');
  if([...el.options].some(o=>o.value===selected))el.value=selected;
}
async function loadOverview() {
  state.overview=await api('/api/overview');const o=state.overview;
  $('#nav-included').textContent=o.included;
  for(const option of $('#clip-filter').options)option.textContent=`${clipFilters[option.value]} (${option.value==='all'?o.entries:o[option.value]})`;
  $('#count-included').textContent=o.included.toLocaleString();$('#count-submissions').textContent=o.submissions.toLocaleString();
  const configured=o.sources.filter(s=>s.enabled && s.source_type!=='search');const complete=configured.filter(s=>s.last_complete_scan_at);
  $('#coverage-summary').textContent=complete.length?`${complete.length} / ${configured.length} 个来源完成过完整扫描`:'尚未完成完整扫描';
  optionList('#source-filter',o.sources,s=>s.id,s=>s.display_name,'全部来源');
  optionList('#uploader-filter',o.uploaders,s=>s.uid,s=>s.name,'全部 UP 主');
  renderJob();if(state.view==='sources')renderSources();
  $('#connection-label').textContent='本地运行 · 自动保存';$('.status-dot').style.background='var(--green)';
  schedulePoll(o.jobs.some(j=>['running','queued'].includes(j.state))?1500:10000);
}
async function loadClips() {
  const request=++state.request;
  try {
    const result=await api('/api/clips?'+parameters());
    if(request!==state.request)return;
    if(result.total>0 && state.page>Math.ceil(result.total/state.pageSize)) {state.page=Math.ceil(result.total/state.pageSize);return loadClips();}
    state.clips=result;renderClips();
  } catch(error) {notice(error.message,true);}
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
  const available=src && !failedCovers.has(src);
  const label=available?'视频封面':'暂无封面';
  return `<span class="clip-cover" role="img" aria-label="${label}" title="${label}">${icon('music')}${available?`<img src="${e(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="104" height="59">`:''}</span>`;
}
document.addEventListener('error',event=>{
  if(!event.target.matches?.('.clip-cover img'))return;
  const img=event.target,cover=img.parentElement;
  failedCovers.add(img.src);cover.title='封面暂时无法加载';cover.setAttribute('aria-label','封面暂时无法加载');img.remove();
},true);
function renderClips() {
  const result=state.clips;
  $('#clip-rows').innerHTML=result.items.map(clip=>{
    const dates=dateTime(clip.published_at).split(' ');
    const target=clip.playback_url;
    const title=target?`<a class="row-title" href="${e(target)}" target="_blank" rel="noopener noreferrer" data-open="${e(clip.id)}">${e(clip.display_song_title)}</a>`:`<span class="row-title">${e(clip.display_song_title)}</span>`;
    const status=clip.inclusion_status!=='included'?`<span class="badge ${clip.inclusion_status==='needs_review'?'warn':'muted'}">${clip.inclusion_status==='needs_review'?'待确认':'已排除'}</span>`:'';
    return `<tr><td class="check-col"><input type="checkbox" data-select="${e(clip.id)}" aria-label="选择 ${e(clip.display_song_title)}" ${state.selected.has(clip.id)?'checked':''}></td><td><div class="clip-content">${coverImage(clip.thumbnail_url)}<div class="clip-text">${title}<div class="row-subtitle">${clip.part_count>1?`<span class="part-badge">P${clip.part_number}</span>`:''}<span class="original-title" title="${e(clip.raw_title)}">${clip.raw_title!==clip.display_song_title?e(clip.raw_title):''}</span>${status}${clip.has_curated_credit?'<span class="badge">歌单 · CLANNADOR</span>':''}${!target?'<span class="badge warn">当前不可用</span>':''}</div></div></div></td><td class="row-uploader-cell"><span class="row-uploader" title="UID ${e(clip.uploader_uid)}">${e(clip.uploader_name)}</span></td><td class="row-date">${e(dates[0])}<small>${e(dates.slice(1).join(' '))}</small></td><td><div class="row-actions"><button class="icon-button ${clip.bookmarked?'active':''}" data-bookmark="${e(clip.id)}" aria-label="${clip.bookmarked?'取消收藏':'收藏'} ${e(clip.display_song_title)}" title="${clip.bookmarked?'取消收藏':'收藏'}">${icon('star')}</button><button class="icon-button" data-detail="${e(clip.id)}" aria-label="查看 ${e(clip.display_song_title)} 的详情" title="详情与修正">${icon('more')}</button></div></td></tr>`;
  }).join('');
  const empty=$('#empty-state');empty.hidden=result.total>0;
  if(!result.total) {
    const o=state.overview || {}, filtered=$('#search').value||$('#source-filter').value||$('#after').value||$('#before').value||$('#uploader-filter').value;
    const heading=filtered?'没有找到匹配的片段':state.filter==='bookmarked'?'把喜欢的片段留在这里':state.filter==='needs_review'?'目前没有待确认的片段':o.entries?'暂时没有符合此状态的片段':'等待歌声汇聚';
    const description=filtered?'试试其他关键词，或调整筛选条件。':state.filter==='bookmarked'?'点击片段旁的星标，就能加入收藏。':state.filter==='needs_review'?'新发现的模糊内容会在这里等待你确认。':o.entries?'在筛选菜单中选择「全部候选」或「待确认」完善收录。':'启动并验证登录后，会自动检查所有已启用来源。<br>采集到的片段会逐条出现在这里。';
    $('h2',empty).textContent=heading;$('p',empty).innerHTML=description;
    $('#first-scan').hidden=!!(filtered||o.entries||state.filter!=='included');
  }
  $('#result-count').textContent=`${result.total.toLocaleString()} 个片段${result.total?` · 显示 ${(state.page-1)*state.pageSize+1}–${Math.min(state.page*state.pageSize,result.total)}`:''}`;
  $('#page-number').textContent=`${state.page} / ${Math.max(1,Math.ceil(result.total/state.pageSize))}`;
  $('#prev-page').disabled=state.page===1;$('#next-page').disabled=state.page*state.pageSize>=result.total;
  updateSelection();
}
function errorText(error) {
  if(!error)return '';
  if(error.category==='restricted')return `哔哩哔哩限制了访问${error.upstream_code?`（${error.upstream_code}）`:error.http_status?`（HTTP ${error.http_status}）`:''}。已暂停。可在右上角账号菜单检查登录；若已登录，请稍后再试。`;
  if(error.category==='authentication')return '登录已失效，请在右上角账号菜单重新登录后再采集。';
  if(error.category==='network')return '网络连接失败，已保存的内容仍然可用。';
  if(error.category==='pagination')return '分页未完整结束；已保存进度，尚不能确认完整覆盖。';
  if(error.category==='identity')return '返回的身份与配置不一致，请检查来源 UID。';
  if(error.category==='video_identity')return '某条投稿的主投稿人或联合创作者未能与来源核对，已保存进度。';
  if(error.category==='schema')return '哔哩哔哩返回的数据格式有变化，已停止此次采集并保留已有内容。';
  if(error.category==='server')return '哔哩哔哩服务暂时不可用，请稍后继续任务。';
  if(error.category==='retry_later')return '哔哩哔哩要求稍后重试，已暂停采集。';
  if(error.category==='internal')return '本地采集出现错误，已保存进度。可重新启动应用，或查看使用说明中的排查方法。';
  return error.message || '采集未完成，已保存进度。';
}
function renderJob() {
  const jobs=state.overview?.jobs || [];const active=jobs.find(j=>['running','queued'].includes(j.state));
  const blocked=!!active||!accountLogin.canCollect();
  $('#sync-button').disabled=blocked;$('#first-scan').disabled=blocked;$('#full-scan').disabled=blocked;
  const banner=$('#job-banner');banner.hidden=!active;
  if(active) {
    const running=Object.entries(active.checkpoints).find(([,p])=>p.state==='running');
    const source=state.overview.sources.find(s=>String(s.id)===running?.[0]);
    const progress=running?.[1];
    banner.innerHTML=`<span class="spinner"></span><span>${active.mode==='full'?'完整采集':'采集更新'} · ${e(source?.display_name || '准备中')} ${progress?.current_page?`· 第 ${progress.current_page} 页`:''} · 已处理 ${active.processed} 个视频</span><button class="button secondary small" data-cancel="${e(active.id)}" ${active.cancel_requested?'disabled':''}>${active.cancel_requested?'正在取消…':'取消采集'}</button>`;
    pet.setStatus('running');
  } else if(jobs[0] && ['paused','failed','interrupted'].includes(jobs[0].state)) {
    if(jobs[0].errors[0])notice(errorText(jobs[0].errors[0]));
    pet.setStatus('failed');
  } else pet.setStatus(state.view==='catalog' && state.filter==='needs_review'?'waiting':'idle');
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
    const latestJob=state.overview.jobs.find(job=>job.checkpoints?.[String(source.id)]);
    const skipped=latestJob?skippedVideos({checkpoints:{[source.id]:latestJob.checkpoints[String(source.id)]}}):'';
    const subtitle=curated?'CLANNADOR 整理':search?'法里达 + 直播切片':`UID ${e(source.uid)}`;
    const dates=curated?`${source.listed_songs || 0} 首歌 · ${source.linked_songs || 0} 个 BV 链接<br>歌单读取：${dateTime(source.list_fetched_at)}<br>每次更新重读歌单，补齐新增视频。<br><a href="https://fareeda.songlist.cc/" target="_blank" rel="noopener noreferrer">查看原歌单 ↗</a>`:search?`上次标签发现：${dateTime(source.last_discovery_at)}<br>仅保留实际标签同时匹配的歌唱内容；其他候选待确认。`:`完整扫描：${source.last_complete_scan_at?dateTime(source.last_complete_scan_at):'尚未完成'}<br>最近更新：${dateTime(source.last_refresh_at)}`;
    return `<article class="source-card ${source.enabled?'':'disabled'}"><div class="source-card-top"><span class="source-avatar">${search?icon('search'):e(source.display_name[0])}</span><div><h3>${e(source.display_name)}</h3><small>${subtitle}${source.resolved_name && source.resolved_name!==source.display_name?` · 当前名称 ${e(source.resolved_name)}`:''}</small></div>${!search&&!curated?`<button class="icon-button" data-edit-source="${source.id}" title="编辑来源" aria-label="编辑 ${e(source.display_name)}" ${active?'disabled':''}>${icon('settings')}</button>`:''}</div><div class="source-meta"><span class="badge">${sourceTypes[source.source_type]}</span><span class="badge ${verified?'ok':'warn'}">${curated?(verified?'歌单已读取':'等待读取'):search?'有限搜索发现':verified?'身份已核对':'身份待核对'}</span>${!source.enabled?'<span class="badge muted">已停用</span>':''}</div><div class="source-stats"><span>${source.submissions} 个原视频</span><span>${source.entries} 个片段</span></div><div class="source-dates">${dates}</div>${skipped}${source.last_error?`<div class="source-error">${e(errorText(source.last_error))}</div>`:''}<div class="source-actions"><button class="button small" data-scan-source="${source.id}" ${active||!source.enabled?'disabled':''}>${curated?'更新歌单':search?'发现片段':'采集更新'}</button>${!search&&!curated?`<button class="button small" data-full-source="${source.id}" ${active||!source.enabled?'disabled':''}>完整扫描</button>`:''}<button class="text-button" data-toggle-source="${source.id}" ${active?'disabled':''}>${source.enabled?'停用':'启用'}</button></div></article>`;
  }).join('');
  $('#job-history').innerHTML=state.overview.jobs.length?state.overview.jobs.map(job=>`<div class="history-item"><span class="badge ${job.state==='completed'?'ok':job.state==='running'?'':'warn'}">${labels[job.state] || e(job.state)}</span><span>${job.mode==='full'?'完整采集':'最近更新'} · ${job.processed} 个视频</span><span class="history-time">${dateTime(job.started_at)}</span>${['failed','paused','interrupted','cancelled'].includes(job.state)?`<button class="button small" data-resume="${e(job.id)}" ${active?'disabled':''}>继续任务</button>`:''}${job.errors.length?`<div class="history-error">${e(errorText(job.errors[0]))}</div>`:''}${skippedVideos(job)}</div>`).join(''):'<div class="history-empty">还没有采集记录</div>';
}
async function startSync(mode='incremental',sourceIds=[]) {
  try {notice('');await api('/api/sync',{method:'POST',body:JSON.stringify({mode,source_ids:sourceIds})});await loadOverview();toast('采集任务已启动，内容会逐条保存。');}
  catch(error){notice(error.message,true);if(error.status===401)await accountLogin.requireLogin();}
}
async function refresh() {try {await loadOverview();if(state.view!=='sources')await loadClips();}catch(error){notice(error.message,true);$('#connection-label').textContent='本地服务未连接';$('.status-dot').style.background='var(--danger)';}}
function clearSelection() {state.selected.clear();updateSelection();}
function updateSelection() {
  $('#bulk-bar').hidden=!state.selected.size;$('#selected-count').textContent=`已选择 ${state.selected.size} 项`;
  const items=state.clips?.items || [];$('#select-page').checked=items.length>0 && items.every(i=>state.selected.has(i.id));
  $$('[data-select]').forEach(el=>el.checked=state.selected.has(el.dataset.select));
}
function filtersChanged() {state.page=1;clearSelection();loadClips();}
function showSource(source) {
  state.editSource=source || null;$('#source-name').value=source?.display_name || '';$('#source-url').value=source?.canonical_url || '';
  $('#singing-collection').checked=!!source?.singing_collection;$('#source-form-error').textContent='';$('#source-dialog-title').textContent=source?'编辑来源':'添加来源';$('#source-dialog').showModal();
}
async function showDetail(id) {
  const clip=await api('/api/clips/'+encodeURIComponent(id));const el=$('#detail-content');
  const credit=clip.songlist_credits?.length?`<dt>歌单整理</dt><dd><a href="https://fareeda.songlist.cc/" target="_blank" rel="noopener noreferrer">CLANNADOR · 小法的歌单 ↗</a><br>${clip.songlist_credits.map(song=>`${e(song.song_title)}${song.original_artist?` · 原唱 ${e(song.original_artist)}`:''}`).join('<br>')}</dd>`:'';
  el.innerHTML=`<div class="dialog-heading"><h2>片段详情</h2><button class="icon-button close-dialog" aria-label="关闭">${icon('x')}</button></div><h3 class="detail-title">${e(clip.display_song_title)}</h3><div class="detail-original">${e(clip.raw_title)}</div><dl class="detail-grid"><dt>UP 主</dt><dd>${e(clip.uploader_name)} · UID ${e(clip.uploader_uid)}</dd><dt>上传时间</dt><dd>${dateTime(clip.published_at)}（当前时区）</dd><dt>分 P 信息</dt><dd>P${clip.part_number} · ${e(clip.raw_part_title)} · CID ${e(clip.cid)}</dd><dt>判断依据</dt><dd>${e(clip.classification_reason)}${clip.manual_fields.length?' · 含手动修正':''}</dd><dt>来源</dt><dd>${clip.sources.map(s=>e(s.display_name)).join('、')}</dd>${credit}</dl><div class="tag-list">${clip.tags.map(tag=>`<span class="badge">${e(tag)}</span>`).join('')}</div><div class="review-actions"><button class="button primary small" data-classify="included" data-id="${e(id)}">确认收录</button><button class="button secondary small" data-classify="excluded" data-id="${e(id)}">排除此片段</button><button class="button secondary small" data-classify="needs_review" data-id="${e(id)}">保留待确认</button>${clip.playback_url?`<a class="button secondary small" href="${e(clip.playback_url)}" data-open="${e(id)}" target="_blank" rel="noopener noreferrer">${icon('external')}打开原视频</a>`:''}</div><details><summary>修改歌名、分组与备注</summary><form id="annotation-form" data-id="${e(id)}"><label class="field">显示歌名<input name="display_song_title" required maxlength="500" value="${e(clip.display_song_title)}"></label><label class="field">歌曲分组<input name="song_group" maxlength="200" value="${e(clip.song_group)}" placeholder="用于归拢不同演唱版本"></label><label class="field">个人备注<input name="notes" maxlength="5000" value="${e(clip.notes)}"></label><button class="button primary small">保存修正</button></form></details><details><summary>原始描述与数据来源</summary><div class="detail-description">${e(clip.description || '暂无描述')}</div><p class="detail-stats">${Object.entries(clip.statistics).map(([key,v])=>`${({view:'播放',like:'点赞',coin:'投币',favorite:'收藏',share:'分享',reply:'评论',danmaku:'弹幕'})[key]}：${v==null?'未知':v.toLocaleString()}`).join(' · ')}<br>以上为整个原视频的统计，不是此分 P 的单独统计。<br>获取于 ${dateTime(clip.stats_fetched_at)} · ${e(clip.provenance.details)}</p></details>`;
  if(!$('#detail-dialog').open)$('#detail-dialog').showModal();
}

document.addEventListener('click',async event=>{
  const button=event.target.closest('button,a');if(!button || button.disabled)return;
  try {
    if(button.matches('.close-dialog'))button.closest('dialog').close();
    if(button.dataset.view)setView(button.dataset.view);
    if(button.dataset.open && !(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)) {
      event.preventDefault();const result=await api(`/api/clips/${encodeURIComponent(button.dataset.open)}/open`,{method:'POST'});
      if(!result.opened)toast('无法启动默认浏览器，请使用原视频链接。',result.url);
    }
    if(button.dataset.bookmark){const clip=state.clips.items.find(c=>c.id===button.dataset.bookmark);await api(`/api/clips/${encodeURIComponent(clip.id)}/bookmark`,{method:'PATCH',body:JSON.stringify({bookmarked:!clip.bookmarked})});await refresh();}
    if(button.dataset.detail)await showDetail(button.dataset.detail);
    if(button.dataset.classify){await api(`/api/clips/${encodeURIComponent(button.dataset.id)}/annotation`,{method:'PATCH',body:JSON.stringify({inclusion_status:button.dataset.classify})});$('#detail-dialog').close();clearSelection();await refresh();toast('已保存你的决定，后续采集会保留。');}
    if(button.dataset.bulk){await api('/api/review/bulk',{method:'PATCH',body:JSON.stringify({ids:[...state.selected],inclusion_status:button.dataset.bulk})});clearSelection();await refresh();toast('已保存选中片段的决定。');}
    if(button.dataset.cancel){await api(`/api/sync/${button.dataset.cancel}/cancel`,{method:'POST'});await loadOverview();}
    if(button.dataset.resume){notice('');await api(`/api/sync/${button.dataset.resume}/resume`,{method:'POST'});await loadOverview();}
    if(button.dataset.scanSource)await startSync('incremental',[Number(button.dataset.scanSource)]);
    if(button.dataset.fullSource)await startSync('full',[Number(button.dataset.fullSource)]);
    if(button.dataset.editSource)showSource(state.overview.sources.find(s=>s.id===Number(button.dataset.editSource)));
    if(button.dataset.toggleSource){const source=state.overview.sources.find(s=>s.id===Number(button.dataset.toggleSource));await api('/api/sources/'+source.id,{method:'PATCH',body:JSON.stringify({enabled:!source.enabled})});await loadOverview();}
  }catch(error){notice(error.message,true);toast(error.message);if(error.status===401)await accountLogin.requireLogin();}
});
document.addEventListener('submit',async event=>{
  if(event.target.id!=='annotation-form')return;event.preventDefault();
  try{await api(`/api/clips/${encodeURIComponent(event.target.dataset.id)}/annotation`,{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});$('#detail-dialog').close();await refresh();toast('修正已保存。');}catch(error){toast(error.message);}
});
document.addEventListener('change',event=>{if(event.target.dataset.select){event.target.checked?state.selected.add(event.target.dataset.select):state.selected.delete(event.target.dataset.select);updateSelection();}});
$('#select-page').onchange=event=>{state.clips?.items.forEach(clip=>event.target.checked?state.selected.add(clip.id):state.selected.delete(clip.id));updateSelection();};
$('#clear-selection').onclick=clearSelection;
$('#filter-button').onclick=()=>{const panel=$('#extra-filters');panel.hidden=!panel.hidden;$('#filter-button').setAttribute('aria-expanded',String(!panel.hidden));};
$('#reset-filters').onclick=()=>{['#search','#source-filter','#uploader-filter','#after','#before'].forEach(s=>$(s).value='');$('#sort').value='newest';$('#clip-filter').value=state.filter='included';saveRoute();renderJob();filtersChanged();};
$('#clip-filter').onchange=()=>{state.filter=$('#clip-filter').value;saveRoute();renderJob();filtersChanged();};
let debounce;$('#search').oninput=()=>{clearTimeout(debounce);debounce=setTimeout(filtersChanged,250);};
['#source-filter','#uploader-filter','#after','#before','#sort'].forEach(s=>$(s).onchange=filtersChanged);
$('#prev-page').onclick=()=>{state.page--;clearSelection();loadClips();};$('#next-page').onclick=()=>{state.page++;clearSelection();loadClips();};
$('#sync-button').onclick=()=>startSync();$('#first-scan').onclick=()=>startSync();$('#full-scan').onclick=()=>startSync('full');
$('#export-button').onclick=()=>{const params=parameters();params.delete('page');params.delete('page_size');location.href='/api/export?'+params;};
$('#add-source').onclick=()=>showSource();
$('#source-form').onsubmit=async event=>{
  event.preventDefault();$('#source-form-error').textContent='';
  const data={display_name:$('#source-name').value.trim(),url:$('#source-url').value.trim(),singing_collection:$('#singing-collection').checked};
  if(!data.display_name && state.editSource)data.display_name=state.editSource.display_name;
  if(state.editSource && data.url===state.editSource.canonical_url)delete data.url;
  try{await api('/api/sources'+(state.editSource?'/'+state.editSource.id:''),{method:state.editSource?'PATCH':'POST',body:JSON.stringify(data)});$('#source-dialog').close();await loadOverview();toast('来源已保存。');}catch(error){$('#source-form-error').textContent=error.message;}
};
document.addEventListener('keydown',event=>{if(event.key==='/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')){event.preventDefault();if(state.view==='sources')setView('catalog');$('#search').focus();}});
window.addEventListener('hashchange',readRoute);
async function poll(){if(state.stopping)return;if(document.hidden){schedulePoll(10000);return;}try{const active=state.overview?.jobs.some(j=>['running','queued'].includes(j.state));await loadOverview();await accountLogin.refresh();if(active && state.view!=='sources')await loadClips();}catch{if(state.stopping)return;$('#connection-label').textContent='本地服务未连接';$('.status-dot').style.background='var(--danger)';schedulePoll(10000);}}
try {const session=await api('/api/session');state.token=session.token;state.preview=!!session.preview_mode;$('#preview-notice').hidden=!state.preview;$$('[data-quit-app]').forEach(button=>button.hidden=!session.can_shutdown);accountLogin.initialize(state.preview);await loadOverview();readRoute();}catch(error){notice('无法连接本地服务，请重新打开法里达 EXE。'+error.message,true);}
