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

let storage;
function store() {
  if (!storage) storage = new Promise((resolve, reject) => {
    const req = indexedDB.open('farida-pets',1);
    req.onupgradeneeded = () => req.result.createObjectStore('settings');
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
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

export class Pet {
  constructor() {
    this.node = $('#pet-sprite'); this.version = 2; this.row = 0; this.frame = 0;
    this.manualUntil = 0; this.pointerUntil = 0; this.status = 'idle'; this.lastTick = 0;
    this.motion = localStorage.getItem('pet-motion') !== 'false';
    this.visible = localStorage.getItem('pet-visible') !== 'false';
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.node.addEventListener('click', () => this.gesture(3));
    this.node.addEventListener('dblclick', () => this.gesture(4));
    document.addEventListener('pointermove', e => this.pointer(e));
    $('#pet-settings').onclick = () => $('#pet-dialog').showModal();
    $('#pet-files').onchange = e => this.import(e.target.files);
    $('#pet-visible').checked = this.visible; $('#pet-motion').checked = this.motion;
    $('#pet-visible').onchange = e => { this.visible = e.target.checked; localStorage.setItem('pet-visible',this.visible); this.node.hidden = !this.visible; };
    $('#pet-motion').onchange = e => { this.motion = e.target.checked; localStorage.setItem('pet-motion',this.motion); };
    $('#pet-reset').onclick = async () => {
      try { await storedPet(null,true); this.apply({name:'Frida',version:2,url:'/assets/frida.webp'}); $('#pet-message').textContent = '已恢复默认 Frida。'; }
      catch { toast('无法保存宠物设置，请检查浏览器存储权限。'); }
    };
    this.node.hidden = !this.visible;
  }
  async initialize() {
    try {
      const saved = await storedPet();
      this.apply(saved ? {...saved,url:URL.createObjectURL(saved.blob)} : {name:'Frida',version:2,url:'/assets/frida.webp'});
    } catch { this.apply({name:'Frida',version:2,url:'/assets/frida.webp'}); }
    this.timer = setInterval(() => this.tick(),50);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.lastTick = 0; });
    window.addEventListener('pagehide', () => clearInterval(this.timer),{once:true});
  }
  apply(pet) {
    if (this.url?.startsWith('blob:')) URL.revokeObjectURL(this.url);
    this.url = pet.url; this.version = pet.version; this.name = pet.name || '小伙伴';
    this.node.style.backgroundImage = `url("${this.url}")`;
    this.node.setAttribute('aria-label',`和 ${this.name} 打招呼`);
    this.node.title = `点击挥手，双击跳跃 · ${this.name}`;
    $('#pet-name').textContent = this.name; this.row = 0; this.frame = 0; this.paint();
  }
  paint() {
    const scale = this.node.clientWidth / 192;
    const key = `${this.url}:${this.version}:${this.row}:${this.frame}:${scale}`;
    if (key === this.painted) return;
    this.painted = key;
    this.node.style.backgroundSize = `${1536*scale}px ${ (this.version === 2 ? 2288 : 1872)*scale}px`;
    this.node.style.backgroundPosition = `${-this.frame*192*scale}px ${-this.row*208*scale}px`;
  }
  gesture(row) { this.row=row; this.frame=0; this.manualUntil=performance.now()+STATES[row].reduce((a,b)=>a+b,0); this.lastTick=performance.now(); this.paint(); }
  setStatus(status) { this.status=status; $('#pet-status').textContent = ({idle:'陪你收集喜欢的歌声',running:'正在慢慢收集歌声…',waiting:'等你确认这些片段',failed:'采集暂停，歌声还在',review:'一起找找喜欢的歌'})[status] || '陪你收集喜欢的歌声'; }
  pointer(e) {
    if (this.version !== 2 || !this.motion || this.reduced.matches || this.status === 'running' || performance.now() < this.manualUntil) return;
    const rect = this.node.getBoundingClientRect(), dx=e.clientX-(rect.left+rect.width/2),dy=e.clientY-(rect.top+rect.height/2);
    if (Math.hypot(dx,dy)<45 || Math.hypot(dx,dy)>500) return;
    const index=directionIndex(dx,dy); this.row=9+Math.floor(index/8); this.frame=index%8; this.pointerUntil=performance.now()+900; this.paint();
  }
  tick() {
    if (document.hidden || !this.visible) return;
    const stamp=performance.now();
    if (!this.motion || this.reduced.matches) { this.row=0;this.frame=0;this.paint();return; }
    if (stamp<this.pointerUntil && stamp>this.manualUntil) return;
    const desired=({idle:0,running:7,waiting:6,failed:5,review:8})[this.status] ?? 0;
    if (stamp>this.manualUntil && this.row!==desired) {this.row=desired;this.frame=0;this.lastTick=stamp;}
    const frames=STATES[this.row] || STATES[0];
    if (stamp-this.lastTick>=frames[this.frame]) { this.frame=(this.frame+1)%frames.length;this.lastTick=stamp; }
    this.paint();
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
      await storedPet(pet,true); this.apply({...pet,url:URL.createObjectURL(sheet)});this.gesture(3);
      message.textContent=`已加载 ${pet.name}（v${version}），并保存在此浏览器。`; toast('宠物已加载');
    } catch(error) {message.textContent=error.message || '无法读取宠物文件。';}
    finally {$('#pet-files').value='';}
  }
}
