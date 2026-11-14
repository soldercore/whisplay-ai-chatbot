import array, collections, contextlib, json, math, os, re, signal, socket, statistics, queue, threading
import subprocess, sys, tempfile, time, urllib.request, wave
from pathlib import Path

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

def rms(frame):
    samples=array.array("h",frame)
    return math.sqrt(sum(x*x for x in samples)/len(samples))

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

def capture(noise=None, live=None, after=None, announce=None):
    recent=collections.deque(maxlen=10)
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
                stamp,block=read_live()
            return stamp,block
        if noise is None: noise=statistics.median(rms(read()[1]) for _ in range(25))
        followup=announce is not None
        start_gate=max(150,noise*(2.0 if followup else 2.8))
        end_gate=max(95,noise*1.7)
        if followup: recent.append(read()[1])
        if announce: print(announce,flush=True)
        next_check=0
        waited=0
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
                    burst_start=now
                    speech_frames=loud
                    frames=list(recent)
                    last=now
            else:
                frames.append(frame)
                if level>=end_gate:
                    last=now
                    speech_frames+=1
                    tail=0
                    if followup and not hearing_sent and speech_frames>=7 and now-burst_start>=.16:
                        hearing_sent=True
                        print("CAPRI_HEARING",flush=True)
                else:
                    tail+=1
                    if tail >= 30:
                        if followup and (speech_frames < 7 or last-burst_start < .16):
                            recent.clear()
                            frames=[]
                            loud=tail=speech_frames=0
                            last=burst_start=None
                            continue
                        return b"".join(frames),last,round(noise),True
        if followup and (speech_frames < 7 or burst_start is None or last-burst_start < .16): frames=[]
        return b"".join(frames),last,round(noise),False

def recognize(raw,file):
    if not raw: return ""
    with wave.open(str(file),"wb") as out:
        out.setparams((1,2,16000,0,"NONE","not compressed"))
        out.writeframes(raw)
    try:
        request=urllib.request.Request("http://127.0.0.1:" + str(int(os.getenv("FASTER_WHISPER_PORT","8803"))) + "/recognize",
            data=json.dumps({"filePath":str(file),"language":os.getenv("FASTER_WHISPER_LANGUAGE") or "en"}).encode(),headers={"Content-Type":"application/json"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=8) as response:
            return json.load(response).get("recognition","").strip()
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

def main():
    authorize_capture()
    print("CAPRI_READY",flush=True)
    with tempfile.TemporaryDirectory(dir="/dev/shm",prefix="whisplay-capri-") as temp:
        file=Path(temp)/"speech.wav"
        while True:
            if not recording_allowed():
                time.sleep(1)
                continue
            with live_mic() as live:
                noise=None
                complete=False
                while recording_allowed():
                    raw,last_loud,noise,complete=capture(noise=noise,live=live)
                    if raw: break
                else:
                    raw=b""
            if raw and not complete:
                print("CAPRI_INCOMPLETE capture reached the speech limit; not recognized",file=sys.stderr,flush=True)
                continue
            if not raw or not recording_allowed():
                continue
            spoken=recognize(raw,file)
            match=re.fullmatch(r"capri\b[\s,.:;!?-]*(.*)",spoken,re.I)
            if not match or not recording_allowed():
                continue
            command=match[1].strip()
            speech_last=last_loud
            if not command:
                with live_mic() as live:
                    live()
                    if not recording_allowed(): continue
                    playback=chime()
                    # The existing signal has 360 ms of tone, followed by padding.
                    # Discard the tone and a 40 ms guard while keeping post-tone speech.
                    gate=playback+.40 if playback is not None else time.monotonic()
                    follow,last_follow,_,complete=capture(noise=noise,live=live,after=gate,announce="CAPRI_LISTENING")
                    speech_last=last_follow
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
