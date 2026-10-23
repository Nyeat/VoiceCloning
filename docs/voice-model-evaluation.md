# Voice-Cloning Model Evaluation (October 2026)

Goal: decide whether a newer open model should replace or complement **GPT-SoVITS v2Pro** (current
production) by measuring, on *our own* reference voices:

1. **Speaker similarity** (does it sound like the reference person) — primary.
2. **Pronunciation accuracy** (WER; skipped/clipped/wrong words) — secondary.

Published leaderboards use Common Voice / DiDiSpeech speakers and differ in ASR and speaker-encoder
choices, so they shortlist candidates; they do not pick the winner.

## Published zero-shot numbers (Seed-TTS-Eval, self-reported)

SIM = speaker-embedding cosine similarity (higher better). WER = English word error rate (lower better).

| Model | EN SIM | EN WER | License | Status of figure |
|---|---|---|---|---|
| LongCat-AudioDiT 3.5B | 0.786 | 1.50% | MIT | Verified in official repo |
| FireRedTTS3-Base | 0.772 | 1.64% | check | From ChatGPT list, not verified |
| dots.tts SOAR 2B | 0.771 | 1.30% | Apache-2.0 (base; confirm SOAR) | From ChatGPT list; report exists |
| LongCat-AudioDiT 1B | 0.762 | 1.78% | MIT | Verified in official repo |
| VoxCPM2 | 0.753 | 1.84% | Apache-2.0 | Verified in tech report |
| Raon-OpenTTS-1B | 0.749* | 1.78%* | **CC BY-NC** (eval only) | Its own card; *combined score, WavLM-large |
| CosyVoice3.5 | 0.738 | 1.57% | check | Not verified |
| Qwen3-TTS 1.7B | ~0.71 | 1.08–1.46% | Apache-2.0 | Varies by source |
| IndexTTS2 | 0.706–0.709 | 2.18–2.23% | check | Two sources agree roughly |
| F5-TTS | 0.670 | 2.00% | CC BY-NC (weights) | Verified in VoxCPM paper |
| GPT-SoVITS v5 / v2Pro | ZH only | — | MIT | Dev figures in README image; not verified |

These are source-reported results, not an independently controlled comparison. There is no
justified universal SIM/WER noise cutoff without repeated runs and confidence intervals.

## Comparison with ChatGPT's picks

- LongCat-AudioDiT 3.5B is a strong similarity candidate; these heterogeneous reports do not
  establish a universal best open-weight model.
- **Agree with caveat:** VoxCPM2 LoRA as a few-shot pick is reasonable, but no fair published
  fine-tuning comparison exists. An anecdotal blind test reported fine-tuned Qwen3-TTS sounding clean
  but like a different speaker, which is exactly our failure mode — only our own test settles this.
- **Missed by ChatGPT:** Raon-OpenTTS-1B (strong SIM, non-commercial licence).
- **Unverified in ChatGPT's list:** GPT-SoVITS v5 numbers, FireRedTTS3, MegaTTS3, CosyVoice3.5, and the
  commercial Elo snapshot (HeyGen / ElevenLabs).
- **Extra signal:** one independent blind listening test ranked dots.tts first by ear.

## Recommendation

- **Current zero-shot lab (9):** LongCat 3.5B, dots.tts SOAR, VoxCPM2, Qwen3-TTS 1.7B Base,
  FireRedTTS3 Base, IndexTTS **2.5**, Raon-OpenTTS-1B, GPT-SoVITS v2Pro and **v5dev**.
  GPT-SoVITS uses pretrained weights, not the project's trained voices. No fine-tuning is performed.
- **Added 2026-10-23:** Fish Audio Drama 3 (35B-A3B, FP8 experts, Fish Audio Community License: commercial
  only under USD 500k revenue) and S2-Pro (Fish Audio Research License, noncommercial). FireRedTTS3
  now requires a <=12 s reference ending on a full sentence (30 s mid-phrase reference gave 63% WER).
