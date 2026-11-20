'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const state = { jobId: null, token: '', base: '', inspected: null, lastUrl: '', clips: [], outputs: [], pollTimer: null, busy: false };
  let savedBase = '';
  try { savedBase = localStorage.getItem('clipforge_backend_url') || ''; } catch (_) {}
  const savedToken = ''; // El token no se persiste: solo permanece en esta pestaña.
  const baseInput = $('backendUrl');
  const tokenInput = $('backendToken');
  if (baseInput) baseInput.value = savedBase;
  if (tokenInput) tokenInput.value = savedToken;

  function message(text, kind='info') {
    const box = $('sourceStatus');
    if (!box) return;
    box.textContent = text;
    box.dataset.kind = kind;
    box.hidden = false;
  }
  function backendSettings() {
    const base = (baseInput.value || '').trim().replace(/\/+$/, '');
    const token = (tokenInput.value || '').trim();
    if (!/^https:\/\//i.test(base)) throw new Error('Pega la URL HTTPS del túnel Cloudflare (https://….trycloudflare.com).');
    if (token.length < 32) throw new Error('El token privado debe tener al menos 32 caracteres.');
    state.base = base; state.token = token;
    try { localStorage.setItem('clipforge_backend_url', base); } catch (_) {}
    return {base, token};
  }
  async function api(path, options={}) {
    const cfg = backendSettings();
    const headers = Object.assign({'Authorization':'Bearer '+cfg.token}, options.headers || {});
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await fetch(cfg.base + path, Object.assign({}, options, {headers})); }
    catch (e) { throw new Error('No se pudo conectar con tu computador. Revisa que FastAPI y cloudflared sigan abiertos y que la URL del túnel sea la actual.'); }
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.detail || data.message || ('El backend respondió HTTP '+response.status+'.'));
    return data;
  }
  function stateName(status) {
    return ({live:'EN VIVO',recording:'GRABACIÓN DISPONIBLE',upcoming:'PRÓXIMAMENTE',restricted:'RESTRINGIDO',unavailable:'NO DISPONIBLE',inaccessible:'NO ACCESIBLE'})[status] || String(status || 'DESCONOCIDO').toUpperCase();
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(Number(seconds))) return 'duración no indicada';
    const n=Math.max(0,Math.floor(Number(seconds)));
    return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');
  }
  async function inspectLink() {
    const url = $('videoUrl').value.trim();
    if (!url) { message('Pega primero un enlace de YouTube, Kick o Twitch.', 'error'); return; }
    $('inspectLinkBtn').disabled = true;
    try {
      message('Comprobando conexión segura con tu computador…');
      const health = await api('/api/health', {method:'GET'});
      if (!health.ok || !health.ffmpeg || !health.ffprobe || !health.yt_dlp) throw new Error('El backend responde, pero falta FFmpeg/ffprobe o yt-dlp. Revisa la instalación en tu computador.');
      const result = await api('/api/inspect', {method:'POST',body:JSON.stringify({url})});
      state.inspected = result; state.lastUrl = url;
      if (!result.accessible) {
        message(result.platform+' · '+stateName(result.status)+' — '+(result.reason || result.detail || 'La plataforma no permitió el acceso.'), 'error');
      } else {
        const extra = result.duration ? ' · '+formatDuration(result.duration) : '';
        message(result.platform+' · '+stateName(result.status)+' · '+(result.title || 'Video')+extra, result.status==='live'?'live':'ok');
        $('liveSettings').hidden = result.status !== 'live';
      }
    } catch (e) { state.inspected=null; message(e.message, 'error'); }
    finally { $('inspectLinkBtn').disabled=false; }
  }
  $('inspectLinkBtn').addEventListener('click', inspectLink);
  $('videoUrl').addEventListener('change', () => { state.inspected=null; $('liveSettings').hidden=true; });

  function progress(title, detail, amount) {
    $('progressCard').hidden=false;
    $('progressTitle').textContent=title;
    $('progressDetail').textContent=detail;
    $('progressPercent').textContent=Math.round(amount||0)+'%';
    $('progressFill').style.width=Math.max(0,Math.min(100,amount||0))+'%';
    $('progressState').textContent=(amount||0)>=100?'Completado':'Procesando en tu computador';
  }
  function stopPolling() { if (state.pollTimer) clearTimeout(state.pollTimer); state.pollTimer=null; }
  async function waitForJob() {
    stopPolling();
    const job=await api('/api/jobs/'+state.jobId,{method:'GET'});
    progress(job.stage==='rendering'?'Exportando clips verticales…':job.stage==='capturing'?'Capturando el directo…':job.stage==='downloading'?'Extrayendo grabación…':job.stage==='analyzing'?'Analizando audio y escenas…':'Procesando enlace…',job.detail,job.progress);
    if (job.status==='failed') {
      stopPolling(); const error=job.error || {};
      message((error.status?stateName(error.status)+' · ':'')+(error.reason || job.detail || 'El proceso falló.')+(error.detail?' Detalle: '+error.detail:''),'error');
      $('progressCard').hidden=true; return;
    }
    if (job.status==='ready') { stopPolling(); state.clips=job.clips||[]; showClips(job); $('progressCard').hidden=true; return; }
    if (job.status==='done') { stopPolling(); await showOutputs(job); $('progressCard').hidden=true; return; }
    state.pollTimer=setTimeout(()=>waitForJob().catch(e=>{stopPolling();message(e.message,'error');}),1600);
  }
  async function startAnalysis() {
    if (state.busy) return;
    state.busy=true; $('analyzeBtn').disabled=true;
    try {
      const url=$('videoUrl').value.trim();
      if (!url) throw new Error('Pega un enlace de YouTube, Kick o Twitch.');
      if (!state.inspected || state.lastUrl!==url) await inspectLink();
      if (!state.inspected) throw new Error('No se pudo verificar el enlace. Corrige el acceso antes de continuar.');
      if (!state.inspected.accessible) throw new Error(state.inspected.reason || 'El contenido no está accesible.');
      if (state.inspected.status==='upcoming') throw new Error('Este directo todavía no ha comenzado. Vuelve a intentarlo cuando esté en vivo.');
      if (state.inspected.status==='live' && Number($('liveWindow').value)<Number($('clipDuration').value)) throw new Error('El intervalo de captura debe ser igual o mayor que la duración elegida para cada clip.');
      const body={url,clip_count:Number($('clipCount').value),clip_duration:Number($('clipDuration').value),live_start_delay:Number($('liveStartDelay').value),live_window_seconds:Number($('liveWindow').value)};
      $('editorSection').hidden=true; $('doneSection').hidden=true;
      progress('Enviando trabajo al computador…','El backend extraerá el contenido autorizado y analizará audio/cambios de escena.',2);
      const created=await api('/api/jobs',{method:'POST',body:JSON.stringify(body)});
      state.jobId=created.job_id;
      await waitForJob();
    } catch(e) { $('progressCard').hidden=true; message(e.message,'error'); }
    finally { state.busy=false; $('analyzeBtn').disabled=false; }
  }

  function generateSocialText(clip, platform) {
    const game=(($('gameName').value||'gaming').trim()||'gaming').slice(0,50);
    const clean=game.replace(/[^\p{L}\p{N}]+/gu,'').slice(0,24)||'Gaming';
    const time=formatDuration(clip.start);
    const titles={youtube:'🔥 '+game+' — el momento que no esperaba | #Shorts',instagram:'🎮 '+game+' · momento destacado',tiktok:'⚡ '+game+' y este momento lo dice todo'};
    const tags={youtube:'#Shorts #Gaming #'+clean,instagram:'#Reels #Gaming #'+clean,tiktok:'#TikTokGaming #Gaming #'+clean};
    const desc='Fragmento seleccionado por actividad real de audio y cambios de escena. Inicio '+time+'. ¿Qué te pareció?';
    return titles[platform]+'\n\n'+desc+'\n\n'+tags[platform];
  }
  function showClips(job) {
    $('editorSection').hidden=false;
    const editorGrid=document.querySelector('.editor-grid'); if(editorGrid) editorGrid.hidden=true;
    $('analysisMethod').textContent='Análisis en tu computador: energía de audio y cambios de escena. La transcripción local es opcional si instalas el modelo Whisper.';
    $('clipFound').textContent='('+state.clips.length+')';
    const list=$('clipList'); list.innerHTML='';
    state.clips.forEach((clip,index)=>{
      const row=document.createElement('article'); row.className='clip-row';
      const top=document.createElement('div'); top.className='clip-top';
      const id=document.createElement('span'); id.className='clip-id'; id.textContent='CLIP '+String(index+1).padStart(2,'0');
      const score=document.createElement('span'); score.className='clip-score'; score.textContent='Puntaje '+Math.round((clip.score||0)*100)+'%'; top.append(id,score);
      const check=document.createElement('label'); check.className='remote-select';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=true; cb.className='remote-clip-check'; check.append(cb,document.createTextNode(' Incluir en exportación'));
      const grid=document.createElement('div'); grid.className='clip-row-grid';
      const startWrap=document.createElement('div'),durWrap=document.createElement('div');
      const sl=document.createElement('label'); sl.textContent='Inicio (segundos)'; const si=document.createElement('input'); si.type='number';si.min='0';si.step='0.1';si.value=clip.start;si.className='remote-start';
      const dl=document.createElement('label');dl.textContent='Duración (15–180 s)';const di=document.createElement('input');di.type='number';di.min='15';di.max='180';di.step='1';di.value=Math.max(15,Math.min(180,Math.round(clip.duration)));di.className='remote-duration';
      startWrap.append(sl,si);durWrap.append(dl,di);grid.append(startWrap,durWrap);
      const textArea=document.createElement('textarea');textArea.className='description-text';textArea.rows=4;textArea.placeholder='Título, descripción y hashtags…';
      const actions=document.createElement('div');actions.className='description-actions';
      const gen=document.createElement('button');gen.type='button';gen.textContent='Generar texto social';
      const copy=document.createElement('button');copy.type='button';copy.textContent='Copiar';
      gen.onclick=()=>{textArea.value=generateSocialText({start:Number(si.value)},$('socialPlatform').value);};
      copy.onclick=async()=>{if(!textArea.value)textArea.value=generateSocialText({start:Number(si.value)},$('socialPlatform').value);try{await navigator.clipboard.writeText(textArea.value);message('Texto copiado.','ok')}catch(_){textArea.select();document.execCommand('copy')}};
      actions.append(gen,copy);row.append(top,check,grid,actions,textArea);list.append(row);
    });
    $('renderBtn').textContent='Exportar clips seleccionados en MP4 9:16 →';
    $('editorSection').scrollIntoView({behavior:'smooth'});
  }
  async function renderRemote() {
    if (state.busy || !state.jobId) return;
    const rows=Array.from(document.querySelectorAll('#clipList .clip-row'));
    const clips=[];
    for (const row of rows) {
      if (!row.querySelector('.remote-clip-check').checked) continue;
      const start=Number(row.querySelector('.remote-start').value), duration=Number(row.querySelector('.remote-duration').value);
      if (!Number.isFinite(start)||!Number.isFinite(duration)||duration<15||duration>180) { message('Cada clip debe tener inicio válido y duración entre 15 y 180 segundos.','error'); return; }
      clips.push({start,duration});
    }
    if (!clips.length) { message('Selecciona al menos un clip para exportar.','error'); return; }
    state.busy=true;$('renderBtn').disabled=true;
    try {
      const cam={x:Number($('camX').value),y:Number($('camY').value),w:Number($('camW').value),h:Number($('camH').value)};
      const game={x:Number($('gameX').value),y:Number($('gameY').value),w:Number($('gameW').value),h:Number($('gameH').value)};
      const body={clips,camera_enabled:$('remoteCamera').checked,resolution:Number($('quality').value),cam,game};
      progress('Iniciando exportación…','FFmpeg está creando MP4 verticales con el audio original.',1);
      await api('/api/jobs/'+state.jobId+'/render',{method:'POST',body:JSON.stringify(body)});
      await waitForJob();
    } catch(e) { $('progressCard').hidden=true;message(e.message,'error'); }
    finally {state.busy=false;$('renderBtn').disabled=false;}
  }
  async function showOutputs(job) {
    $('doneSection').hidden=false; $('downloadList').innerHTML='';
    $('zipLink').hidden=true;
    for (const output of (job.outputs||[])) {
      const row=document.createElement('div');row.className='download-item';
      const label=document.createElement('div'),b=document.createElement('b'),small=document.createElement('small');
      b.textContent=output.name;small.textContent=(output.size/1048576).toFixed(1)+' MB · '+formatDuration(output.start);label.append(b,small);
      const a=document.createElement('a');a.href='#';a.textContent='↓ Descargar';a.onclick=async ev=>{ev.preventDefault();try{const cfg=backendSettings();const response=await fetch(cfg.base+'/api/jobs/'+state.jobId+'/downloads/'+encodeURIComponent(output.name),{headers:{Authorization:'Bearer '+cfg.token}});if(!response.ok)throw new Error('No se pudo descargar el clip (HTTP '+response.status+').');const blob=await response.blob();const u=URL.createObjectURL(blob);const link=document.createElement('a');link.href=u;link.download=output.name;link.click();setTimeout(()=>URL.revokeObjectURL(u),60000);}catch(e){message(e.message,'error')}};
      row.append(label,a);$('downloadList').append(row);
    }
    $('doneSection').scrollIntoView({behavior:'smooth'});
    message('Exportación terminada: '+(job.outputs||[]).length+' clips MP4 con audio original.','ok');
  }

  const oldAnalyze=$('analyzeBtn').onclick;
  $('analyzeBtn').onclick=()=>{
    if ($('tabUrl').classList.contains('active')) return startAnalysis();
    return oldAnalyze && oldAnalyze();
  };
  const oldRender=$('renderBtn').onclick;
  $('renderBtn').onclick=()=> $('tabUrl').classList.contains('active') && state.jobId ? renderRemote() : oldRender && oldRender();
  $('tabFile').addEventListener('click',()=>{if(state.jobId){stopPolling();state.jobId=null;state.clips=[];state.outputs=[];$('editorSection').hidden=true;$('doneSection').hidden=true;}const grid=document.querySelector('.editor-grid');if(grid)grid.hidden=false;});
  $('newJobBtn').addEventListener('click',()=>{stopPolling();state.jobId=null;state.clips=[];state.outputs=[];state.inspected=null;const grid=document.querySelector('.editor-grid');if(grid)grid.hidden=false;});
  $('backendUrl').addEventListener('change',()=>{state.inspected=null;});
  $('backendToken').addEventListener('change',()=>{state.inspected=null;});
})();