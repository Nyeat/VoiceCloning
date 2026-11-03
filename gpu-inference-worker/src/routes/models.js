import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { GPT_SOVITS_ROOT } from '../config.js';
import {
  resolveRefAudioPath,
  warmReferenceAudioPaths,
} from '../services/refAudioCache.js';
import { inferenceServer } from '../services/inferenceServer.js';
import { recordWarmPayload } from '../services/bootWarm.js';
import { ensureCachedModel } from '../services/modelCache.js';
import { handleLiveTtsRequest } from './inference.js';

const router = Router();

const localGptWeightsDir = path.join(GPT_SOVITS_ROOT, 'GPT_weights_v2');
const localSoVitsWeightsDir = path.join(GPT_SOVITS_ROOT, 'SoVITS_weights_v2');

export function listWeightFiles(dir, extension) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter((filename) => filename.toLowerCase().endsWith(extension))
    .sort()
    .map((filename) => {
      const filePath = path.join(dir, filename);
      const stats = fs.statSync(filePath);
      return {
        name: filename,
        path: filePath,
        key: filePath,
        source: 'gpu-worker',
        size: stats.size,
        lastModified: stats.mtime.toISOString(),
        mtimeMs: stats.mtimeMs,
      };
    });
}

router.get('/models', (_req, res) => {
  try {
    res.json({
      gpt: listWeightFiles(localGptWeightsDir, '.ckpt'),
      sovits: listWeightFiles(localSoVitsWeightsDir, '.pth'),
      root: GPT_SOVITS_ROOT,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/models/download', async (req, res) => {
  const { s3Key } = req.body;
  if (!s3Key) {
    return res.status(400).json({ error: 's3Key is required' });
  }

  const filename = path.basename(s3Key);
  try {
    // Use the same key-derived path as request-time model enforcement. Otherwise
    // deep warm loads an unhashed alias and the first real request reloads the
    // exact same weights under a hashed filename.
    const localPath = await ensureCachedModel(s3Key);
    res.json({ localPath, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ref-audio/download', async (req, res) => {
  const { s3Key } = req.body;
  if (!s3Key) {
    return res.status(400).json({ error: 's3Key is required' });
  }

  const filename = path.basename(s3Key);

  try {
    const localPath = await resolveRefAudioPath(s3Key);
    res.json({ localPath, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ref-audio/warm', async (req, res) => {
  const { ref_audio_path } = req.body || {};
  if (!ref_audio_path) {
    return res.status(400).json({ error: 'ref_audio_path is required' });
  }

  try {
    const warmed = await warmReferenceAudioPaths(req.body);

    // Generation pre-warm: caching the reference audio above is cheap, but the FIRST
    // real synth after a fresh weight load is cold (CUDA kernels + reference feature
    // extraction), which adds seconds to the first live tts-sentence clip. Fire one
    // tiny throwaway synth here so the generation path is hot by the time the first
    // real request arrives. This runs on every model load (loadModelPair calls this
    // route), so any consumer of /inference/tts — including external chatbots — gets a
    // warm first clip without doing anything. Best-effort: the audio is discarded and
    // any failure is swallowed so it never blocks the reference warm that already
    // succeeded.
    let synthWarmed = false;
    try {
      const status = await inferenceServer.getStatus();
      if (status.ready) {
        await handleLiveTtsRequest({
          ...req.body,
          ref_audio_path: warmed.ref_audio_path,
          aux_ref_audio_paths: warmed.aux_ref_audio_paths,
          text: req.body.warm_text || 'Ready.',
          text_lang: req.body.text_lang || 'en',
          // handleLiveTtsRequest bypasses readInferenceParams, which is what
          // normally defaults these. Without them the python /tts rejects the warm
          // synth with 400 "prompt_lang is required" and the model never warms.
          prompt_lang: req.body.prompt_lang || 'en',
          prompt_text: req.body.prompt_text || '',
        });
        synthWarmed = true;
        // Persist this payload so a bare service restart can replay the warm at boot
        // (see WARM_ON_BOOT). Only record once we know it produced a real synth.
        recordWarmPayload(req.body, { preserveResidentVoice: true });
      }
    } catch (warmErr) {
      console.warn(`[ref-audio/warm] generation pre-warm failed: ${warmErr.message}`);
    }

    res.json({
      ref_audio_path: warmed.ref_audio_path,
      aux_ref_audio_paths: warmed.aux_ref_audio_paths,
      synthWarmed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
