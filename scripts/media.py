"""Optional local-file adapters, no network or credentials. Models must already exist locally.
ASR: python media.py asr audio.m4s output.json --duration 157 --model /local/faster-whisper-small
Frames: python media.py frames video.mp4 frame-dir --duration 157 --interval 15
Frames are visual evidence for a host vision model; this script does not claim OCR or full viewing.
"""
import argparse, json, math, time
from pathlib import Path

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode',choices=['asr','frames'])
    p.add_argument('input',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--duration',type=float,required=True)
    p.add_argument('--max-seconds',type=float,default=600)
    p.add_argument('--max-wall-seconds',type=float,default=900)
    p.add_argument('--model',type=Path);p.add_argument('--interval',type=float,default=15)
    a=p.parse_args()
    if not a.input.is_file() or not (0<a.duration<=a.max_seconds<=600):p.error('Existing local file and duration <= budget <=600 required')
    started=time.monotonic()
    if a.mode=='asr':
        if not a.model or not a.model.is_dir():p.error('Existing local faster-whisper model directory required; no model downloads')
        from faster_whisper import WhisperModel
        model=WhisperModel(str(a.model),device='cpu',compute_type='int8',local_files_only=True)
        result,info=model.transcribe(str(a.input),beam_size=1,vad_filter=False,condition_on_previous_text=False)
        if info.duration>a.max_seconds:raise RuntimeError('Decoded duration exceeds reserved budget')
        rows=[]
        for s in result:
            if time.monotonic()-started>a.max_wall_seconds:raise RuntimeError('ASR wall budget exceeded')
            rows.append({'start':s.start,'end':min(s.end,a.duration),'text':s.text.strip()})
        a.output.parent.mkdir(parents=True,exist_ok=True)
        a.output.write_text(json.dumps({'route':'A3','duration':a.duration,'segments':rows,'note':'AI-ASR, not verbatim; proper names need source checking.'},ensure_ascii=False,indent=2),encoding='utf8')
    else:
        if a.interval<1:p.error('interval must be >=1 second')
        import av
        a.output.mkdir(parents=True,exist_ok=True)
        timestamps=[];next_time=0
        with av.open(str(a.input)) as container:
            for frame in container.decode(video=0):
                if time.monotonic()-started>a.max_wall_seconds:raise RuntimeError('Frame wall budget exceeded')
                t=float(frame.time or 0)
                if t>a.max_seconds:break
                if t>=next_time and len(timestamps)<40:
                    filename=f'frame-{len(timestamps):03d}-{t:.2f}.jpg'
                    frame.to_image().save(a.output/filename,quality=90)
                    timestamps.append({'at':t,'file':filename});next_time=t+a.interval
        (a.output/'manifest.json').write_text(json.dumps({'route':'frame','duration':a.duration,'sampling':'uniform; may miss pages or motion','frames':timestamps,'next':'Host vision model may transcribe visible text to import JSON; preserve timestamps and uncertainty.'},ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'mode':a.mode,'output':str(a.output),'elapsed_seconds':round(time.monotonic()-started,3)}))
if __name__=='__main__':main()
