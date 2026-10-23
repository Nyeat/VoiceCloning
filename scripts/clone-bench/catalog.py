"""Evaluation candidates; published claims are not local quality measurements."""
MODELS = {
    'longcat': dict(name='LongCat AudioDiT 3.5B', env='longcat', repo='meituan-longcat/LongCat-AudioDiT', weights='meituan-longcat/LongCat-AudioDiT-3.5B', transcript=True, language=['English', 'Chinese'], settings={'steps':16, 'guidance':4.0}, license='MIT'),
    'dots': dict(name='dots.tts SOAR', env='dots', repo='studio-dots-ai/dots.tts', weights='dots-studio/dots.tts-soar', transcript=True, language=['Auto'], settings={'steps':10, 'guidance':1.2}, license='Apache-2.0', demo='https://huggingface.co/spaces/dots-studio/dots.tts'),
    'vox': dict(name='VoxCPM2', env='vox', repo='OpenBMB/VoxCPM', weights='openbmb/VoxCPM2', transcript=False, language=['Auto'], settings={'steps':10, 'guidance':2.0}, emotion='instruction', license='Apache-2.0', demo='https://huggingface.co/spaces/OpenBMB/VoxCPM-Demo'),
    'qwen': dict(name='Qwen3-TTS 1.7B Base', env='qwen', repo='QwenLM/Qwen3-TTS', weights='Qwen/Qwen3-TTS-12Hz-1.7B-Base', transcript=True, language=['English','Chinese','Japanese','Korean','German','French','Russian','Portuguese','Spanish','Italian'], settings={'temperature':0.9, 'top_p':1.0}, license='Apache-2.0', demo='https://huggingface.co/spaces/Qwen/Qwen3-TTS'),
    'fire': dict(name='FireRedTTS3 Base', env='fire', repo='FireRedTeam/FireRedTTS3', weights='FireRedTeam/FireRedTTS3', transcript=True, language=['English','Chinese','Japanese','Korean','French','German','Spanish','Arabic','Hindi','Indonesian','Thai','Vietnamese'], settings={'steps':10, 'guidance':2.0}, license='Apache-2.0'),
    'index': dict(name='IndexTTS 2.5', env='index', repo='index-tts/index-tts', weights='IndexTeam/IndexTTS-2.5', transcript=False, language=['English','Chinese','Japanese','Spanish','Arabic'], settings={'temperature':0.8, 'top_p':0.8}, emotion='vector', license='Bilibili model licence', demo='https://huggingface.co/spaces/IndexTeam/IndexTTS-2.5-Demo'),
    'raon': dict(name='Raon OpenTTS 1B (noncommercial)', env='raon', repo='krafton-ai/Raon-OpenTTS', weights='KRAFTON/Raon-OpenTTS-1B', transcript=True, language=['English'], settings={'steps':32, 'guidance':2.0}, license='CC-BY-NC-4.0'),
    'fishd3': dict(name='Fish Audio Drama 3 (FP8 flagship)', env='fish', repo='fishaudio/fish-speech', weights='fishaudio/drama-3', transcript=True, language=['Auto'], settings={'temperature':0.7, 'top_p':0.7}, emotion='tags', license='Fish Audio Community License (commercial only under USD 500k revenue; hosted service needs separate licence)', demo='https://fish.audio'),
    'fishs2': dict(name='Fish Audio S2-Pro', env='fish', repo='fishaudio/fish-speech', weights='fishaudio/s2-pro', transcript=True, language=['Auto'], settings={'temperature':0.7, 'top_p':0.7}, emotion='tags', license='Fish Audio Research License (noncommercial)'),
    'gpt2': dict(name='GPT-SoVITS v2Pro (untrained baseline)', env='gpt', repo='RVC-Boss/GPT-SoVITS', weights='lj1995/GPT-SoVITS', transcript=True, language=['English','Chinese','Japanese','Korean'], settings={'temperature':1.0, 'top_p':1.0}, license='MIT'),
    'gpt5': dict(name='GPT-SoVITS v5dev (untrained baseline)', env='gpt5', repo='RVC-Boss/GPT-SoVITS', weights='lj1995/GPT-SoVITS', transcript=True, language=['English','Chinese','Japanese','Korean'], settings={'temperature':1.0, 'top_p':1.0}, license='MIT'),
}

# Emotion controls exist only where the model can steer emotion while keeping the cloned voice:
# 'vector' = IndexTTS emotion vector/text/reference, 'instruction' = VoxCPM2 parenthetical,
# 'tags' = Fish bracket tags. Order matches IndexTTS's emo_vector.
EMOTIONS = ['happy','angry','sad','afraid','disgusted','melancholic','surprised','calm']

def emotion_phrase(emotion):
    """Free-text description wins; otherwise the label with intensity wording."""
    if emotion.get('text'): return emotion['text']
    level=emotion['intensity']
    return ('slightly ' if level<0.34 else 'very ' if level>=0.67 else '')+emotion['label']
