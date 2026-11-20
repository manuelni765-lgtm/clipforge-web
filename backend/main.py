from __future__ import annotations
import asyncio, hmac, json, os, re, shutil, subprocess, time, uuid, struct, math, importlib.util
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from fastapi import FastAPI, Depends, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

APP_DIR=Path(__file__).resolve().parent
WORK_DIR=Path(os.getenv("CLIPFORGE_WORK_DIR",str(APP_DIR/"work"))).resolve()
WORK_DIR.mkdir(parents=True,exist_ok=True)
TOKEN=os.getenv("CLIPFORGE_TOKEN","")
if len(TOKEN)<32: raise RuntimeError("Configura CLIPFORGE_TOKEN con al menos 32 caracteres. No inicies el servidor sin autenticación.")
FFMPEG=os.getenv("FFMPEG_PATH","ffmpeg"); FFPROBE=os.getenv("FFPROBE_PATH","ffprobe")
WHISPER_MODEL=os.getenv("CLIPFORGE_WHISPER_MODEL","").strip()
ORIGINS=["https://manuelni765-lgtm.github.io","http://localhost:8000","http://127.0.0.1:8000"]
app=FastAPI(title="CLIPFORGE private local backend",version="1.0.0")
app.add_middleware(CORSMiddleware,allow_origins=ORIGINS,allow_credentials=False,allow_methods=["GET","POST"],allow_headers=["Authorization","Content-Type"])
JOBS: dict[str,dict[str,Any]]={}

class InspectRequest(BaseModel):
    url:str=Field(min_length=8,max_length=2048)
class JobRequest(BaseModel):
    url:str=Field(min_length=8,max_length=2048)
    clip_count:int=Field(default=5,ge=1,le=20)
    clip_duration:int=Field(default=45,ge=15,le=180)
    live_start_delay:int=Field(default=0,ge=0,le=3600)
    live_window_seconds:int=Field(default=300,ge=15,le=3600)
class RenderRequest(BaseModel):
    clips:list[dict[str,float]]=Field(min_length=1,max_length=20)
    camera_enabled:bool=True
    resolution:int=Field(default=720,ge=540,le=1080)
    cam:dict[str,float]=Field(default_factory=lambda:{"x":.02,"y":.02,"w":.32,"h":.30})
    game:dict[str,float]=Field(default_factory=lambda:{"x":.02,"y":.25,"w":.96,"h":.72})

def auth(authorization:str|None=Header(default=None)):
    if not authorization or not authorization.startswith("Bearer ") or not hmac.compare_digest(authorization[7:],TOKEN):
        raise HTTPException(401,"Token incorrecto o ausente. El backend está protegido.")

def validate_url(value:str)->tuple[str,str]:
    try: u=urlparse(value.strip())
    except Exception: raise HTTPException(400,"Enlace no válido.")
    if u.scheme!="https" or not u.hostname or u.username or u.password or u.port not in (None,443):
        raise HTTPException(400,"Usa un enlace HTTPS público, sin credenciales ni puertos personalizados.")
    host=u.hostname.lower().rstrip(".")
    allowed={"youtube.com":"YouTube","www.youtube.com":"YouTube","m.youtube.com":"YouTube","youtu.be":"YouTube","youtube-nocookie.com":"YouTube","www.youtube-nocookie.com":"YouTube","twitch.tv":"Twitch","www.twitch.tv":"Twitch","m.twitch.tv":"Twitch","clips.twitch.tv":"Twitch","kick.com":"Kick","www.kick.com":"Kick"}
    platform=allowed.get(host)
    if not platform: raise HTTPException(400,"Plataforma no admitida. Usa YouTube, Kick o Twitch.")
    if platform=="YouTube" and not (host.endswith("youtu.be") or (any(x in u.path for x in ("/watch","/live/","/shorts/","/embed/")) or u.path.endswith("/live"))):
        raise HTTPException(400,"Pega el enlace de un video o directo de YouTube.")
    if platform=="Kick" and len(u.path.strip("/").split("/"))>2:
        raise HTTPException(400,"Pega el enlace del canal o de la grabación de Kick.")
    return value.strip(),platform

