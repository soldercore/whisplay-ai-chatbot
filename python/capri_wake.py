import array, collections, contextlib, json, math, os, re, signal, socket, statistics, queue, threading
import http.client, subprocess, sys, tempfile, time, urllib.request, wave
from pathlib import Path
import shutil

def rpc(cmd, payload):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(1.5)
        sock.connect("/tmp/whisplay-daemon.sock")
        sock.sendall(json.dumps(dict(version=1,cmd=cmd,payload=payload)).encode()+b"\n")
        with sock.makefile("rb") as stream:
            reply=json.loads(stream.readline(65536))
    if not reply.get("ok"):
        raise RuntimeError("Whisplay recording authorization is unavailable")
    return reply["payload"]

def recording_allowed():
    # Losing foreground ends capture. The daemon cannot change the recording
    # lock while this application is running, starting, or stopping.
    try:
        return rpc("health.ping", {})["foreground_app_id"] == "whisplay-ai-chatbot"
    except (OSError, ValueError, KeyError, RuntimeError):
        return False

def authorize_capture():
    # Read the actual recording policy once while idle, before opening ALSA.
    # A busy device-operation lock postpones capture and is never bypassed.
    while True:
        if recording_allowed():
            try:
                audio=rpc("control.read", {"scope":"audio"})
                if audio["glados_recording_enabled"] is True and audio["hardware_mic_mute"] is False:
                    return
            except (OSError, ValueError, KeyError, RuntimeError):
                pass
        time.sleep(.5)

PCM=Path("/proc/asound/whisplaysound/pcm0p/sub0/status")
CAPTURE=["sox","-q","--buffer","640","-t","alsa",os.getenv("ALSA_INPUT_DEVICE") or "hw:whisplaysound,0","-r","16000","-b","16","-c","1","-e","signed-integer","-L","-t","raw","-"]
CHIME=["sox","-q","-n","-t","alsa",os.getenv("ALSA_OUTPUT_DEVICE") or "playback","synth","0.10","sine","720","vol","0.4",":","synth","0.12","sine","980","vol","0.35",":","synth","0.14","sine","1320","vol","0.3","fade","q","0.02","0.30","0.08","gain","-30"]
FRAME=640
# 20 ms frames. Waiting for speech to begin and recording speech are limited separately:
# a late start must not cut a command short.
WAIT_FRAMES=300     # 6 s without speech: return so the caller re-checks state (unchanged)
SPEECH_FRAMES=750   # 15 s safety cap once speech has started; a capture stopped here is incomplete
LINGER_S=5.0        # the microphone may stay open this long while the wake stage is recognized (reader queue holds 6 s)

@contextlib.contextmanager
def child(command, stdout=None):
    with subprocess.Popen(command,stdout=stdout) as proc:
        try:
            yield proc
        finally:
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(1)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(1)

# Diagnostics (event-based, numbers only: no audio, no transcripts). One line per capture that heard sound, per calibration, per
# microphone open and per wake check; CAPRI_DIAGNOSTICS=0 turns them off. They never change what the listener does.
DIAG=os.getenv("CAPRI_DIAGNOSTICS","1")!="0"
def diag(event,**fields):
    if DIAG: print("CAPRI_DIAG "+event+" ts=%.3f "%time.time()+" ".join("%s=%s"%(k,v) for k,v in fields.items()),file=sys.stderr,flush=True)

# TEMPORARY audio copy for diagnosing wrong transcripts. CAPRI_SAVE_AUDIO_DIR=/path keeps the last CAPRI_SAVE_AUDIO_KEEP (default 10)
# clips that were sent to Whisper (only those, never ambient audio), in a private folder on this machine; unset = nothing is written.
SAVE_DIR=os.getenv("CAPRI_SAVE_AUDIO_DIR","").strip()
SAVE_KEEP=int(os.getenv("CAPRI_SAVE_AUDIO_KEEP") or 10)

def save_clip(file,purpose):
    if not SAVE_DIR: return
    try:
        directory=Path(SAVE_DIR)
        directory.mkdir(mode=0o700,parents=True,exist_ok=True)
        os.chmod(directory,0o700)
        target=directory/("clip-%d-%s.wav"%(round(time.time()*1000),purpose))
        shutil.copyfile(file,target)
        os.chmod(target,0o600)
        for old in sorted(directory.glob("clip-*.wav"))[:-SAVE_KEEP]: old.unlink(missing_ok=True)
    except OSError: pass            # a diagnostic never gets in the way

