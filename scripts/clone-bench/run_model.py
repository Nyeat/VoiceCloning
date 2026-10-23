"""One request per process: exiting releases CUDA memory before another model starts."""
import json, os, random, subprocess, sys, time
from pathlib import Path
from catalog import MODELS, EMOTIONS, emotion_phrase

def tag_sentences(text,tag):
    import re
    return ' '.join(f'[{tag}] {s}' for s in re.split(r'(?<=[.!?])\s+',text.strip()) if s)

def sentence_chunks(text,limit=220):
    import re
    chunks=[]
    for sentence in re.split(r'(?<=[.!?])\s+',text.strip()):
        if chunks and len(chunks[-1])+1+len(sentence)<=limit: chunks[-1]+=' '+sentence
        else: chunks.append(sentence)
    return chunks

def main():
    request=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    key=request['model']; m=MODELS[key]
    root=Path(os.environ.get('CLONE_LAB_ROOT','/opt/zero-shot-lab'))
    repo=root/'repos'/m['env']; weights=root/'models'/key
    os.chdir(repo); sys.path.insert(0,str(repo))
    os.environ['HF_HOME']=str(root/'cache/huggingface')
    os.environ['WANDB_MODE']='disabled'
    import numpy as np
    import soundfile as sf
    import torch
    seed=request['seed']; random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
    if not torch.cuda.is_available(): raise RuntimeError('CUDA unavailable; refusing a silent CPU fallback')
    torch.cuda.reset_peak_memory_stats()
    settings=request['settings']; text=request['text']; ref=request['reference']; transcript=request['transcript']
    out=request['output']; started=time.monotonic()
    emotion=request.get('emotion')
    if key=='longcat':
        # Upstream caps prompt+generation at max_wav_duration (60 s) and never splits text,
        # so long text with a long reference is squeezed into the remainder and words drop.
        parts=[]
        for i,chunk in enumerate(sentence_chunks(text)):
            part=str(Path(out).with_name(f'part{i}.wav'))
            subprocess.run([sys.executable,'inference.py','--model_dir',str(weights),'--text',chunk,
                '--prompt_text',transcript,'--prompt_audio',ref,'--output_audio',part,
                '--nfe',str(settings['steps']),'--guidance_strength',str(settings['guidance']),
                '--guidance_method','apg','--seed',str(seed)],check=True)
            wav,sr=sf.read(part,dtype='float32'); parts+=[wav,np.zeros(int(sr*0.25),dtype='float32')]
        sf.write(out,np.concatenate(parts[:-1]),sr)
    elif key=='dots':
        from dots_tts.runtime import DotsTtsRuntime
        model=DotsTtsRuntime.from_pretrained(str(weights),precision='bfloat16')
        result=model.generate(text=text,prompt_audio_path=ref,prompt_text=transcript,
            num_steps=settings['steps'],guidance_scale=settings['guidance'])
        sf.write(out,result['audio'].float().cpu().squeeze().numpy(),result['sample_rate'])
    elif key=='vox':
        from voxcpm import VoxCPM
        model=VoxCPM.from_pretrained(str(weights),load_denoiser=False)
        kwargs=dict(text=text,reference_wav_path=ref,cfg_value=settings['guidance'],inference_timesteps=settings['steps'],seed=seed)
        # Directions apply in reference-only "controllable cloning"; transcript continuation copies the reference's mood.
        if emotion: kwargs['text']=f'({emotion_phrase(emotion)})'+text
        elif transcript: kwargs.update(prompt_wav_path=ref,prompt_text=transcript)
        wav=model.generate(**kwargs)
        sf.write(out,wav,model.tts_model.sample_rate)
    elif key=='qwen':
        from qwen_tts import Qwen3TTSModel
        model=Qwen3TTSModel.from_pretrained(str(weights),device_map='cuda:0',dtype=torch.bfloat16,attn_implementation='sdpa')
        wavs,sr=model.generate_voice_clone(text=text,language=request['language'],ref_audio=ref,ref_text=transcript,
            temperature=settings['temperature'],top_p=settings['top_p'])
        sf.write(out,wavs[0],sr)
    elif key=='fire':
        from fireredtts3.core import FireRedTTS3
        model=FireRedTTS3(str(weights),use_fasttext=False,use_wetext=True,use_llm_tn=False)
        audio,sr=sf.read(ref,dtype='float32',always_2d=True)
        wav,sr=model.generate(text=text,language=request['language'],prompt_text=transcript,
            prompt_audio=torch.from_numpy(audio.T),prompt_audio_sr=sr,n_timesteps=settings['steps'],inference_cfg=settings['guidance'],seed=seed)
        sf.write(out,wav.detach().cpu().squeeze().numpy(),sr)
    elif key=='index':
        from indextts.infer_v2_5 import IndexTTS2
        use_text=bool(emotion and emotion['text'] and not emotion['reference'])
        model=IndexTTS2(cfg_path=str(weights/'config.yaml'),model_dir=str(weights),use_bf16=True,use_qwen_emo=use_text)
        lang={'English':'EN','Chinese':'ZH','Japanese':'JA','Spanish':'ES','Arabic':'AR'}[request['language']]
        emo={}
        if emotion and emotion['reference']: emo=dict(emo_audio_prompt=emotion['reference'],emo_alpha=emotion['intensity'])
        elif use_text: emo=dict(use_emo_text=True,emo_text=emotion['text'],emo_alpha=emotion['intensity'])
        elif emotion:
            vector=[emotion['intensity'] if e==emotion['label'] else 0.0 for e in EMOTIONS]
            # Upstream's UI bias: damps emotions that sound strange and caps the vector sum at 0.8.
            emo=dict(emo_vector=model.normalize_emo_vec(vector,apply_bias=True))
        model.infer(spk_audio_prompt=ref,text=text,lang=lang,output_path=out,
            temperature=settings['temperature'],top_p=settings['top_p'],verbose=False,**emo)
    elif key=='raon':
        from omegaconf import OmegaConf
        from hydra.utils import get_class
        from f5_tts.model import CFM
        from f5_tts.model.utils import get_tokenizer
        from f5_tts.infer.utils_infer import load_checkpoint,load_vocoder,infer_process
        from huggingface_hub import hf_hub_download
        cfg=OmegaConf.load(weights/'config.yaml')
        vocab=weights/'vocab.txt'
        cmap,n=get_tokenizer(str(vocab),'custom')
        model=CFM(transformer=get_class('f5_tts.model.'+cfg.model.backbone)(**cfg.model.arch,text_num_embeds=n,mel_dim=cfg.model.mel_spec.n_mel_channels),mel_spec_kwargs=cfg.model.mel_spec,vocab_char_map=cmap).to('cuda')
        ckpts=list(weights.glob('*.safetensors')) or list(weights.glob('*.pt'))
        if len(ckpts)!=1: raise RuntimeError('Expected exactly one Raon checkpoint')
        model=load_checkpoint(model,str(ckpts[0]),'cuda')
        vocpath=Path(hf_hub_download('speechbrain/tts-hifigan-libritts-16kHz','generator.ckpt')).parent
        vocoder=load_vocoder('sbhifigan16k',is_local=True,local_path=str(vocpath))
        wav,sr,_=infer_process(ref,transcript,text,model,vocoder,mel_spec_type='sbhifigan16k',nfe_step=settings['steps'],cfg_strength=settings['guidance'])
        sf.write(out,wav,sr)
    elif key in ('fishd3','fishs2'):
        # Upstream's CLI clones from reference audio and chunks long text itself (Drama 3 and S2-Pro).
        subprocess.run([sys.executable,'fish_speech/models/text2semantic/inference.py','--checkpoint-path',str(weights),
            '--text',tag_sentences(text,emotion_phrase(emotion)) if emotion else text,'--prompt-audio',ref,'--prompt-text',transcript,'--output',out,'--output-dir',str(Path(out).with_name('codes')),
            '--temperature',str(settings['temperature']),'--top-p',str(settings['top_p']),'--seed',str(seed),'--device','cuda:0'],check=True)
    elif key in ('gpt2','gpt5'):
        sys.path.insert(0,str(repo/'GPT_SoVITS'))
        from TTS_infer_pack.TTS import TTS,TTS_Config
        config=TTS_Config.default_configs
        version='v2Pro' if key=='gpt2' else 'v5dev'
        if version not in config: raise RuntimeError('Upstream configuration has no '+version+' entry')
        selected=dict(config[version],device='cuda',is_half=True,version=version)
        model=TTS(TTS_Config({'custom':selected}))
        lang={'English':'en','Chinese':'all_zh','Japanese':'all_ja','Korean':'all_ko'}[request['language']]
        chunks=list(model.run(dict(text=text,text_lang=lang,ref_audio_path=ref,prompt_text=transcript,prompt_lang=lang,
            top_k=15,top_p=settings['top_p'],temperature=settings['temperature'],text_split_method='cut5',batch_size=1,
            speed_factor=1.0,seed=seed,parallel_infer=False,split_bucket=False,return_fragment=False)))
        if not chunks: raise RuntimeError('GPT-SoVITS returned no audio')
        sr=chunks[0][0]; sf.write(out,np.concatenate([x[1] for x in chunks]),sr)
    else: raise ValueError('Unsupported model')
    audio,sr=sf.read(out)
    if audio.size==0 or not np.isfinite(audio).all() or np.max(np.abs(audio))<1e-6:
        raise RuntimeError('Generated audio is empty, nonfinite or silent')
    meta=dict(model=key,elapsed_seconds=round(time.monotonic()-started,3),audio_seconds=round(len(audio)/sr,3),sample_rate=sr,
        seed=seed,settings=settings,emotion=emotion,peak_allocated_mib=None if key in ('longcat','fishd3','fishs2') else round(torch.cuda.max_memory_allocated()/1048576,1))
    Path(out).with_suffix('.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')

if __name__=='__main__': main()
