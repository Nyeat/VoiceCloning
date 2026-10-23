"""Private, serial zero-shot comparison UI. No fine-tuning or production services."""
import json, os, signal, subprocess, time, uuid
from pathlib import Path
import gradio as gr
import numpy as np
import soundfile as sf
from catalog import MODELS, EMOTIONS

ROOT=Path(os.environ.get('CLONE_LAB_ROOT','/opt/zero-shot-lab'))
RUNS=ROOT/'runs'; RUNS.mkdir(parents=True,exist_ok=True)

def status(key):
    path=ROOT/'status'/f'{key}.json'
    return json.loads(path.read_text()) if path.exists() else {'state':'not installed'}

def model_info(key):
    m=MODELS[key]
    demo=f" · [Public demo]({m['demo']})" if m.get('demo') else ''
    description=(f"**{m['name']}** — {status(key)['state']}\n\nLicence: {m['license']}. "
        f"[Model card](https://huggingface.co/{m['weights']}){demo}\n\n"
        + ('Exact reference transcript required.' if m['transcript'] else 'Reference transcript optional.')
        + '\n\nEach run loads this model, generates audio, then releases the GPU. Timing includes loading.')
    kind=m.get('emotion')
    return (description,gr.update(choices=m['language'],value=m['language'][0]),json.dumps(m['settings'],indent=2),
        gr.update(visible=kind is not None),gr.update(value=EMOTION_HELP.get(kind,'')),gr.update(visible=kind=='vector'))

EMOTION_HELP={
    'vector':'IndexTTS 2.5 keeps the cloned voice and steers emotion separately. Priority: emotion reference clip, then description (its own text-to-emotion model), then the emotion + intensity vector. The authors suggest intensity ≤0.6 with a description.',
    'instruction':'VoxCPM2 receives "(very angry)" style directions. With an emotion set, it clones from the reference audio only: continuing from the transcript would copy the reference\'s own mood. Takes vary; try 2–3 seeds.',
    'tags':'Fish receives a bracket tag such as [very angry] before every sentence. Intensity changes the wording (slightly / — / very); a description replaces it, e.g. "furious, shouting".',
}

def emotion_request(m,label,intensity,description,emotion_reference,folder):
    """Validated emotion settings for run_model, or None for the model's default delivery."""
    kind=m.get('emotion'); description=(description or '').strip()
    if not kind or (label=='none' and not description and not emotion_reference): return None
    if label!='none' and label not in EMOTIONS: raise gr.Error('Choose a listed emotion.')
    if not 0<=float(intensity)<=1: raise gr.Error('Emotion intensity must be between 0 and 1.')
    # Brackets and parentheses would close Fish tags or VoxCPM2 directions early.
    if len(description)>200 or any(c in description for c in '[]()<>'): raise gr.Error('Keep the emotion description under 200 characters, without brackets.')
    if emotion_reference and kind!='vector': raise gr.Error('Only IndexTTS 2.5 accepts an emotion reference clip.')
    if label=='none' and not description and kind!='vector': raise gr.Error('Choose an emotion or describe one.')
    emotion=dict(kind=kind,label=None if label=='none' else label,intensity=round(float(intensity),2),text=description,reference=None)
    if emotion_reference:
        audio,sr=sf.read(emotion_reference,dtype='float32',always_2d=True)
        if not 1<=len(audio)/sr<=30 or not np.isfinite(audio).all() or np.max(np.abs(audio))<1e-5: raise gr.Error('The emotion reference must be 1–30 seconds of audible speech.')
        emotion['reference']=str(folder/'emotion_reference.wav'); sf.write(emotion['reference'],audio.mean(axis=1),sr)
    return emotion

