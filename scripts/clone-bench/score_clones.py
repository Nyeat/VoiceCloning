"""Score voice-cloning outputs from many models on the same refs + sentences.

Layout (BENCH_DIR):
  refs/<speaker>.wav           reference clip (5-15 s, clean)
  refs/<speaker>.txt           its transcript (needed by F5/LongCat/GPT-SoVITS)
  sentences.txt                one "<id>|<text>" per line
  outputs/<model>/<speaker>__<id>.wav   generated audio, any sample rate

Metrics per clip (Seed-TTS-Eval style, but on YOUR voices):
  sim_wavlm   cosine sim, microsoft/wavlm-base-plus-sv  (higher = closer voice)
  sim_resemb  cosine sim, resemblyzer (same encoder as our production gate)
  wer         word error rate, faster-whisper large-v3 (lower = better pronunciation)

Usage:
  pip install torch torchaudio transformers faster-whisper resemblyzer jiwer soundfile librosa
  python score_clones.py BENCH_DIR [--device cuda]
Writes BENCH_DIR/scores.csv and prints a per-model summary ranked by sim_wavlm.
"""
import argparse
import csv
import re
import statistics
from pathlib import Path

import jiwer
import librosa
import numpy as np
import torch


def norm_text(s):
    s = s.lower().replace("’", "'")
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def load16k(path):
    wav, _ = librosa.load(path, sr=16000, mono=True)
    return wav


class WavLMSV:
    def __init__(self, device):
        from transformers import AutoFeatureExtractor, WavLMForXVector
        name = "microsoft/wavlm-base-plus-sv"
        self.fe = AutoFeatureExtractor.from_pretrained(name)
        self.model = WavLMForXVector.from_pretrained(name).to(device).eval()
        self.device = device

    @torch.no_grad()
    def embed(self, wav):
        x = self.fe(wav, sampling_rate=16000, return_tensors="pt").to(self.device)
        e = self.model(**x).embeddings[0]
        return torch.nn.functional.normalize(e, dim=-1).cpu().numpy()


class Resemb:
    def __init__(self, device):
        from resemblyzer import VoiceEncoder, preprocess_wav
        self.enc = VoiceEncoder(device=device)
        self.pre = preprocess_wav

    def embed(self, wav):
        return self.enc.embed_utterance(self.pre(wav, source_sr=16000))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bench_dir", type=Path)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--whisper", default="large-v3")
    args = ap.parse_args()
    root = args.bench_dir

    sentences = {}
    for line in (root / "sentences.txt").read_text(encoding="utf-8").splitlines():
        if "|" in line:
            sid, text = line.split("|", 1)
            sentences[sid.strip()] = text.strip()

    from faster_whisper import WhisperModel
    asr = WhisperModel(args.whisper, device=args.device,
                       compute_type="float16" if args.device == "cuda" else "int8")
    wavlm, resemb = WavLMSV(args.device), Resemb(args.device)

    ref_emb = {}
    for ref in sorted((root / "refs").glob("*.wav")):
        w = load16k(ref)
        ref_emb[ref.stem] = (wavlm.embed(w), resemb.embed(w))

    rows = []
    for model_dir in sorted(p for p in (root / "outputs").iterdir() if p.is_dir()):
        for clip in sorted(model_dir.glob("*.wav")):
            speaker, _, sid = clip.stem.partition("__")
            if speaker not in ref_emb or sid not in sentences:
                print(f"skip {clip} (unknown speaker or sentence id)")
                continue
            w = load16k(clip)
            segs, _ = asr.transcribe(w, language="en", beam_size=5)
            hyp = " ".join(s.text for s in segs)
            ref_w, ref_r = ref_emb[speaker]
            rows.append({
                "model": model_dir.name, "speaker": speaker, "id": sid,
                "sim_wavlm": float(np.dot(ref_w, wavlm.embed(w))),
                "sim_resemb": float(np.dot(ref_r, resemb.embed(w))),
                "wer": jiwer.wer(norm_text(sentences[sid]), norm_text(hyp) or "<empty>"),
                "hyp": hyp.strip(),
            })
            print(f"{model_dir.name:24s} {clip.stem:30s} sim={rows[-1]['sim_wavlm']:.3f} wer={rows[-1]['wer']:.3f}")

    with open(root / "scores.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    print(f"\n{'model':24s} {'n':>4s} {'sim_wavlm':>10s} {'sim_resemb':>11s} {'WER%':>7s} {'clips>10%WER':>13s}")
    by_model = {}
    for r in rows:
        by_model.setdefault(r["model"], []).append(r)
    summary = sorted(by_model.items(), key=lambda kv: -statistics.mean(r["sim_wavlm"] for r in kv[1]))
    for name, rs in summary:
        print(f"{name:24s} {len(rs):4d} "
              f"{statistics.mean(r['sim_wavlm'] for r in rs):10.3f} "
              f"{statistics.mean(r['sim_resemb'] for r in rs):11.3f} "
              f"{100 * statistics.mean(r['wer'] for r in rs):7.2f} "
              f"{sum(r['wer'] > 0.10 for r in rs):13d}")


if __name__ == "__main__":
    main()