# Optional openWakeWord wake detector. CAPRI_OWW_MODEL=/path/capri.onnx replaces the Whisper wake stage; unset, nothing below runs and
# the behaviour is exactly the Whisper wake stage in main(). It reads the same 20 ms frames from the one microphone this process
# already owns: no second capture, no second process. If the detector cannot load, the Whisper wake stage is used.
OWW_MODEL=os.getenv("CAPRI_OWW_MODEL","").strip()
OWW_THRESHOLD=float(os.getenv("CAPRI_OWW_THRESHOLD") or 0.7)
OWW_PREROLL=int(os.getenv("CAPRI_OWW_PREROLL_FRAMES") or 6)        # 20 ms frames kept from before the detection (the end of "Capri")
OWW_PROBE_FRAMES=25      # 0.5 s after the detection in which a command may begin
OWW_SKIP_FRAMES=8        # the first 160 ms are the end of the wake word itself
OWW_SPEECH_FRAMES=6      # loud frames (of the 17 that follow) that mean "a command is being spoken", not a pop or a breath
OWW_PROBE_GATE=2.4       # times the room noise
OWW_MIN_SPEECH_FRAMES=15   # a command is at least 0.3 s of speech; less (the end of the chime, a click) is not sent to Whisper
OWW_REFRACTORY_S=2.0

class OwwDetector:
    def __init__(self,path):
        import numpy
        from openwakeword.model import Model
        self.np=numpy
        self.model=Model(wakeword_models=[path],inference_framework="onnx")
        self.pending=b""
    def reset(self):
        self.model.reset()
        self.pending=b""
    def score(self,block):
        """Feed one 20 ms block. Returns the model score once per 80 ms, otherwise None."""
        self.pending+=block
        if len(self.pending)<2560: return None
        chunk,self.pending=self.pending[:2560],self.pending[2560:]
        prediction=self.model.predict(self.np.frombuffer(chunk,dtype=self.np.int16))
        return max(prediction.values()) if prediction else 0.0

def rms(frame):
    # Energy of the frame WITHOUT its mean. The microphone carries a DC offset (about +330) and slow rumble below 50 Hz that moves the
    # mean of a 20 ms frame between about -300 and +1000; counted as energy it kept the end-of-speech gate exceeded for seconds
    # (a capture then ran to the 15 s limit) and made every threshold depend on the offset at the moment it was measured.
    samples=array.array("h",frame)
    mean=sum(samples)/len(samples)
    return math.sqrt(sum((x-mean)*(x-mean) for x in samples)/len(samples))

@contextlib.contextmanager
def live_mic():
    q=queue.Queue(maxsize=300)
    with child(CAPTURE,subprocess.PIPE) as proc:
        def pump():
            while True:
                data=proc.stdout.read(FRAME)
                if len(data)!=FRAME: break
                item=(time.monotonic(),data)
                try: q.put_nowait(item)
                except queue.Full: return
        reader=threading.Thread(target=pump,daemon=True)
        reader.start()
        def read():
            return q.get(timeout=2)
        try: yield read
        finally:
            if proc.poll() is None: proc.terminate()
            reader.join(timeout=1)

def capture(noise=None, live=None, after=None, announce=None, preload=(), immediate=False, hold=False, min_speech=7):
    stats={"n":0,"sum":0.0,"peak":0.0,"above":0,"run":0,"maxrun":0,"recent":collections.deque(maxlen=20),"quiet20":None,"pre":None,"calib":None,"gates":None} if DIAG else None
    result=_capture(noise,live,after,announce,stats,preload,immediate,hold,min_speech)
    if stats is not None:
        if stats["calib"]: diag("calibrate",min=stats["calib"][0],median=stats["calib"][1],max=stats["calib"][2],start_gate=stats["gates"][0],end_gate=stats["gates"][1])
        if stats["n"]:
            n=stats["n"]
            diag("capture",kind="follow-up" if announce else "wake",end="silence" if result[3] else "limit",seconds=round(n*0.02,1),noise=result[2],
                 start_gate=stats["gates"][0],end_gate=stats["gates"][1],before=stats["pre"],mean=round(stats["sum"]/n),peak=round(stats["peak"]),
                 above_end_pct=round(100*stats["above"]/n),longest_quiet_frames=stats["maxrun"],quietest_400ms=None if stats["quiet20"] is None else round(stats["quiet20"]))
    return result

