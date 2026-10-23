"""Run on the isolated Linux GPU. Each model gets a separate Python environment."""
import json, os, subprocess, sys, time
from pathlib import Path
from catalog import MODELS
ROOT = Path(os.environ.get('CLONE_LAB_ROOT', '/opt/zero-shot-lab'))
os.environ['HF_HOME'] = str(ROOT / 'cache/huggingface')
os.environ['UV_CACHE_DIR'] = str(ROOT / 'cache/uv')
# start_lab.sh hands repos to ubuntu, so root re-installs hit git's dubious-ownership check; Git 2.34
# honours safe.directory only from global config. setuptools-scm strips GIT_* variables, so its builds
# get this file through HOME instead (see the fish branch).
GIT_HOME = ROOT / 'status/githome'
GIT_HOME.mkdir(parents=True, exist_ok=True)
(GIT_HOME / '.gitconfig').write_text('[safe]\n\tdirectory = *\n')
os.environ['GIT_CONFIG_GLOBAL'] = str(GIT_HOME / '.gitconfig')

def run(*args, cwd=None, env=None):
    subprocess.run(list(map(str,args)), cwd=cwd, env=env, check=True)

def install(key):
    m=MODELS[key]; name=m['env']; repo=ROOT/'repos'/name; env=ROOT/'envs'/name
    status=ROOT/'status'/f'{key}.json'
    status.parent.mkdir(parents=True,exist_ok=True)
    def report(state, **details):
        status.write_text(json.dumps(dict(state=state,time=time.time(),**details)),encoding='utf-8')
    report('installing')
    try:
        if not repo.exists():
            args=['git','clone','--depth','1']
            if key=='gpt5': args+=['--branch','cuda_graph_accel_v5']
            run(*args, 'https://github.com/'+m['repo']+'.git', repo)
        if not env.exists(): run('uv','venv','--python','3.12' if key.startswith('fish') else '3.10',env)
        py=env/'bin/python'
        pip=['uv','pip','install','--python',str(py)]
        run(*pip,'pip','setuptools','wheel','huggingface_hub','soundfile')
        if key=='longcat':
            run(*pip,'torch==2.8.0','torchaudio==2.8.0','-r',repo/'requirements.txt')
        elif key=='dots':
            # Upstream's optional UI constraint refers to an unpublished Gradio release.
            constraints=ROOT/'status/dots-constraints.txt'
            constraints.write_text('\n'.join(x for x in (repo/'constraints/recommended.txt').read_text().splitlines() if not x.startswith('gradio==')))
            run(*pip,'-e',repo,'-c',constraints)
        elif key=='vox':
            run(*pip,'-e',repo)
        elif key=='qwen':
            run(*pip,'-e',repo,'torch==2.8.0','torchaudio==2.8.0','librosa','matplotlib','torchdiffeq','wandb')
        elif key=='fire':
            # Flash Attention is installed separately after torch, as required by its build.
            req=[x for x in (repo/'requirements.txt').read_text().splitlines() if x and not x.startswith('flash_attn')]
            run(*pip,*req)
            run(*pip,'packaging','ninja')
            run(*pip,'flash-attn==2.8.3','--no-build-isolation')
        elif key=='index':
            run(*pip,'-e',repo)
        elif key=='raon':
            project=repo/'pyproject.toml'
            project.write_text(project.read_text().replace('setuptools.backends._legacy:_Backend','setuptools.build_meta').replace('setuptools.build_meta:_Backend','setuptools.build_meta'))
            run(*pip,'-e',repo,'torch==2.8.0','torchaudio==2.8.0')
        elif key.startswith('fish'):
            # Upstream's lockfile, not a fresh resolve: newer tensorboard needs a newer protobuf.
            # pyaudio is only for upstream's live tools and needs portaudio headers. --no-deps because
            # the lock is already resolved under upstream's protobuf override, which uv pip cannot apply.
            locked=ROOT/'status/fish-requirements.txt'
            text=subprocess.check_output(['uv','export','--frozen','--extra','cu128','--no-hashes','--no-emit-project','--no-header'],cwd=repo,text=True)
            locked.write_text('\n'.join(x for x in text.splitlines() if not x.startswith('pyaudio')))
            run(*pip,'--no-deps','-r',locked,'--extra-index-url','https://download.pytorch.org/whl/cu128','--index-strategy','unsafe-best-match')
            run(*pip,'--no-deps','-e',repo,env=dict(os.environ,HOME=str(GIT_HOME)))
        elif key.startswith('gpt'):
            run(*pip,'torch==2.8.0','torchaudio==2.8.0')
            run(*pip,'-r',repo/'requirements.txt')
            run(*pip,'resampy')
        # Record exact revisions and package versions, rather than silently relying on main.
        revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
        with (ROOT/'status'/f'{key}-packages.txt').open('w') as out:
            subprocess.run(['uv','pip','freeze','--python',str(py)],stdout=out,check=True)
        model_dir=ROOT/'models'/key
        code='from huggingface_hub import snapshot_download; snapshot_download('+repr(m['weights'])+', local_dir='+repr(str(model_dir))+')'
        if key.startswith('gpt'):
            patterns=['chinese-hubert-base/*','chinese-roberta-wwm-ext-large/*','s1v3.ckpt','v2Pro/s2Gv2Pro.pth','sv/*','gsv-v5-pretrained/*']
            code='from huggingface_hub import snapshot_download; snapshot_download('+repr(m['weights'])+', local_dir='+repr(str(repo/'GPT_SoVITS/pretrained_models'))+', allow_patterns='+repr(patterns)+')'
        run(py,'-c',code)
        report('installed — synthesis not yet verified',revision=revision)
    except Exception as e:
        report('installation failed',error=str(e)); raise

if __name__=='__main__':
    install(sys.argv[1])
