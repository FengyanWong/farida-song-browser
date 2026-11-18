import { $, toast } from './ui.js';

// Layout contract: 192x208 cells, eight columns; unused columns never animate.
export const STATES = [
  [280,110,110,140,140,320],
  [120,120,120,120,120,120,120,220],
  [120,120,120,120,120,120,120,220],
  [140,140,140,280],
  [140,140,140,140,280],
  [140,140,140,140,140,140,140,240],
  [150,150,150,150,150,260],
  [120,120,120,120,120,220],
  [150,150,150,150,150,280],
];
export function spriteVersion(width, height) {
  if (width !== 1536 || ![1872,2288].includes(height)) throw new Error('尺寸不符：v1 应为 1536×1872，v2 应为 1536×2288。');
  return height === 2288 ? 2 : 1;
}
export function directionIndex(dx, dy) { return Math.round((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360 / 22.5) % 16; }

const DEFAULT_PET = {name:'Frida', version:2, url:'/assets/frida.webp'};
let storage;
function store() {
  if (!storage) storage = new Promise((resolve, reject) => {
    const req = indexedDB.open('farida-pets',1);
    req.onupgradeneeded = () => req.result.createObjectStore('settings');
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  }).catch(error => {
    storage = undefined;
    throw error;
  });
  return storage;
}
async function storedPet(value, write=false) {
  const db = await store();
  return new Promise((resolve,reject) => {
    const tx = db.transaction('settings',write?'readwrite':'readonly');
    const objectStore = tx.objectStore('settings');
    const req = write ? value ? objectStore.put(value,'pet') : objectStore.delete('pet') : objectStore.get('pet');
    tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}

async function savePet(pet) {
  try { await storedPet(pet,true); return true; }
  catch { return false; }
}

export class Pet {
  constructor() {
    this.node = $('#pet-sprite'); this.version = 2; this.row = 0; this.frame = 0;
    this.manualUntil = 0; this.pointerUntil = 0; this.status = 'idle'; this.pageActive = true;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.node.addEventListener('click', () => this.gesture(3));
    this.node.addEventListener('dblclick', () => this.gesture(4));
    this.onPointer = e => this.pointer(e);
    document.addEventListener('visibilitychange', () => this.resetAnimation());
    window.addEventListener('pagehide', () => this.setPageActive(false));
    window.addEventListener('pageshow', () => this.setPageActive(true));
    this.reduced.addEventListener('change', () => this.resetAnimation());
    this.resize = new ResizeObserver(() => { if (this.visible && this.pageActive && !document.hidden) this.paint(); });
    this.resize.observe(this.node);
    $('#pet-settings').onclick = () => $('#pet-dialog').showModal();
    $('#pet-files').onchange = e => this.import(e.target.files);
    for (const option of ['visible','motion']) {
      const control = $('#pet-' + option);
      try { this[option] = localStorage.getItem(control.id) !== 'false'; }
      catch { this[option] = true; }
      control.checked = this[option];
      control.onchange = () => {
        this[option] = control.checked;
        this.node.hidden = !this.visible;
        this.resetAnimation();
        try { localStorage.setItem(control.id, String(control.checked)); }
        catch { $('#pet-message').textContent = '此设置仅在当前页面生效。'; }
      };
    }
    $('#pet-reset').onclick = async () => {
      const saved = await savePet(null);
      this.apply(DEFAULT_PET);
      $('#pet-message').textContent = saved ? '已恢复默认 Frida。' : '已在当前页面恢复默认 Frida，浏览器未能保存此设置。';
    };
    this.node.hidden = !this.visible;
  }
  async initialize() {
    try {
      const saved = await storedPet();
      this.apply(saved ? {...saved,url:URL.createObjectURL(saved.blob)} : DEFAULT_PET);
    } catch { this.apply(DEFAULT_PET); }
  }
  apply(pet) {
    if (this.url?.startsWith('blob:')) URL.revokeObjectURL(this.url);
    this.url = pet.url; this.version = pet.version; this.name = pet.name || '小伙伴';
    this.node.style.backgroundImage = `url("${this.url}")`;
    this.node.setAttribute('aria-label',`和 ${this.name} 打招呼`);
    this.node.title = `点击挥手，双击跳跃 · ${this.name}`;
    $('#pet-name').textContent = this.name; this.resetAnimation();
  }
  paint() {
    const scale = this.node.clientWidth / 192;
    const key = `${this.url}:${this.version}:${this.row}:${this.frame}:${scale}`;
    if (key === this.painted) return;
    this.painted = key;
    this.node.style.backgroundSize = `${1536*scale}px ${ (this.version === 2 ? 2288 : 1872)*scale}px`;
    this.node.style.backgroundPosition = `${-this.frame*192*scale}px ${-this.row*208*scale}px`;
  }
  setPageActive(active) {
    this.pageActive = active;
    this.resetAnimation();
  }
  canAnimate() {
    return this.url && this.pageActive && this.visible && !document.hidden && this.motion && !this.reduced.matches;
  }
  resetAnimation() {
    clearTimeout(this.timer);
    this.manualUntil = this.pointerUntil = 0;
    document.removeEventListener('pointermove', this.onPointer);
    if (!this.url || !this.pageActive || document.hidden || !this.visible) return;
    if (this.canAnimate()) {
      if (this.version === 2) document.addEventListener('pointermove', this.onPointer, {passive: true});
      this.row = this.statusRow();
      this.frame = 0;
      this.schedule(STATES[this.row][0]);
    } else {
      this.row = this.frame = 0;
    }
    this.paint();
  }
  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.ceil(delay));
  }
  statusRow() { return ({idle:0,running:7,waiting:6,failed:5,review:8})[this.status] ?? 0; }
  gesture(row) {
    if (!this.canAnimate()) return;
    this.row = row; this.frame = 0; this.pointerUntil = 0;
    this.manualUntil = performance.now() + STATES[row].reduce((sum, duration) => sum + duration, 0);
    this.paint(); this.schedule(STATES[row][0]);
  }
  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    $('#pet-status').textContent = ({idle:'陪你收集喜欢的歌声',running:'正在慢慢收集歌声…',waiting:'等你确认这些片段',failed:'采集暂停，歌声还在',review:'一起找找喜欢的歌'})[status] || '陪你收集喜欢的歌声';
    if (this.canAnimate() && performance.now() >= this.manualUntil) this.resetAnimation();
  }
  pointer(e) {
    if (this.status === 'running' || performance.now() < this.manualUntil) return;
    const rect = this.node.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width/2), dy = e.clientY - (rect.top + rect.height/2);
    const distance = Math.hypot(dx,dy);
    if (distance < 45 || distance > 500) return;
    const index = directionIndex(dx,dy);
    if (!this.pointerUntil) this.schedule(900);
    this.pointerUntil = performance.now() + 900;
    const row = 9 + Math.floor(index/8), frame = index % 8;
    if (this.row === row && this.frame === frame) return;
    this.row = row; this.frame = frame; this.paint();
  }
  tick() {
    if (!this.canAnimate()) return;
    const stamp = performance.now();
    if (this.pointerUntil > stamp) { this.schedule(this.pointerUntil - stamp); return; }
    this.pointerUntil = 0;
    const row = this.manualUntil > stamp ? this.row : this.statusRow();
    this.frame = this.row === row ? (this.frame + 1) % STATES[row].length : 0;
    this.row = row;
    this.paint(); this.schedule(STATES[row][this.frame]);
  }
  async import(files) {
    const message=$('#pet-message'); message.textContent='正在检查精灵图…';
    try {
      const list=[...files], sheet=list.find(f=>/\.(png|webp)$/i.test(f.name)), config=list.find(f=>/\.json$/i.test(f.name));
      if (!sheet) throw new Error('请选择 PNG 或 WebP 精灵图；pet.json 可一并选择。');
      if (sheet.size>20*1024*1024 || !sheet.size) throw new Error('精灵图必须在 1 字节至 20 MB 之间。');
      if (config && config.size>65536) throw new Error('pet.json 超过 64 KB。');
      const bytes=new Uint8Array(await sheet.slice(0,12).arrayBuffer());
      const png=bytes[0]===137 && bytes[1]===80 && bytes[2]===78 && bytes[3]===71;
      const webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP';
      if (!png && !webp) throw new Error('文件内容不是 PNG 或 WebP。');
      const bitmap=await createImageBitmap(sheet);
      const version=spriteVersion(bitmap.width,bitmap.height);
      const metadata=config ? JSON.parse(await config.text()) : {};
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('pet.json 必须是一个 JSON 对象。');
      if (metadata.spriteVersionNumber != null && Number(metadata.spriteVersionNumber)!==version) throw new Error('pet.json 版本与精灵图尺寸不一致。');
      const canvas=document.createElement('canvas'); canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(bitmap,0,0);bitmap.close();
      let hasTransparency=false;
      for (let row=0;row<(version===2?11:9);row++) {
        const frames=row<9?STATES[row].length:8;
        for(let frame=0;frame<frames;frame++) {
          const pixels=ctx.getImageData(frame*192,row*208,192,208).data;
          let hasSprite=false;
          for(let i=3;i<pixels.length;i+=4) {if(pixels[i]>0)hasSprite=true;if(pixels[i]===0)hasTransparency=true;}
          if (!hasSprite) throw new Error(`第 ${row+1} 行第 ${frame+1} 帧为空。`);
        }
      }
      if (!hasTransparency) throw new Error('请选择带透明背景的精灵图。');
      const pet={name:String(metadata.displayName || sheet.name.replace(/\.(png|webp)$/i,'')).slice(0,80),version,blob:sheet};
      const saved = await savePet(pet);
      this.apply({...pet,url:URL.createObjectURL(sheet)}); this.gesture(3);
      const persistence = saved ? '并保存在此浏览器' : '仅在当前页面生效';
      message.textContent = `已加载 ${pet.name}（v${version}），${persistence}。`; toast('宠物已加载');
    } catch(error) {message.textContent=error.message || '无法读取宠物文件。';}
    finally {$('#pet-files').value='';}
  }
}