def _capture(noise, live, after, announce, stats, preload=(), immediate=False, hold=False, min_speech=7):
    recent=collections.deque(preload,maxlen=10)
    held=collections.deque(maxlen=40)          # frames that arrived while the chime was playing (see hold below)
    frames=[]
    loud=0
    last=None
    tail=0
    speech_frames=0
    burst_start=None
    hearing_sent=False
    with (contextlib.nullcontext(live) if live else live_mic()) as read_live:
        def read():
            stamp,block=read_live()
            while after is not None and stamp<after:
                if hold: held.append(block)
                stamp,block=read_live()
            return stamp,block
        if noise is None:
            calibration=[rms(read()[1]) for _ in range(25)]
            noise=statistics.median(calibration)
            if stats is not None: stats["calib"]=(round(min(calibration)),round(noise),round(max(calibration)))
        followup=announce is not None
        start_gate=max(150,noise*(2.0 if followup else 2.8))
        end_gate=max(95,noise*1.7)
        if stats is not None: stats["gates"]=(round(start_gate),round(end_gate))
        if followup: recent.append(read()[1])
        if announce: print(announce,flush=True)
        next_check=0
        waited=0
        if immediate:
            # Right after a wake word the command may start softly or at once: record from the pre-roll on and let the usual
            # end-of-speech silence close it, instead of waiting for the start gate (a quiet first word would be lost).
            frames=list(preload) if preload else list(recent)
        while True:
            if not frames:
                if waited>=WAIT_FRAMES: break
                waited+=1
            elif len(frames)>=SPEECH_FRAMES:
                # Speech is still going at the safety cap: the caller must not act on it.
                return b"".join(frames),last,round(noise),False
            now,frame=read()
            if now>=next_check:
                if not recording_allowed(): return b"",None,round(noise),False
                next_check=now+1
            level=rms(frame)
            if not frames:
                recent.append(frame)
                loud=loud+1 if level>=start_gate else 0
                if loud>=2:
                    if stats is not None: stats["pre"]=round(statistics.mean(rms(f) for f in recent))
                    burst_start=now
                    speech_frames=loud
                    # hold: the user may already be speaking while the chime plays. Those frames are not looked at for the start of
                    # speech (the chime itself is loud in the microphone), but when speech begins right after the chime they belong to it.
                    frames=(list(held) if hold and after is not None and now-after<=0.3 else [])+list(recent)
                    last=now
            else:
                frames.append(frame)
                if stats is not None:
                    stats["n"]+=1; stats["sum"]+=level; stats["peak"]=max(stats["peak"],level); stats["recent"].append(level)
                    if len(stats["recent"])==20:
                        mean20=sum(stats["recent"])/20
                        stats["quiet20"]=mean20 if stats["quiet20"] is None else min(stats["quiet20"],mean20)
                    if level>=end_gate: stats["above"]+=1; stats["run"]=0
                    else: stats["run"]+=1; stats["maxrun"]=max(stats["maxrun"],stats["run"])
                if level>=end_gate:
                    last=now
                    speech_frames+=1
                    tail=0
                    if followup and not hearing_sent and speech_frames>=7 and now-burst_start>=.16:
                        hearing_sent=True
                        print("CAPRI_AUDIO",flush=True)   # sound passed the start level; energy, not proof of speech
                else:
                    tail+=1
                    if tail >= 30:
                        if followup and (speech_frames < min_speech or last-burst_start < .16):
                            recent.clear()
                            frames=[]
                            loud=tail=speech_frames=0
                            last=burst_start=None
                            continue
                        return b"".join(frames),last,round(noise),True
        if followup and (speech_frames < min_speech or burst_start is None or last-burst_start < .16): frames=[]
        return b"".join(frames),last,round(noise),False

def recognize(raw,file,hint=None):
    if not raw: return ""
    with wave.open(str(file),"wb") as out:
        out.setparams((1,2,16000,0,"NONE","not compressed"))
        out.writeframes(raw)
    save_clip(file,"wake" if hint else "command")
    asked=time.monotonic()
    try:
        request=urllib.request.Request("http://127.0.0.1:" + str(int(os.getenv("FASTER_WHISPER_PORT","8803"))) + "/recognize",
            data=json.dumps({"filePath":str(file),"language":os.getenv("FASTER_WHISPER_LANGUAGE") or "en",**({"initial_prompt":hint} if hint else {})}).encode(),headers={"Content-Type":"application/json"})
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=8) as response:
                data=json.load(response)
            if not isinstance(data,dict) or not isinstance(data.get("recognition",""),str):
                raise ValueError("malformed recognition response")
        except (OSError,http.client.HTTPException,ValueError) as error:
            # Only the HTTP exchange is guarded (timeout, refused, reset, HTTP error, bad JSON): Whisper is busy or
            # unavailable, so this utterance is not recognized. One request, no retry; the listener loop carries on.
            print("CAPRI_ASR_UNAVAILABLE "+type(error).__name__,file=sys.stderr,flush=True)
            return ""
        text=data.get("recognition","").strip()
        diag("recognize",purpose="wake" if hint else "command",audio_s=round(len(raw)/32000,1),asr_s=round(time.monotonic()-asked,2),words=len(text.split()))
        return text
    finally:
        file.unlink(missing_ok=True)