- GPT-SoVITS is the existing few-shot baseline, not a demonstrated universal winner. Keep the
  few-shot comparison deferred until a controlled comparison on the same training data is wanted.
- **Few-shot round (after zero-shot):** VoxCPM2 LoRA vs dots.tts fine-tune vs GPT-SoVITS v2Pro
  fine-tune, each trained on 1 min and 5 min of the same speaker, tested on held-out sentences.
- Only switch production if a model beats v2Pro on **both** similarity and WER on our voices, then
  check latency/VRAM against the current GPU workers before any deployment work.

## Where to run

Local GPU is an RTX 4050 Laptop (6 GB VRAM), 32 GB RAM.

| Model | Local 6 GB | Alternative |
|---|---|---|
| GPT-SoVITS, F5-TTS, Qwen3-TTS 0.6B | Yes | — |
| Qwen3-TTS 1.7B | Tight | fal.ai `fal-ai/qwen-3-tts/clone-voice/1.7b` (returns embedding, then TTS call) |
| VoxCPM2 (~8 GB) | No | HF Space `openbmb/VoxCPM-Demo` for listening |
| Raon-OpenTTS-1B | Probably no | Community HF Space `raufokz/Raon-OpenTTS-1B-Demo` |
| LongCat 3.5B, dots.tts (~8.8 GB ckpt), IndexTTS2, FireRedTTS3, all fine-tuning | No | Rented GPU |

VRAM figures without a published number are estimates.

**Hosting:** rent one 48 GB GPU (L40S / A6000 on RunPod or Vast.ai, ~$1/h) for an afternoon, run
every model there, copy outputs back. Do not use the staging GPU workers for this. Scoring runs on
the laptop (use `--whisper medium` if large-v3 runs out of VRAM).

The paragraph above was the initial proposal, not a current price quote. The actual October 22
deployment uses one isolated AWS `g6e.2xlarge` (L40S, 64 GiB RAM), 350 GiB gp3, in Seoul.
Current resource IDs, access and shutdown instructions are in project-memory `docs/deployment.md`.

## October 22 compatibility checks

- Official code/model cards checked: LongCat, dots SOAR, VoxCPM2, Qwen3-TTS, FireRedTTS3,
  IndexTTS 2.5, Raon and GPT-SoVITS. Public interactive demos are linked in `catalog.py` where
  the authors link them; their uptime, free quotas and API availability are not guaranteed.
- LongCat includes the October 15 reference-normalization fix. Its official demo link is a
  samples page, which does not by itself establish an upload-and-clone service.
- IndexTTS 2.5 replaces 2 for this round. GPT-SoVITS v5dev uses the upstream
  `cuda_graph_accel_v5` branch. CosyVoice3.5 appears in published comparisons, but the checked
  official repository advertises open Fun-CosyVoice3; a 3.5 row is not proof of available weights.
- Separate Python environments avoid incompatible Transformers/Torch requirements. The UI queues
  requests, uses a host-wide file lock, and exits each inference process to release GPU memory.
  This is a comparison lab: model loading is included in elapsed time, not a persistent low-latency server.
- Compatibility fixes: omit dots' unavailable `gradio==6.17.0` optional-UI constraint; correct
  Raon's build backend and supply its undeclared inference imports; add GPT-SoVITS `resampy`.
  These changes are encoded in `install_lab.py`. Exact checkout revisions and package lists are
  recorded under the host's `status/` directory.
- Raon weights are CC-BY-NC-4.0; IndexTTS has its own model licence. Inclusion in this evaluation
  does not grant production/commercial deployment rights.
- `smoke_lab.py` generates actual speech from the official 8.08-second Qwen example reference.
  `verify_lab.py` independently decodes outputs with ffprobe/soundfile and optionally runs CPU
  Whisper small.en. Neither a valid WAV nor one short transcription proves voice similarity.
- Use the user's own recordings and the protocol below to rank models. No quality winner has
  been established by the setup smoke tests.

## Test protocol