def ydl_info(url:str,download:bool=False,outtmpl:str|None=None,hook=None):
    try: import yt_dlp
    except ImportError: raise RuntimeError("yt-dlp no está instalado. Ejecuta el instalador del backend.")
    opts={"quiet":True,"no_warnings":True,"noplaylist":True,"socket_timeout":25,"retries":2,"fragment_retries":2,"ignoreerrors":False,"cachedir":False,"restrictfilenames":True}
    if download: opts.update({"format":"bv*+ba/b","merge_output_format":"mp4","outtmpl":outtmpl,"progress_hooks":[hook] if hook else []})
    with yt_dlp.YoutubeDL(opts) as ydl:
        info=ydl.extract_info(url,download=download)
        if info is None: raise RuntimeError("La plataforma no entregó metadatos del video.")
        return info

def classify_error(msg:str)->tuple[str,str]:
    low=msg.lower()
    if any(k in low for k in ("private video","subscribers-only","subscriber-only","members-only","join this channel","only available to subscribers","subscriber only")):
        return "restricted","El contenido es privado o requiere una membresía/suscripción autorizada. No se intentó eludir el control."
    if any(k in low for k in ("sign in","login","authentication","cookies","age-restricted","confirm your age","requires authentication","login required")):
        return "restricted","La plataforma exige iniciar sesión, verificar edad o aportar autorización. Este backend no usa cookies ni credenciales de terceros."
    if any(k in low for k in ("not available in your country","not available in your region","geo-restricted","geo restricted")):
        return "restricted","La plataforma informa una restricción geográfica para este contenido."
    if any(k in low for k in ("live event will begin","upcoming","premieres in")):
        return "upcoming","El directo todavía no ha comenzado."
    if any(k in low for k in ("does not exist","not found","404","has been removed","deleted","video unavailable")):
        return "unavailable","La grabación no existe, fue eliminada o la plataforma no la encuentra."
    return "inaccessible","La plataforma no permitió obtener el contenido. Revisa que el enlace sea público y que tengas acceso."

def public_info(url:str)->dict[str,Any]:
    clean,platform=validate_url(url)
    try: info=ydl_info(clean,False)
    except Exception as exc:
        state,reason=classify_error(str(exc))
        return {"platform":platform,"status":state,"accessible":False,"reason":reason,"detail":str(exc)[:500]}
    availability=(info.get("availability") or "").lower()
    if availability in ("private","premium_only","subscriber_only","needs_auth"):
        return {"platform":platform,"status":"restricted","accessible":False,"reason":"La plataforma marca este contenido como privado, de membresía o con inicio de sesión obligatorio. No se intentó eludir el control."}
    live_status=info.get("live_status") or ("is_live" if info.get("is_live") else "not_live")
    if info.get("is_live") or live_status=="is_live": state="live"
    elif live_status in ("is_upcoming","upcoming"): state="upcoming"
    else: state="recording"
    return {"platform":platform,"status":state,"accessible":True,"title":info.get("title") or "Video sin título","duration":info.get("duration"),"uploader":info.get("uploader") or info.get("channel"),"live_status":live_status,"is_live":state=="live","reason":None}

def command(args:list[str],timeout:int=30):
    return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout,check=False)
def check_ffmpeg():
    if not shutil.which(FFMPEG) or not shutil.which(FFPROBE): raise RuntimeError("FFmpeg/ffprobe no está instalado o no está en PATH.")
def probe(path:Path)->dict[str,Any]:
    p=command([FFPROBE,"-v","error","-show_entries","format=duration:stream=codec_type,width,height","-of","json",str(path)])
    if p.returncode: raise RuntimeError("FFprobe no pudo leer el video: "+p.stderr[-500:])
    data=json.loads(p.stdout or "{}"); duration=float(data.get("format",{}).get("duration") or 0)
    if duration<=0: raise RuntimeError("El archivo no contiene una pista de video válida.")
    return {"duration":duration,"streams":data.get("streams",[])}