def chime():
    began=None
    with child(CHIME) as proc:
        deadline=time.monotonic()+2
        while proc.poll() is None:
            if time.monotonic()>deadline: raise RuntimeError("Bekreftelseslyden ble tidsavbrutt")
            if began is None and "RUNNING" in PCM.read_text():
                began=time.monotonic()
            time.sleep(.005)
        if proc.returncode!=0: raise RuntimeError("Bekreftelseslyden kunne ikke spilles")
    return began

def oww_wake(detector,live,file):
    """Wait for the wake word on the live stream, then take what follows it. Returns (command, speech_last, noise, captured), or
    None when recording stopped being allowed or the command capture was unusable. An empty command means a bare wake word."""
    detector.reset()
    ring=collections.deque(maxlen=OWW_PREROLL)
    levels=collections.deque(maxlen=150)       # about 3 s of recent levels for the capture gates
    next_check=0
    last_fire=-OWW_REFRACTORY_S
    near_max=0.0
    near_frames=0
    diag("listening")
    while True:
        now,block=live()
        if now>=next_check:
            if not recording_allowed(): return None
            next_check=now+1
        levels.append(rms(block))
        ring.append(block)
        score=detector.score(block)
        if score is not None:
            # A stretch of scores that rose above 0.10 but never reached the threshold: the detector heard something wake-word-like and
            # did not fire (a missed or half-heard "Capri"). Numbers only.
            if 0.10<=score<OWW_THRESHOLD:
                near_max=max(near_max,score)
                near_frames+=1
            elif score<0.05 and near_frames:
                if near_frames>=2: diag("oww_near",max=round(near_max,2),frames=near_frames)
                near_max,near_frames=0.0,0
        if score is None or score<OWW_THRESHOLD or now-last_fire<OWW_REFRACTORY_S: continue
        break
    quiet=sorted(levels)
    noise=statistics.median(quiet[:max(1,len(quiet)//2)])   # the quiet half: the wake word itself is in the newest frames
    detected=time.monotonic()
    diag("oww_detect",score=round(score,2),noise=round(noise))
    # Is a command being spoken right behind the wake word? Look for half a second. If not, this is a bare "Capri": chime at once
    # (the follow-up capture then waits for the command) instead of recording for as long as anything keeps sounding, which left the
    # user without a chime for up to 15 s. A command is loud for most of the window; a breath or a click is not.
    gate=max(150,noise*OWW_PROBE_GATE)
    probe=[]
    loud=0
    for index in range(OWW_PROBE_FRAMES):
        _,block=live()
        probe.append(block)
        if index>=OWW_SKIP_FRAMES and rms(block)>=gate: loud+=1
        if loud>=OWW_SPEECH_FRAMES: break
    if loud<OWW_SPEECH_FRAMES:
        diag("oww_bare",probe_s=round(len(probe)*0.02,2),loud_frames=loud)
        return ("",None,noise,detected) if recording_allowed() else None
    raw,last_loud,noise,complete=capture(noise=noise,live=live,preload=list(ring)+probe,immediate=True)
    if raw and not complete:
        print("CAPRI_INCOMPLETE command reached the speech limit; not dispatched",file=sys.stderr,flush=True)
        return None
    if not recording_allowed(): return None
    if not raw or last_loud is None:
        return ("",None,noise,detected)             # nothing was said after the wake word: a bare wake word
    text=recognize(raw,file)
    command=re.sub(r"^\W*capri\b[\s,.:;!?-]*","",text,flags=re.I).strip()
    diag("oww_command",audio_s=round(len(raw)/32000,1),words=len(command.split()))
    return (command,last_loud,noise,detected)

def main():
    authorize_capture()
    detector=None
    if OWW_MODEL:
        try: detector=OwwDetector(OWW_MODEL)
        except Exception as error: print("CAPRI_OWW_UNAVAILABLE "+type(error).__name__,file=sys.stderr,flush=True)
    diag("detector",kind="openwakeword" if detector else "whisper",threshold=OWW_THRESHOLD if detector else "-")
    print("CAPRI_READY",flush=True)
    opens=0
    streak=0    # consecutive captures that reached the speech limit
    with tempfile.TemporaryDirectory(dir="/dev/shm",prefix="whisplay-capri-") as temp:
        file=Path(temp)/"speech.wav"
        while True:
            if not recording_allowed():
                time.sleep(1)
                continue
            # The microphone stays open while Whisper decodes the wake stage, so a bare "Capri" can chime and keep capturing
            # without reopening it (about 0.7 s). Frames recorded meanwhile wait in the reader queue (6 s of room).
            mic=contextlib.ExitStack()
            try:
                live=mic.enter_context(live_mic())
                opens+=1
                diag("mic_open",opens=opens,noise_refreshed=1)
                if detector is not None:
                    found=oww_wake(detector,live,file)
                    if found is None: continue
                    command,speech_last,noise,captured=found
                else:
                    noise=None
                    complete=False
                    while recording_allowed():
                        raw,last_loud,noise,complete=capture(noise=noise,live=live)
                        if raw: break
                    else:
                        raw=b""
                    if raw and not complete:
                        print("CAPRI_INCOMPLETE capture reached the speech limit; not recognized",file=sys.stderr,flush=True)
                        streak+=1
                        diag("incomplete",streak=streak,next="microphone reopened and noise re-measured")
                        continue
                    if not raw or not recording_allowed():
                        continue
                    streak=0
                    captured=time.monotonic()
                    # Whisper base rarely writes the name "Capri" unprompted; the hint is for this wake stage only.
                    spoken=recognize(raw,file,hint="Capri.")
                    diag("wake_check",audio_s=round(len(raw)/32000,1),asr_s=round(time.monotonic()-captured,1),words=len(spoken.split()),
                         contains_capri=int("capri" in spoken.lower()),starts_with_capri=int(bool(re.match(r"\W*capri\b",spoken,re.I))))
                    match=re.fullmatch(r"capri\b[\s,.:;!?-]*(.*)",spoken,re.I)
                    if not match or not recording_allowed():
                        continue
                    command=match[1].strip()
                    speech_last=last_loud
                if not command:
                    if time.monotonic()-captured>LINGER_S:
                        # A slow decode would have overflowed the reader queue: reopen the microphone as before.
                        mic.close()
                        live=mic.enter_context(live_mic())
                        live()
                    if not recording_allowed(): continue
                    chime_asked=time.monotonic()
                    playback=chime()
                    diag("chime",took_ms=round((time.monotonic()-chime_asked)*1000),began_ms_after_ask="-" if playback is None else round((playback-chime_asked)*1000))
                    # The existing signal has 360 ms of tone, followed by padding.
                    # Discard the tone and a 40 ms guard while keeping post-tone speech.
                    gate=playback+.40 if playback is not None else time.monotonic()
                    follow,last_follow,_,complete=capture(noise=noise,live=live,after=gate,announce="CAPRI_LISTENING",
                                                          **(dict(hold=True,min_speech=OWW_MIN_SPEECH_FRAMES) if detector is not None else {}))
                    speech_last=last_follow
            finally:
                mic.close()
            if not command:
                if follow and complete and recording_allowed():
                    print("CAPRI_PROCESSING",flush=True)   # capture is over; Whisper runs next
                if follow and not complete:
                    print("CAPRI_INCOMPLETE command reached the speech limit; not dispatched",file=sys.stderr,flush=True)
                    command=""
                elif recording_allowed():
                    command=recognize(follow,file)
                else:
                    command=""
                if not command:
                    print("CAPRI_IDLE",flush=True)
                    continue
            if not recording_allowed():
                print("CAPRI_IDLE",flush=True)
                continue
            if len(command)>1000 or any(ord(c)<32 for c in command):
                print("CAPRI_IDLE",flush=True)
                continue
            if speech_last is not None:
                print("CAPRI_TIMING %d"%round(max(0.0,time.monotonic()-speech_last)*1000),flush=True)   # ms since the last loud frame
            diag("command_out",words=len(command.split()))
            print("CAPRI_COMMAND "+json.dumps(command,ensure_ascii=True),flush=True)
            return

if __name__=="__main__":
    def stop(_signum,_frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGHUP,stop)
    try:
        main()
    except KeyboardInterrupt:
        pass