def generate(key,reference,transcript,text,language,seed,settings_text,emotion='none',intensity=0.6,emotion_text='',emotion_reference=None):
    m=MODELS[key]
    if not status(key)['state'].startswith(('installed','verified')): raise gr.Error('This model is not installed yet. Refresh its status.')
    if not reference: raise gr.Error('Upload or record reference audio first.')
    if not text.strip() or len(text)>1200: raise gr.Error('Enter 1–1200 characters of synthesis text.')
    if m['transcript'] and not transcript.strip(): raise gr.Error('This model requires the exact reference transcript.')
    if len(transcript)>2000: raise gr.Error('Reference transcript is too long.')
    if language not in m['language']: raise gr.Error('Choose a supported language.')
    try:
        settings=json.loads(settings_text)
        if set(settings)!=set(m['settings']): raise ValueError('Use exactly the displayed model settings.')
        for name,value in settings.items():
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not np.isfinite(value): raise ValueError('Settings must be finite numbers.')
            bounds={'steps':(4,64),'guidance':(0.1,8),'temperature':(0.1,2),'top_p':(0.01,1)}
            lo,hi=bounds[name]
            if not lo<=value<=hi: raise ValueError(f'{name} must be between {lo} and {hi}.')
            if name=='steps' and int(value)!=value: raise ValueError('steps must be an integer.')
        if 'steps' in settings: settings['steps']=int(settings['steps'])
        seed=int(seed)
        if not 0<=seed<2**32: raise ValueError('Seed must be between 0 and 4294967295.')
    except (ValueError,TypeError) as e: raise gr.Error(str(e))
    audio,sr=sf.read(reference,dtype='float32',always_2d=True)
    seconds=len(audio)/sr
    if not 3<=seconds<=30: raise gr.Error('Use a reference between 3 and 30 seconds (6–10 seconds recommended).')
    if key.startswith('gpt') and seconds>10: raise gr.Error('GPT-SoVITS requires a 3–10 second reference.')
    # Measured: one 30 s reference cut mid-phrase gave 63% WER (babble), 19 s skipped a sentence, 9 s gave 2%.
    if key=='fire' and seconds>12: raise gr.Error('FireRedTTS3 requires a 3–12 second reference ending on a complete sentence; longer clips make it skip words and babble.')
    if not np.isfinite(audio).all() or np.max(np.abs(audio))<1e-5: raise gr.Error('Reference audio is silent or invalid.')
    folder=RUNS/uuid.uuid4().hex; folder.mkdir()
    emotion=emotion_request(m,emotion,intensity,emotion_text,emotion_reference,folder)
    ref=folder/'reference.wav'; sf.write(ref,audio.mean(axis=1),sr)
    out=folder/'output.wav'
    req=dict(model=key,reference=str(ref),transcript=transcript.strip(),text=text.strip(),language=language,seed=seed,settings=settings,output=str(out),emotion=emotion)
    request_file=folder/'request.json'; request_file.write_text(json.dumps(req,ensure_ascii=False),encoding='utf-8')
    # File lock also serializes smoke tests and multiple UI processes on this host.
    import fcntl
    with (ROOT/'gpu.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        with (folder/'run.log').open('w') as log:
            proc=subprocess.Popen([str(ROOT/'envs'/m['env']/'bin/python'),'-u',str(Path(__file__).with_name('run_model.py')),str(request_file)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try: code=proc.wait(timeout=900)
            except BaseException:
                os.killpg(proc.pid,signal.SIGKILL); proc.wait(); raise
    if code or not out.exists():
        tail=(folder/'run.log').read_text(errors='replace')[-3500:]
        raise gr.Error('Synthesis failed; no result was substituted. '+tail)
    meta=json.loads(out.with_suffix('.json').read_text())
    return str(playback_copy(out)),meta,[str(out),str(out.with_suffix('.json'))]

def playback_copy(wav):
    # A multi-megabyte WAV over the share tunnel stalls mid-playback and appears
    # long after synthesis ends; the player gets a ~10x smaller MP3 instead. The
    # lossless WAV stays the scored original and is offered as a download.
    mp3=wav.with_suffix('.mp3')
    try:
        audio,sr=sf.read(wav,dtype='float32')
        sf.write(mp3,audio,sr,format='MP3')
        return mp3
    except Exception:
        return wav

def inventory():
    return [[m['name'],status(k)['state'],m['license']] for k,m in MODELS.items()]

with gr.Blocks(title='Zero-shot Voice Lab') as demo:
    gr.Markdown('# Zero-shot Voice Lab\nCompare voices from one reference clip. No training. One GPU, one synthesis at a time.')
    with gr.Row():
        with gr.Column():
            model=gr.Dropdown([(m['name'],k) for k,m in MODELS.items()],value='qwen',label='Model')
            info=gr.Markdown(model_info('qwen')[0])
            refresh=gr.Button('Refresh model status')
            reference=gr.Audio(sources=['upload','microphone'],type='filepath',format='wav',label='Reference voice — 6–10 seconds recommended')
            transcript=gr.Textbox(label='Exact words spoken in the reference',lines=3)
        with gr.Column():
            text=gr.Textbox(label='Text to speak',lines=6,value='Welcome to the voice cloning comparison. Please listen to the pronunciation, rhythm, and speaker identity.')
            language=gr.Dropdown(MODELS['qwen']['language'],value='English',label='Output language')
            with gr.Accordion('Model settings',open=True):
                seed=gr.Number(value=42,precision=0,label='Random seed')
                settings=gr.Code(value=json.dumps(MODELS['qwen']['settings'],indent=2),language='json',label='Native model parameters')
                gr.Markdown('steps: 4–64 · guidance: 0.1–8 · temperature: 0.1–2 · top_p: 0.01–1. Only parameters supported by this model appear.')
            # Shown only for models that can change emotion while keeping the cloned voice.
            with gr.Accordion('Emotion',open=True,visible=False) as emotion_box:
                emotion_help=gr.Markdown()
                emotion=gr.Dropdown(['none']+EMOTIONS,value='none',label='Emotion')
                intensity=gr.Slider(0,1,value=0.6,step=0.05,label='Intensity')
                emotion_text=gr.Textbox(label='Or describe it (optional, replaces the emotion above)',placeholder='e.g. furious, shouting')
                emotion_reference=gr.Audio(sources=['upload','microphone'],type='filepath',format='wav',label='Emotion reference clip (optional): any speaker; only its emotion is used',visible=False)
            go=gr.Button('Generate cloned speech',variant='primary')
            output=gr.Audio(label='Generated speech',type='filepath')
            metrics=gr.JSON(label='Run details (timing includes model loading)')
            download=gr.File(label='Download lossless WAV and run details',file_count='multiple')
    with gr.Accordion('Model readiness',open=False):
        table=gr.Dataframe(headers=['Model','State','Licence'],value=inventory,interactive=False)
    gr.Markdown('Recordings and results stay on this evaluation server until removed. Public demo links use third-party services. A successful smoke test confirms audio generation, not cloning quality; judge quality using your own voice and blind comparisons.')
    model_outputs=[info,language,settings,emotion_box,emotion_help,emotion_reference]
    model.change(model_info,model,model_outputs)
    refresh.click(model_info,model,model_outputs).then(inventory,outputs=table)
    go.click(generate,[model,reference,transcript,text,language,seed,settings,emotion,intensity,emotion_text,emotion_reference],[output,metrics,download],concurrency_limit=1,concurrency_id='gpu',api_name='clone')

if __name__=='__main__':
    credentials=json.loads((ROOT/'access.json').read_text())
    demo.queue(max_size=8).launch(server_name='127.0.0.1',server_port=7860,share=True,
        auth=(credentials['username'],credentials['password']),max_file_size='20mb',allowed_paths=[str(RUNS)])
