"""Independently decode smoke WAVs and optionally transcribe them on CPU."""
import argparse, json, math, re, subprocess
from pathlib import Path

def edit_distance(a,b):
    row=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        nxt=[i]
        for j,y in enumerate(b,1): nxt.append(min(nxt[-1]+1,row[j]+1,row[j-1]+(x!=y)))
        row=nxt
    return row[-1]

def words(text): return re.findall(r"[a-z0-9]+",text.lower())

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--root',default='/opt/zero-shot-lab'); parser.add_argument('--asr',action='store_true'); args=parser.parse_args()
    import numpy as np
    import soundfile as sf
    root=Path(args.root); results=[]
    asr=None
    if args.asr:
        from faster_whisper import WhisperModel
        asr=WhisperModel('small.en',device='cpu',compute_type='int8',cpu_threads=4,download_root=str(root/'cache/whisper'))
    for path in sorted((root/'smoke').glob('*.json')):
        smoke=json.loads(path.read_text())
        if not isinstance(smoke,dict) or not smoke.get('ok'): continue
        wav=Path(smoke['audio']); request=json.loads(wav.with_name('request.json').read_text())
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_name,sample_rate,channels','-of','json',str(wav)]))
        audio,sr=sf.read(wav,dtype='float32')
        result=dict(model=smoke['model'],file=str(wav),ffprobe=probe,finite=bool(np.isfinite(audio).all()),rms=float(np.sqrt(np.mean(audio**2))),peak=float(np.max(np.abs(audio))))
        result['valid_audio']=result['finite'] and result['rms']>1e-5 and len(audio)>sr
        if asr:
            segments,_=asr.transcribe(str(wav),language='en',beam_size=5)
            result['transcript']=' '.join(s.text.strip() for s in segments)
            target=words(request['text']); result['raw_wer']=edit_distance(target,words(result['transcript']))/len(target)
            result['wer_note']='Raw orthographic comparison; number formatting is not normalized. Not a model ranking.'
        results.append(result)
    (root/'smoke/verification-results.json').write_text(json.dumps(results,indent=2))
    print(json.dumps(results,indent=2))

if __name__=='__main__': main()