1. **References:** 3–5 speakers including real target voices; 8–15 s clean clip each plus transcript.
2. **Sentences:** `scripts/clone-bench/sentences.txt` (hard words like "cohesin", numbers, times,
   emotion, and one long sentence, since long chunks are where pronunciation drift appears).
3. **Generate:** every model × speaker × sentence, default settings, same reference clip, one take
   (no cherry-picking; or 3 seeds averaged).
4. **Layout:**
   ```
   bench/refs/<speaker>.wav + <speaker>.txt
   bench/sentences.txt
   bench/outputs/<model>/<speaker>__<sentence-id>.wav
   ```
5. **Score:** `python scripts/clone-bench/score_clones.py bench` →
   `bench/scores.csv` + per-model summary: WavLM-SV SIM, resemblyzer SIM (same encoder as the
   production gate), Whisper large-v3 WER, and count of clips over 10% WER (catches skipped words).
   Our WavLM model is base-plus-sv, not the papers' WavLM-large, so compare models with each other,
   not with published numbers.
6. **Listen:** blind A/B the top 3; metrics and ears can disagree.

## Sources

- LongCat-AudioDiT: https://github.com/meituan-longcat/LongCat-AudioDiT
- Raon-OpenTTS-1B: https://huggingface.co/KRAFTON/Raon-OpenTTS-1B
- VoxCPM2 report: https://arxiv.org/pdf/2606.06928
- dots.tts report / card: https://arxiv.org/pdf/2606.07080 · https://huggingface.co/dots-studio/dots.tts-soar
- FireRedTTS3: https://arxiv.org/pdf/2608.17492
- FireRedTTS3 code: https://github.com/FireRedTeam/FireRedTTS3
- IndexTTS releases and interactive demo: https://github.com/index-tts/index-tts
- Qwen3-TTS: https://github.com/QwenLM/Qwen3-TTS
- CosyVoice release availability: https://github.com/QwenAudio/CosyVoice
- GPT-SoVITS: https://github.com/RVC-Boss/GPT-SoVITS
- Blind listening test (anecdotal): https://medium.com/@austin-starks/best-ai-voice-cloning-in-2026-i-cloned-my-own-voice-seven-ways-and-ranked-them-blind-404807485d43
- fal.ai Qwen3-TTS clone: https://fal.ai/models/fal-ai/qwen-3-tts/clone-voice/1.7b/llms.txt
- Seed-TTS-Eval: https://github.com/jzq2000/seed-tts-eval

## Zero-shot lab - 2026-10-22

- Seoul ap-northeast-2a: i-093e8b2081168aff3, g6e.2xlarge, one L40S, 8 vCPU, 64 GiB RAM, 350 GiB gp3. Dev/Staging unchanged.
- Public URL: https://d11833a346b73cedf4.gradio.live/ . Login: repo-local .tmp/zero-shot/access.json; do not commit credentials. The old f9a287074a9fc61eb4 link is obsolete.
- Eight models generated valid audio: LongCat, dots.tts, VoxCPM2, Qwen3-TTS, FireRedTTS3, IndexTTS2.5, untrained GPT-SoVITS v2Pro and v5dev. Raon is blocked by a published vocabulary/checkpoint mismatch (5559 versus 5555 tokens); no speculative token remapping applied.
- Independent ffprobe/soundfile and CPU Whisper checks passed for the eight outputs. Ten input-validation tests passed. Authenticated public Qwen API returned 4.88 seconds of audio in 30.731 seconds; unauthenticated config access returned 401. Speaker similarity, browser microphone interaction and broad language coverage remain unverified.
- Remote root /opt/zero-shot-lab; systemd zero-shot-lab.service runs as ubuntu and starts on boot. Logs: logs/ui.log; evidence: smoke/verification-results.json and smoke/public-api.json. Each request loads one model and releases GPU memory on exit.
- Scheduled shutdown: 2026-10-22 22:20 SGT. EC2 stop retains billable EBS. Temporary Gradio URL can change on service restart and lasts up to one week. Stop earlier using AWS EC2 stop-instances for this instance in ap-northeast-2.