def audio_scores(path:Path,duration:float):
    p=subprocess.run([FFMPEG,"-v","error","-i",str(path),"-vn","-ac","1","-ar","8000","-f","s16le","pipe:1"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180,check=False)
    if p.returncode or not p.stdout: return []
    raw=p.stdout; total=len(raw)//2; rate=8000; window=5*rate; out=[]
    for offset in range(0,total,window):
        chunk=memoryview(raw)[offset*2:min(total,offset+window)*2]; n=len(chunk)//2
        if n<rate: continue
        vals=struct.unpack("<"+"h"*n,chunk); rms=math.sqrt(sum(v*v for v in vals)/n)
        out.append((min(duration,(offset+n/2)/rate),rms))
    return out

def scene_times(path:Path):
    p=subprocess.run([FFMPEG,"-hide_banner","-i",str(path),"-vf","select='gt(scene,0.25)',showinfo","-an","-f","null","-"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=240,check=False)
    return [float(x) for x in re.findall(r"pts_time:([0-9.]+)",p.stderr)]

def whisper_scores(path:Path):
    if not WHISPER_MODEL: return []
    try:
        from faster_whisper import WhisperModel
        model=WhisperModel(WHISPER_MODEL,device="cpu",compute_type="int8")
        segments,_=model.transcribe(str(path),vad_filter=True)
        return [(float(x.start+x.end)/2,min(1.0,len((x.text or "").split())/18)) for x in segments]
    except Exception: return []

def analyze(path:Path,count:int,clip_len:int,job:dict[str,Any]):
    duration=probe(path)["duration"]
    if duration < 15: raise RuntimeError("El contenido dura menos de 15 segundos; no permite clips del mínimo solicitado.")
    job.update(progress=66,stage="analyzing",detail="Midiendo energía de audio…")
    aud=audio_scores(path,duration)
    job.update(progress=78,detail="Detectando cambios de escena con FFmpeg…")
    scenes=scene_times(path); speech=whisper_scores(path); candidates=[]
    step=max(2.0,clip_len/3)
    for start in range(0,max(1,int(duration-clip_len)+1),max(1,int(step))):
        end=min(duration,start+clip_len)
        if end-start<min(15,clip_len): continue
        a=[v for t,v in aud if start<=t<=end]
        sc=sum(1 for t in scenes if start<=t<=end); sp=sum(v for t,v in speech if start<=t<=end)
        candidates.append({"start":float(start),"duration":end-start,"audio":sum(a)/len(a) if a else 0,"scenes":sc,"speech":sp})
    if not candidates: candidates=[{"start":0.0,"duration":min(duration,clip_len),"audio":0,"scenes":0,"speech":0}]
    for key in ("audio","scenes","speech"):
        vals=[c[key] for c in candidates]; lo=min(vals); hi=max(vals)
        for c in candidates: c[key+"_n"]=(c[key]-lo)/(hi-lo) if hi>lo else 0.0
    for c in candidates: c["score"]=round(.5*c["audio_n"]+.4*c["scenes_n"]+.1*c["speech_n"],4)
    candidates.sort(key=lambda x:x["score"],reverse=True); chosen=[]
    for c in candidates:
        if all(abs(c["start"]-x["start"])>=clip_len*.65 for x in chosen): chosen.append(c)
        if len(chosen)>=count: break
    chosen.sort(key=lambda x:x["start"])
    return [{"id":i+1,"start":round(c["start"],2),"duration":round(c["duration"],2),"score":c["score"],"signals":{"audio_energy":round(c["audio_n"],2),"scene_changes":c["scenes"],"speech_activity":round(c["speech_n"],2)}} for i,c in enumerate(chosen)]

def set_progress(job,status,pct,stage,detail):
    job.update(status=status,progress=max(0,min(100,int(pct))),stage=stage,detail=detail,updated=time.time())

async def create_job(job_id:str,req:JobRequest):
    job=JOBS[job_id]; folder=WORK_DIR/job_id; folder.mkdir(parents=True,exist_ok=True)
    try:
        check_ffmpeg(); url,platform=validate_url(req.url)
        info=await asyncio.to_thread(ydl_info,url,False)
        live=bool(info.get("is_live") or info.get("live_status")=="is_live")
        if live:
            set_progress(job,"capturing",8,"capturing","Directo detectado. Preparando captura…")
            for elapsed in range(req.live_start_delay):
                set_progress(job,"capturing",8+int(12*elapsed/max(1,req.live_start_delay)),"waiting_live",f"Esperando inicio: {req.live_start_delay-elapsed} s…")
                await asyncio.sleep(1)
            if req.live_window_seconds < req.clip_duration:
                raise RuntimeError("El intervalo de captura debe ser igual o mayor que la duración de cada clip.")
            formats=info.get("formats") or []
            usable=[f for f in formats if f.get("url") and f.get("vcodec") not in (None,"none") and f.get("acodec") not in (None,"none")]
            video=[f for f in formats if f.get("url") and f.get("vcodec") not in (None,"none")]
            audio=[f for f in formats if f.get("url") and f.get("acodec") not in (None,"none") and f.get("vcodec") in (None,"none")]
            if usable:
                inputs=[max(usable,key=lambda f:(f.get("height") or 0,f.get("tbr") or 0))["url"]]
            elif video and audio:
                inputs=[max(video,key=lambda f:(f.get("height") or 0,f.get("tbr") or 0))["url"],max(audio,key=lambda f:(f.get("abr") or f.get("tbr") or 0))["url"]]
            elif info.get("url"):
                inputs=[info["url"]]
            else:
                raise RuntimeError("yt-dlp no devolvió flujos de video/audio compatibles para este directo.")
            source=folder/"capture.mkv"
            cmd=[FFMPEG,"-y","-hide_banner","-loglevel","error"]
            for stream in inputs: cmd.extend(["-i",stream])
            cmd.extend(["-t",str(req.live_window_seconds),"-map","0:v:0"])
            cmd.extend(["-map","1:a:0?"] if len(inputs)>1 else ["-map","0:a?"])
            cmd.extend(["-c","copy",str(source)])
            set_progress(job,"capturing",22,"capturing",f"Capturando {req.live_window_seconds} segundos del directo…")
            proc=await asyncio.create_subprocess_exec(*cmd,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            started=time.monotonic()
            while proc.returncode is None:
                elapsed=int(time.monotonic()-started)
                set_progress(job,"capturing",22+int(28*min(1,elapsed/max(1,req.live_window_seconds))),"capturing",f"Captura: {min(elapsed,req.live_window_seconds)}/{req.live_window_seconds} segundos…")
                try: await asyncio.wait_for(proc.wait(),timeout=1)
                except asyncio.TimeoutError: pass
            _,err=await proc.communicate()
            if proc.returncode or not source.exists() or source.stat().st_size<100000:
                raise RuntimeError("No se pudo capturar el intervalo del directo: "+err.decode(errors="replace")[-700:])
        else:
            set_progress(job,"downloading",10,"extracting","Enlace reconocido. Extrayendo el VOD con yt-dlp…")
            template=str(folder/"source.%(ext)s")
            def hook(d):
                if d.get("status")=="downloading":
                    total=d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                    done=d.get("downloaded_bytes") or 0
                    pct=int(10+45*done/total) if total else job.get("progress",20)
                    detail = (f"Descarga: {pct}% · {d.get('_speed_str', '')} · {d.get('_eta_str', '')}" if total else "Descarga en curso; tamaño total no informado; porcentaje exacto no disponible.")
                    set_progress(job,"downloading",pct,"downloading",detail)
            await asyncio.to_thread(ydl_info,url,True,template,hook)
            found=[p for p in folder.glob("source.*") if p.suffix.lower() not in (".part",".ytdl")]
            if not found: raise RuntimeError("yt-dlp terminó sin crear un archivo de video.")
            source=max(found,key=lambda p:p.stat().st_size)
        job.update(source_path=str(source),platform=platform,title=info.get("title") or "Video",live_capture=live)
        clips=await asyncio.to_thread(analyze,source,req.clip_count,req.clip_duration,job)
        job["clips"]=clips; job["duration"]=probe(source)["duration"]
        set_progress(job,"ready",100,"ready",f"Análisis real completado: {len(clips)} momentos.")
    except Exception as exc:
        state,reason=classify_error(str(exc)); job["error"]={"status":state,"reason":reason,"detail":str(exc)[:800]}
        set_progress(job,"failed",100,"failed",reason)

async def render_job(job_id:str,req:RenderRequest):
    job=JOBS[job_id]; source=Path(job["source_path"]); folder=WORK_DIR/job_id; results=[]
    try:
        check_ffmpeg(); duration=probe(source)["duration"]; cam=req.cam; game=req.game
        for box in (cam,game):
            if any(not 0<=float(box.get(k,0))<=1 for k in ("x","y","w","h")) or box.get("w",0)<=.02 or box.get("h",0)<=.02 or box.get("x",0)+box.get("w",0)>1.001 or box.get("y",0)+box.get("h",0)>1.001:
                raise RuntimeError("Las zonas de cámara/juego deben estar dentro del fotograma.")
        total=len(req.clips)
        for i,c in enumerate(req.clips):
            start=max(0,float(c.get("start",0))); length=max(15,min(180,float(c.get("duration",45))))
            if start>=duration: raise RuntimeError("Un clip comienza fuera del video.")
            length=min(length,duration-start); out=folder/f"CLIPFORGE_{i+1:02d}_{int(start)}s.mp4"
            width=req.resolution; height=round(width*16/9); top=round(height*.36); bottom=height-top
            if req.camera_enabled:
                vf=(f"[0:v]split=2[vc][vg];[vc]crop=iw*{cam['w']}:ih*{cam['h']}:iw*{cam['x']}:ih*{cam['y']},scale={width}:{top}:force_original_aspect_ratio=increase,crop={width}:{top}[ct];"
                    f"[vg]crop=iw*{game['w']}:ih*{game['h']}:iw*{game['x']}:ih*{game['y']},scale={width}:{bottom}:force_original_aspect_ratio=increase,crop={width}:{bottom}[gt];[ct][gt]vstack=inputs=2[v]")
                maps=["-filter_complex",vf,"-map","[v]","-map","0:a?"]
            else:
                vf=f"crop=iw*{game['w']}:ih*{game['h']}:iw*{game['x']}:ih*{game['y']},scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"
                maps=["-vf",vf,"-map","0:v:0","-map","0:a?"]
            cmd=[FFMPEG,"-y","-hide_banner","-loglevel","error","-ss",str(start),"-i",str(source),"-t",str(length),*maps,"-c:v","libx264","-preset","veryfast","-crf","23","-pix_fmt","yuv420p","-c:a","aac","-b:a","160k","-movflags","+faststart",str(out)]
            p=await asyncio.create_subprocess_exec(*cmd,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            _,err=await p.communicate()
            if p.returncode or not out.exists() or out.stat().st_size<10000: raise RuntimeError("FFmpeg no pudo exportar el clip: "+err.decode(errors="replace")[-700:])
            results.append({"name":out.name,"size":out.stat().st_size,"start":start,"duration":length})
            set_progress(job,"rendering",int((i+1)/total*100),"rendering",f"Exportado clip {i+1} de {total} · MP4 H.264/AAC")
        job["outputs"]=results; set_progress(job,"done",100,"done",f"Exportación completada: {len(results)} clips MP4 con audio sincronizado.")
    except Exception as exc:
        job["error"]={"status":"failed","reason":"La exportación se detuvo por un error real de FFmpeg.","detail":str(exc)[:800]}
        set_progress(job,"failed",100,"failed",str(exc)[:500])

@app.get("/api/health")
def health():
    return {"ok":True,"service":"CLIPFORGE local backend","auth_required":True,"ffmpeg":bool(shutil.which(FFMPEG)),"yt_dlp":importlib.util.find_spec("yt_dlp") is not None,"whisper_enabled":bool(WHISPER_MODEL and importlib.util.find_spec("faster_whisper"))}
@app.post("/api/inspect",dependencies=[Depends(auth)])
async def inspect(req:InspectRequest):
    clean,_=validate_url(req.url)
    return await asyncio.to_thread(public_info,clean)
@app.post("/api/jobs",dependencies=[Depends(auth)])
async def start_job(req:JobRequest):
    clean,platform=validate_url(req.url)
    if len([j for j in JOBS.values() if j.get("status") not in ("done","failed")])>=2: raise HTTPException(429,"Ya hay dos procesos activos. Espera a que terminen.")
    job_id=uuid.uuid4().hex[:16]
    JOBS[job_id]={"id":job_id,"status":"queued","progress":0,"stage":"queued","detail":"Trabajo en cola…","created":time.time(),"platform":platform,"clips":[],"outputs":[]}
    asyncio.create_task(create_job(job_id,req.model_copy(update={"url":clean})))
    return {"job_id":job_id,"status":"queued"}
@app.get("/api/jobs/{job_id}",dependencies=[Depends(auth)])
def get_job(job_id:str):
    job=JOBS.get(job_id)
    if not job: raise HTTPException(404,"Trabajo no encontrado.")
    return {k:v for k,v in job.items() if k!="source_path"}
@app.post("/api/jobs/{job_id}/render",dependencies=[Depends(auth)])
async def start_render(job_id:str,req:RenderRequest):
    job=JOBS.get(job_id)
    if not job: raise HTTPException(404,"Trabajo no encontrado.")
    if job.get("status")!="ready": raise HTTPException(409,"El análisis no está listo para exportar.")
    job["status"]="rendering"; job["outputs"]=[]
    asyncio.create_task(render_job(job_id,req))
    return {"status":"rendering"}
@app.get("/api/jobs/{job_id}/downloads/{filename}",dependencies=[Depends(auth)])
def download(job_id:str,filename:str):
    job=JOBS.get(job_id)
    if not job: raise HTTPException(404,"Trabajo no encontrado.")
    safe=Path(filename).name; path=WORK_DIR/job_id/safe
    if not path.is_file() or not any(x["name"]==safe for x in job.get("outputs",[])): raise HTTPException(404,"Archivo no encontrado.")
    return FileResponse(path,filename=safe,media_type="video/mp4")
@app.get("/",include_in_schema=False)
def root(): return {"service":"CLIPFORGE private backend","health":"/api/health"}
