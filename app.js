'use strict';
const $ = id => document.getElementById(id);
const s = {
  source: 'file', file: null, url: null, count: 5, length: 45, duration: 0,
  clips: [], outputs: [], cameraEnabled: true, cropMode: 'cam', busy: false,
  cam: {x:.025,y:.025,w:.28,h:.31}, game: {x:.05,y:.10,w:.92,h:.86},
  objectUrl: null, drag: null, previewLoop: 0, fileName: 'stream', audioContext:null,
  audioOut:null, streamAudioSource:null, gameName:'', descriptions:{}
};
let toastTimeout;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const fmt = x => `${Math.floor(x/60)}:${String(Math.floor(x%60)).padStart(2,'0')}`;
function toast(msg) {
  $('toast').textContent = msg; $('toast').classList.add('show');
  clearTimeout(toastTimeout); toastTimeout = setTimeout(()=>$('toast').classList.remove('show'),6800);
}
function setProgress(title, detail, amount=0) {
  $('progressCard').hidden=false; $('progressTitle').textContent=title;
  $('progressDetail').textContent=detail; $('progressPercent').textContent=`${Math.round(amount)}%`;
  $('progressFill').style.width=`${amount}%`; $('progressState').textContent=amount>=100?'Completado':'Procesando';
}
function switchTab(mode) {
  s.source=mode; $('tabFile').classList.toggle('active',mode==='file'); $('tabUrl').classList.toggle('active',mode==='url');
  $('fileMode').hidden=mode!=='file'; $('urlMode').hidden=mode!=='url';
}
$('tabFile').onclick=()=>switchTab('file'); $('tabUrl').onclick=()=>switchTab('url');
$('clipCount').oninput=()=>{$('countValue').textContent=$('clipCount').value};
$('videoFile').onchange=()=>{
  s.file=$('videoFile').files?.[0]||null;
  if(s.file){$('dropTitle').textContent=s.file.name;$('dropHint').textContent=`${(s.file.size/1048576).toFixed(0)} MB · Video seleccionado`;}
};
for(const e of ['dragover','dragenter']) $('dropZone').addEventListener(e,ev=>{ev.preventDefault();$('dropZone').classList.add('drag')});
for(const e of ['drop','dragleave']) $('dropZone').addEventListener(e,ev=>{ev.preventDefault();$('dropZone').classList.remove('drag');if(e==='drop' && ev.dataTransfer?.files?.[0]) {s.file=ev.dataTransfer.files[0];$('dropTitle').textContent=s.file.name;$('dropHint').textContent='Video listo para analizar';}});
async function getSource() {
  if(s.source==='file') {
    if(!s.file)throw Error('Primero selecciona una grabación MP4 o WebM.');
    if(!(s.file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(s.file.name)))throw Error('Ese archivo no parece un video compatible.');
    return {file:s.file,url:URL.createObjectURL(s.file),name:s.file.name};
  }
  const link=$('videoUrl').value.trim(); if(!link)throw Error('Pega una URL o sube una grabación.');
  let u;try{u=new URL(link)}catch{throw Error('La URL no es válida.')}
  if(!['http:','https:'].includes(u.protocol))throw Error('Solo se admiten enlaces HTTP o HTTPS.');
  if(/(^|\.)(twitch\.tv|kick\.com)$/.test(u.hostname.replace(/^www\./,'')))
    throw Error('Twitch y Kick requieren acceso autorizado al VOD desde un servidor. Esta edición gratuita no puede leer esos enlaces directamente; carga un MP4 del directo.');
  if(!/\.mp4($|\?)/i.test(u.pathname+u.search) && !/\.webm($|\?)/i.test(u.pathname+u.search))
    throw Error('Para usar un enlace debe ser un archivo MP4 o WebM público, no una página de reproducción.');
  toast('Descargando video directo… El sitio de origen debe permitir acceso desde el navegador.');
  const res=await fetch(u.href);if(!res.ok)throw Error(`El servidor del video respondió ${res.status}.`);
  const blob=await res.blob();if(!blob.size)throw Error('El enlace devolvió un archivo vacío.');
  return {file:new File([blob],'directo.mp4',{type:blob.type||'video/mp4'}),url:URL.createObjectURL(blob),name:'directo.mp4'};
}
function loadVideo(video, url) {
  return new Promise((resolve,reject)=>{
    const tm=setTimeout(()=>{cleanup();reject(Error('El navegador no pudo leer el video. Prueba un MP4 H.264.'))},20000);
    const ok=()=>{cleanup();resolve()}; const fail=()=>{cleanup();reject(Error('El archivo no se puede reproducir en este navegador.'))};
    const cleanup=()=>{clearTimeout(tm);video.removeEventListener('loadedmetadata',ok);video.removeEventListener('error',fail)};
    video.addEventListener('loadedmetadata',ok);video.addEventListener('error',fail);video.src=url;video.load();
    if(video.readyState>=1)ok();
  });
}
function seek(video,time){
  const target=clamp(time,0,Math.max(0,video.duration-.05));
  if(Math.abs(video.currentTime-target)<.08 && video.readyState>=2)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const tm=setTimeout(()=>{video.removeEventListener('seeked',done);reject(Error('El video no responde al buscar momentos.'))},9000);
    const done=()=>{clearTimeout(tm);resolve()}; video.addEventListener('seeked',done,{once:true});video.currentTime=target;
  });
}
async function scanFrames(url,duration) {
  const v=document.createElement('video');v.preload='auto';v.playsInline=true;v.muted=true;await loadVideo(v,url);
  const can=document.createElement('canvas');can.width=64;can.height=36;const cx=can.getContext('2d',{willReadFrequently:true});
  const samples=Math.min(48,Math.max(14,Math.ceil(duration/30)));let prev=null,scored=[];const step=duration/(samples+1);let success=0;
  try {
    for(let i=1;i<=samples;i++){
      const at=step*i;
      try {
        await seek(v,at);cx.drawImage(v,0,0,can.width,can.height);const image=cx.getImageData(0,0,can.width,can.height).data;
        let sum=0,count=0;
        for(let j=0;j<image.length;j+=16){let rgb=.2126*image[j]+.7152*image[j+1]+.0722*image[j+2];if(prev)sum+=Math.abs(rgb-prev[count]);count++;}
        const values=new Float32Array(count);
        for(let j=0,k=0;j<image.length;j+=16,k++)values[k]=.2126*image[j]+.7152*image[j+1]+.0722*image[j+2];
        const score=prev?sum/count:0;scored.push({time:at,score});prev=values;success++;
      } catch(e) {scored.push({time:at,score:0});}
      setProgress('Analizando cambios visuales…',`Fotograma ${i}/${samples}. No se sube el video a la nube.`,i/samples*92);
      await new Promise(r=>setTimeout(r,0));
    }
  } finally{v.pause();v.removeAttribute('src');v.load()}
  if(success<3)throw Error('No pude obtener suficientes fotogramas. Selecciona un MP4 H.264 local.');
  return scored;
}
function pickClips(scores,duration,count,length){
  const out=[],maxStart=Math.max(0,duration-length),candidates=[...scores].sort((a,b)=>b.score-a.score);
  const gap=Math.max(2,Math.min(length*.8,40)),wanted=Math.min(count,Math.max(1,Math.floor(duration/Math.max(length*.75,1))));
  for(const c of candidates){const start=clamp(c.time-length*.36,0,maxStart);if(!out.some(x=>Math.abs(x.start-start)<gap)){out.push({start,seconds:Math.min(length,duration-start),score:c.score});if(out.length>=wanted)break;}}
  if(out.length<wanted)for(let i=0;i<wanted;i++){const start=maxStart*(i+.5)/wanted;if(!out.some(x=>Math.abs(x.start-start)<gap*.5))out.push({start,seconds:Math.min(length,duration-start),score:0});if(out.length>=wanted)break;}
  out.sort((a,b)=>a.start-b.start);
  return out.map((x,i)=>({...x,id:i+1,title:`Clip ${String(i+1).padStart(2,'0')} · ${fmt(x.start)}`}));
}
// Generador gratuito de descripciones: plantillas, NO un modelo de IA.
const descriptionPatterns=[
 (game,t)=>({title:`🔥 Momentos intensos de ${game} | ${t}`,description:`Uno de los momentos que más destaca en esta grabación de ${game}. ¿Qué te pareció? 👀`}),
 (game,t)=>({title:`🎮 ${game}: clip para no perderse | ${t}`,description:`Este fragmento de ${game} merece verse hasta el final. ¿Quieres más clips como este? 🔥`}),
 (game,t)=>({title:`⚡ Así estuvo este momento de ${game} | ${t}`,description:`Un recorte del directo de ${game} seleccionado por su actividad visual. Déjame tu opinión en comentarios. 🎮`}),
 (game,t)=>({title:`🏆 Highlights de ${game} | ${t}`,description:`Así se vivió este tramo del directo de ${game}. Si te gustó, comparte el clip. 🚀`})
];
function createDescription(clip,variant=0){
 const game=($('gameName')?.value||s.gameName||'gaming').trim().slice(0,60)||'gaming',stamp=fmt(clip.start);
 const item=descriptionPatterns[Math.abs(variant)%descriptionPatterns.length](game,stamp);
 const clean=game.replace(/[^\p{L}\p{N}]+/gu,'').slice(0,24)||'Gaming';
 const tags=Array.from(new Set([`#${clean}`,'#Gameplay','#Shorts','#Gaming','#Clips']));
 return `${item.title}\n\n${item.description}\n\n${tags.join(' ')}`;
}
async function copyText(text){
 try{await navigator.clipboard.writeText(text);toast('¡Texto copiado! Listo para tus redes sociales.')}catch{
  const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();document.execCommand('copy');area.remove();toast('Texto seleccionado para copiar');
 }
}
$('analyzeBtn').onclick=async()=>{
 if(s.busy)return;s.busy=true;$('analyzeBtn').disabled=true;
 try{
  if(s.objectUrl)URL.revokeObjectURL(s.objectUrl);
  const src=await getSource();s.file=src.file;s.fileName=src.name;s.objectUrl=src.url;
  const fileSize=src.file.size/1048576;if(fileSize>800)toast('Aviso: videos mayores de 800 MB pueden agotar la memoria del teléfono.');
  $('progressCard').hidden=false;$('editorSection').hidden=true;$('doneSection').hidden=true;
  setProgress('Preparando video…','Leyendo la grabación desde tu dispositivo.',3);await loadVideo($('sourceVideo'),src.url);
  s.duration=$('sourceVideo').duration;if(!Number.isFinite(s.duration)||s.duration<2)throw Error('No puedo detectar la duración del video.');
  s.length=Number($('clipDuration').value);s.count=Number($('clipCount').value);if(s.duration<s.length)s.length=Math.max(2,Math.floor(s.duration));
  const points=await scanFrames(src.url,s.duration);s.clips=pickClips(points,s.duration,s.count,s.length);
  s.gameName=($('gameName')?.value||'').trim();s.descriptions={};
  $('analysisMethod').textContent=`${s.clips.length} momentos sugeridos por cambios entre fotogramas. Es una heurística visual, no una IA que entienda las jugadas.`;
  $('originalMeta').textContent=`${$('sourceVideo').videoWidth}×${$('sourceVideo').videoHeight} · ${fmt(s.duration)} · ${fileSize.toFixed(1)} MB`;
  $('editorSection').hidden=false;$('progressCard').hidden=true;const total=s.clips.length;$('clipFound').textContent=`(${total})`;
  renderClipList();refreshCropBoxes();$('editorSection').scrollIntoView({behavior:'smooth'});drawPreview();
 }catch(e){toast(e.message||'No pude analizar el video.');$('progressCard').hidden=true}
 finally{s.busy=false;$('analyzeBtn').disabled=false}
};
function renderClipList() {
 $('clipList').innerHTML='';
 s.clips.forEach((c,i)=>{
  const node=document.createElement('div');node.className='clip-row';
  node.innerHTML=`<div class="clip-top"><span class="clip-id">CLIP ${String(i+1).padStart(2,'0')}</span><span class="clip-score">${c.score>0?'Movimiento detectado':'Selección distribuida'}</span></div><div class="clip-row-grid"><div><label>Inicio (segundos)</label><input class="c-start" type="number" min="0" step="0.1" value="${c.start.toFixed(1)}"></div><div><label>Duración (segundos)</label><input class="c-seconds" type="number" min="2" max="180" step="1" value="${Math.round(c.seconds)}"></div></div><div class="clip-row-actions"><button class="seek-button" type="button">▶ Ver momento</button><button class="remove-button" type="button">Eliminar</button></div>`;
  node.querySelector('.c-start').onchange=e=>{c.start=clamp(Number(e.target.value)||0,0,Math.max(0,s.duration-2));c.seconds=clamp(c.seconds,2,s.duration-c.start);renderClipList()};
  node.querySelector('.c-seconds').onchange=e=>{c.seconds=clamp(Number(e.target.value)||2,2,Math.min(180,s.duration-c.start));renderClipList()};
  node.querySelector('.seek-button').onclick=async()=>{await seek($('sourceVideo'),c.start);$('sourceVideo').play().catch(()=>{});drawPreview()};
  node.querySelector('.remove-button').onclick=()=>{s.clips=s.clips.filter(x=>x!==c);$('clipFound').textContent=`(${s.clips.length})`;renderClipList()};
  const box=document.createElement('section');box.className='description-box';
  const gen=document.createElement('button');gen.type='button';gen.className='description-button';gen.textContent='✨ Generar descripción';
  const area=document.createElement('textarea');area.className='description-text';area.rows=5;area.placeholder='Aquí aparecerá tu título, descripción y hashtags editables';area.setAttribute('aria-label',`Descripción del clip ${i+1}`);
  const actions=document.createElement('div');actions.className='description-actions';
  const copy=document.createElement('button');copy.type='button';copy.textContent='Copiar texto';
  const variant=document.createElement('button');variant.type='button';variant.textContent='Otra versión';
  const key=String(c.id)+'-'+String(c.start);let version=0;
  gen.onclick=()=>{area.value=createDescription(c,version);s.descriptions[key]=area.value};
  variant.onclick=()=>{version++;area.value=createDescription(c,version);s.descriptions[key]=area.value};
  copy.onclick=()=>{if(!area.value)area.value=createDescription(c,version);copyText(area.value)};
  area.oninput=()=>{s.descriptions[key]=area.value};if(s.descriptions[key])area.value=s.descriptions[key];
  actions.append(gen,variant,copy);box.append(actions,area);node.append(box);$('clipList').append(node);
 });
}
$('hasCamera').onchange=e=>{s.cameraEnabled=e.target.checked;refreshCropBoxes();drawPreview()};
$('toolCam').onclick=()=>{s.cropMode='cam';refreshCropBoxes()};$('toolGame').onclick=()=>{s.cropMode='game';refreshCropBoxes()};
$('resetCrops').onclick=()=>{s.cam={x:.025,y:.025,w:.28,h:.31};s.game={x:.05,y:.10,w:.92,h:.86};refreshCropBoxes();drawPreview()};
$('playVideo').onclick=()=>{const v=$('sourceVideo');if(v.paused)v.play().catch(()=>{});else v.pause()};
function refreshCropBoxes(){
 $('toolCam').classList.toggle('active',s.cropMode==='cam');$('toolGame').classList.toggle('active',s.cropMode==='game');
 for(const [id,crop] of [['rectCam',s.cam],['rectGame',s.game]]){
  const el=$(id);el.style.left=`${crop.x*100}%`;el.style.top=`${crop.y*100}%`;el.style.width=`${crop.w*100}%`;el.style.height=`${crop.h*100}%`;
  el.classList.toggle('inactive',(id==='rectCam'&&(!s.cameraEnabled||s.cropMode!=='cam'))||(id==='rectGame'&&s.cropMode!=='game'));el.hidden=id==='rectCam'&&!s.cameraEnabled;
 }
}
const overlay=$('cropOverlay');
function normalized(ev){const b=overlay.getBoundingClientRect();return {x:clamp((ev.clientX-b.left)/b.width,0,1),y:clamp((ev.clientY-b.top)/b.height,0,1)}}
overlay.onpointerdown=ev=>{if(s.busy)return;ev.preventDefault();const a=normalized(ev);s.drag={a};overlay.setPointerCapture(ev.pointerId)};
overlay.onpointermove=ev=>{if(!s.drag)return;const a=s.drag.a,b=normalized(ev),x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(a.x-b.x),h=Math.abs(a.y-b.y);if(w>.02&&h>.02){s[s.cropMode]={x,y,w,h};refreshCropBoxes();drawPreview()}};
overlay.onpointerup=()=>{s.drag=null};overlay.onpointercancel=()=>{s.drag=null};
function drawCover(ctx,video,crop,dx,dy,dw,dh){
 const W=video.videoWidth,H=video.videoHeight,x=clamp(crop.x*W,0,W-1),y=clamp(crop.y*H,0,H-1);
 const w=clamp(crop.w*W,1,W-x),h=clamp(crop.h*H,1,H-y),scale=Math.max(dw/w,dh/h),sw=Math.min(w,dw/scale),sh=Math.min(h,dh/scale);
 ctx.drawImage(video,x+(w-sw)/2,y+(h-sh)/2,sw,sh,dx,dy,dw,dh);
}
function drawPreview(){
 const video=$('sourceVideo'),canvas=$('outputCanvas');if(video.readyState<2||!video.videoWidth)return;
 const c=canvas.getContext('2d',{alpha:false}),w=canvas.width,h=canvas.height;c.fillStyle='#080b14';c.fillRect(0,0,w,h);
 try{if(s.cameraEnabled){const top=Math.round(h*.36);drawCover(c,video,s.cam,0,0,w,top);drawCover(c,video,s.game,0,top+4,w,h-top-4);c.fillStyle='#cf8bfd';c.fillRect(0,top,w,4)}else drawCover(c,video,s.game,0,0,w,h)}catch(e){}
}
function frameLoop(){drawPreview();s.previewLoop=requestAnimationFrame(frameLoop)}s.previewLoop=requestAnimationFrame(frameLoop);
function chooseMime(){
 if(typeof MediaRecorder==='undefined')throw Error('Este navegador no admite grabar video desde la página. Prueba Chrome actualizado.');
 for(const mime of ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"','video/mp4','video/webm;codecs=vp8,opus','video/webm'])if(MediaRecorder.isTypeSupported(mime))return mime;
 throw Error('Tu navegador no ofrece un formato de grabación compatible.');
}
async function recordClip(clip,index,total) {
 const video=$('sourceVideo'),canvas=$('outputCanvas'),quality=Number($('quality').value)||540;
 canvas.width=quality;canvas.height=Math.round(quality*16/9);await seek(video,clip.start);drawPreview();
 if(!canvas.captureStream)throw Error('Tu navegador no soporta exportar video desde el lienzo.');
 const visual=canvas.captureStream(30);
 if(!s.audioContext){
  s.audioContext=new (window.AudioContext||window.webkitAudioContext)();s.streamAudioSource=s.audioContext.createMediaElementSource(video);
  s.audioOut=s.audioContext.createMediaStreamDestination();s.streamAudioSource.connect(s.audioOut);
  const silent=s.audioContext.createGain();silent.gain.value=0;s.streamAudioSource.connect(silent);silent.connect(s.audioContext.destination);
 }
 await s.audioContext.resume();
 const stream=new MediaStream([...visual.getVideoTracks(),...s.audioOut.stream.getAudioTracks()]),mime=chooseMime();
 const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:quality>=1080?5000000:quality>=720?3000000:1900000,audioBitsPerSecond:112000}),chunks=[];
 const blob=await new Promise(async(resolve,reject)=>{
  let finished=false,raf=0,startWall=0;
  const cleanup=()=>{cancelAnimationFrame(raf);video.pause();visual.getTracks().forEach(t=>t.stop())};
  recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data)};
  recorder.onerror=e=>{if(!finished){finished=true;cleanup();reject(Error(e.error?.message||'Error al codificar el video.'))}};
  recorder.onstop=()=>{if(!finished){finished=true;cleanup();resolve(new Blob(chunks,{type:mime}))}};
  const tick=()=>{
   drawPreview();const played=video.currentTime-clip.start,elapsed=(performance.now()-startWall)/1000,pct=clamp(played/clip.seconds,0,1);
   setProgress('Exportando clips verticales…',`Clip ${index+1}/${total} · ${Math.round(clip.seconds-played)} s restantes · No cierres esta pestaña`,((index+pct)/total)*100);
   if(played>=clip.seconds-.07||video.ended||elapsed>clip.seconds+15){if(recorder.state!=='inactive')recorder.stop();return}
   raf=requestAnimationFrame(tick);
  };
  try{recorder.start(300);await video.play();startWall=performance.now();tick()}
  catch(err){finished=true;cleanup();try{recorder.stop()}catch{}reject(err)}
 });
 canvas.width=360;canvas.height=640;
 return {name:`CLIPFORGE_${String(index+1).padStart(2,'0')}_${Math.floor(clip.start)}s.${mime.startsWith('video/mp4')?'mp4':'webm'}`,blob,url:URL.createObjectURL(blob),start:clip.start};
}
$('renderBtn').onclick=async()=>{
 if(s.busy||!s.clips.length){toast('Primero selecciona al menos un clip.');return}
 s.busy=true;$('renderBtn').disabled=true;$('doneSection').hidden=true;s.outputs.forEach(o=>URL.revokeObjectURL(o.url));s.outputs=[];
 try{
  const mins=s.clips.reduce((sum,c)=>sum+c.seconds,0);if(mins>180)toast('La exportación funciona en tiempo real. Mantén la pestaña abierta mientras se generan los clips.');
  for(let i=0;i<s.clips.length;i++){const out=await recordClip(s.clips[i],i,s.clips.length);if(!out.blob.size)throw Error('El navegador devolvió un clip vacío.');s.outputs.push(out);renderDownloads()}
  $('progressCard').hidden=true;$('doneSection').hidden=false;$('doneSection').scrollIntoView({behavior:'smooth'});toast('¡Clips generados! Descárgalos antes de cerrar esta pestaña.');
 }catch(e){toast(`Exportación detenida: ${e.message||e}`);$('progressCard').hidden=true;if(s.outputs.length)$('doneSection').hidden=false}
 finally{s.busy=false;$('renderBtn').disabled=false}
};
function renderDownloads(){
 const list=$('downloadList');list.innerHTML='';
 for(const out of s.outputs){
  const row=document.createElement('div');row.className='download-item';const label=document.createElement('div'),b=document.createElement('b'),sz=document.createElement('small');
  b.textContent=out.name;sz.textContent=`${(out.blob.size/1048576).toFixed(1)} MB · ${fmt(out.start)}`;label.append(b,sz);
  const a=document.createElement('a');a.href=out.url;a.download=out.name;a.textContent='↓ Descargar';row.append(label,a);list.append(row);
 }
 $('zipLink').onclick=async e=>{
  e.preventDefault();if(!s.outputs.length)return;const link=$('zipLink');link.textContent='Creando ZIP…';
  try{
   if(!window.JSZip)await new Promise((resolve,reject)=>{
    const sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';sc.onload=resolve;sc.onerror=()=>reject(Error('No se pudo cargar el compresor ZIP. Usa los botones individuales.'));document.head.append(sc);
   });
   const zip=new window.JSZip();s.outputs.forEach(o=>zip.file(o.name,o.blob));const b=await zip.generateAsync({type:'blob',compression:'STORE'});
   const url=URL.createObjectURL(b),a=document.createElement('a');a.href=url;a.download='CLIPFORGE_clips.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(err){toast(err.message)}finally{link.textContent='↓ Descargar todos los clips (.ZIP)'}
 };
}
$('newJobBtn').onclick=()=>{$('editorSection').hidden=true;$('doneSection').hidden=true;$('progressCard').hidden=true;$('setupCard').scrollIntoView({behavior:'smooth'})};
refreshCropBoxes();
