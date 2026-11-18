// Pointer reordering keeps full playlist indices, including rows hidden by search.
export function bindPlaylistDrag(list,{getItems,onMove}) {
  const dialog=list.closest('dialog');
  const status=document.createElement('span');status.className='sr-only';status.setAttribute('role','status');
  (dialog||list.parentElement).append(status);
  let drag=null,frame=0,suppressClick=false,clickTimer;
  const focusIndex=index=>list.querySelector(`[data-drag-index="${index}"]`)?.focus({preventScroll:true});
  const announce=index=>{status.textContent=`已移到第 ${index+1} 首`;};
  function finish(commit=false) {
    const current=drag;if(!current)return;
    setMarker(null);drag=null;cancelAnimationFrame(frame);frame=0;list.classList.remove('playlist-drag-active');
    current.row.classList.remove('playlist-dragging');current.preview?.remove();
    try {if(current.handle.hasPointerCapture(current.pointerId))current.handle.releasePointerCapture(current.pointerId);}catch{}
    if(current.started){suppressClick=true;clearTimeout(clickTimer);clickTimer=setTimeout(()=>suppressClick=false,0);}
    const items=getItems();
    const unchanged=items.length===current.items.length&&items.every((item,index)=>item===current.items[index]);
    if(commit&&current.started&&current.target!==null&&current.target!==current.from&&unchanged){
      onMove(current.from,current.target);focusIndex(current.target);announce(current.target);
    } else {focusIndex(current.from);if(current.started)status.textContent='已取消调整顺序';}
  }
  function setMarker(row, side) {
    if (row === drag.marker && side === drag.side) return;
    if (drag.marker) drag.marker.classList.remove(drag.side);
    if (row) row.classList.add(side);
    drag.marker = row;
    drag.side = side;
  }
  function withinDropArea(bounds) {
    return drag.x >= bounds.left - 24 && drag.x <= bounds.right + 24
      && drag.y >= bounds.top - 40 && drag.y <= bounds.bottom + 40;
  }
  function target(bounds) {
    drag.target = null;
    if (!withinDropArea(bounds)) {
      setMarker(null);
      return;
    }

    // Hit-test inside the content box. Pointer capture keeps delivering input
    // to the handle; elementFromPoint still reports the row under the pointer.
    const top = bounds.top + list.clientTop;
    const y = Math.max(top + 1, Math.min(top + list.clientHeight - 1, drag.y));
    const x = bounds.left + list.clientLeft + list.clientWidth / 2;
    const row = document.elementFromPoint(x, y)?.closest('li');
    const handle = row?.parentElement === list && row.querySelector('[data-drag-index]');
    if (!handle) {
      setMarker(null);
      return;
    }

    const rect = row.getBoundingClientRect();
    const before = y < rect.top + rect.height / 2;
    const insertion = Number(handle.dataset.dragIndex) + (before ? 0 : 1);
    drag.target = insertion > drag.from ? insertion - 1 : insertion;
    if (drag.target === drag.from) setMarker(null);
    else setMarker(row, before ? 'playlist-drop-before' : 'playlist-drop-after');
  }
  function updateDrag() {
    frame = 0;
    if (!drag?.started) return;
    const bounds = list.getBoundingClientRect();
    drag.preview.style.top = (drag.y - drag.offset) + 'px';
    if (withinDropArea(bounds)) {
      const edge = Math.min(40, list.clientHeight / 4);
      const top = bounds.top + list.clientTop;
      const bottom = top + list.clientHeight;
      const distance = drag.y < top + edge ? drag.y - (top + edge)
        : Math.max(0, drag.y - (bottom - edge));
      if (distance) {
        const previous = list.scrollTop;
        list.scrollTop += Math.max(-12, Math.min(12, distance / 3));
        if (list.scrollTop !== previous) scheduleUpdate();
      }
    }
    target(bounds);
  }
  function scheduleUpdate() {
    if (drag?.started && !frame) frame = requestAnimationFrame(updateDrag);
  }
  function begin() {
    drag.started=true;
    const rect=drag.row.getBoundingClientRect(),preview=drag.row.cloneNode(true);
    preview.classList.add('playlist-drag-preview');preview.setAttribute('aria-hidden','true');
    preview.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id'));
    preview.querySelectorAll('button').forEach(button=>{button.disabled=true;button.tabIndex=-1;});
    Object.assign(preview.style,{position:'fixed',left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,margin:'0',pointerEvents:'none',zIndex:'2000'});
    (dialog||document.body).append(preview);drag.preview=preview;drag.offset=drag.startY-rect.top;
    drag.row.classList.add('playlist-dragging');list.classList.add('playlist-drag-active');
  }
  function down(event) {
    const handle=event.target.closest('[data-drag-index]');
    if(!handle||!list.contains(handle)||handle.disabled||event.button!==0||!event.isPrimary||drag)return;
    const items=getItems(),from=Number(handle.dataset.dragIndex);
    if(!Number.isInteger(from)||from<0||from>=items.length)return;
    event.preventDefault();handle.focus({preventScroll:true});
    drag={handle,row:handle.closest('li'),pointerId:event.pointerId,from,items:[...items],startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,target:null,started:false};
    try {handle.setPointerCapture(event.pointerId);}catch{}
  }
  function move(event) {
    if(!drag||event.pointerId!==drag.pointerId)return;
    event.preventDefault();drag.x=event.clientX;drag.y=event.clientY;
    if(!drag.started&&Math.hypot(drag.x-drag.startX,drag.y-drag.startY)>6)begin();
    scheduleUpdate();
  }
  function up(event) {if(drag&&event.pointerId===drag.pointerId){drag.x=event.clientX;drag.y=event.clientY;if(drag.started)target(list.getBoundingClientRect());finish(true);}}
  function cancel(event) {if(!event||!drag||event.pointerId===undefined||event.pointerId===drag.pointerId)finish();}
  function click(event) {if(suppressClick){event.preventDefault();event.stopImmediatePropagation();suppressClick=false;}}
  function key(event) {
    if(event.key==='Escape'&&drag){event.preventDefault();event.stopPropagation();finish();return;}
    const handle=event.target.closest('[data-drag-index]');
    if(!handle||!list.contains(handle)||!['ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();const from=Number(handle.dataset.dragIndex),to=from+(event.key==='ArrowUp'?-1:1);
    if(to>=0&&to<getItems().length){finish();onMove(from,to);focusIndex(to);announce(to);}
  }
  function hidden(){if(document.hidden)finish();}
  list.addEventListener('scroll',scheduleUpdate,{passive:true});
  list.addEventListener('pointerdown',down);list.addEventListener('lostpointercapture',cancel);list.addEventListener('click',click,true);
  window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',up);
  window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);
  document.addEventListener('keydown',key,true);document.addEventListener('visibilitychange',hidden);
  dialog?.addEventListener('close',cancel);
  const observer=new MutationObserver(()=>{if(drag)finish();});observer.observe(list,{childList:true});
  return {cancel:()=>finish(),destroy(){
    finish();observer.disconnect();clearTimeout(clickTimer);status.remove();
    list.removeEventListener('scroll',scheduleUpdate);
    list.removeEventListener('pointerdown',down);list.removeEventListener('lostpointercapture',cancel);list.removeEventListener('click',click,true);
    window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);
    window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);
    document.removeEventListener('keydown',key,true);document.removeEventListener('visibilitychange',hidden);
    dialog?.removeEventListener('close',cancel);
  }};
}
