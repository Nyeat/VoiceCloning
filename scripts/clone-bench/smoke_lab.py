"""Real synthesis checks with the official Qwen example, not a quality benchmark."""
import json, sys, time
from pathlib import Path
from app import generate, status, ROOT
from catalog import MODELS

TRANSCRIPT='Okay. Yeah. I resent you. I love you. I respect you. But you know what? You blew it! And thanks to you.'
TEXT='Welcome to the voice cloning comparison. The meeting begins at nine thirty tomorrow morning.'
for key in (sys.argv[1:] or ['qwen','index','longcat','vox','dots','raon','fire','gpt2','gpt5','fishs2','fishd3']):
    m=MODELS[key]
    result={'model':key,'reference_source':'https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-TTS-Repo/clone.wav'}
    try:
        audio,meta,details=generate(key,str(ROOT/'smoke/reference.wav'),TRANSCRIPT,TEXT,m['language'][0],42,json.dumps(m['settings']))
        result.update(ok=True,audio=audio,metadata=meta)
        state=status(key); state.update(state='verified audio generation',verified_at=time.time())
        (ROOT/'status'/f'{key}.json').write_text(json.dumps(state))
    except Exception as e: result.update(ok=False,error=str(e))
    (ROOT/'smoke'/f'{key}.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
