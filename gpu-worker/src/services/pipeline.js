import fs from 'fs';
import path from 'path';
import {
  GPT_SOVITS_ROOT,
  SCRIPTS,
  PRETRAINED,
  CONFIG_TEMPLATES,
  LOCAL_TEMP_ROOT,
} from '../config.js';
import { processManager } from './processManager.js';
import { sseManager } from './sseManager.js';
import { trainingState } from './trainingState.js';
import { generateSoVITSConfig, generateGPTConfig } from './configGenerator.js';
import { STEPS } from './trainingSteps.js';
import { downloadFile, downloadPrefix, objectExists, uploadDirectory, uploadFile } from './s3Sync.js';
import { recordTrainingLog } from './trainingLogger.js';
import { sendTrainingCompleteEmail } from './emailService.js';
import { buildFilteredTrainingManifest } from './trainingQuality.js';
import { applyKnownTextToManifestFile, readKnownTextFile } from './knownTextLabels.js';
import { resetIfInputsChanged } from './trainingInputs.js';

function sendStep(sessionId, stepIndex, status, detail) {
  trainingState.setStepStatus(stepIndex, status, detail || '');
  sseManager.send(sessionId, 'step-start', {
    step: stepIndex,
    name: STEPS[stepIndex],
    status,
    detail: detail || '',
  });
}

function completeStep(sessionId, stepIndex, code = 0) {
  trainingState.setStepStatus(stepIndex, code === 0 ? 'done' : 'error');
  sseManager.send(sessionId, 'step-complete', {
    step: stepIndex,
    name: STEPS[stepIndex],
    code,
  });
}

function dirHasFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir);
  return pattern ? files.some(f => pattern.test(f)) : files.length > 0;
}

function assertDirHasFiles(dir, pattern, stepName) {
  if (!dirHasFiles(dir, pattern)) {
    throw new Error(`${stepName} failed: no output files produced in ${dir}`);
  }
}

function mergePartFiles(dir, baseName, ext) {
  const partFile = path.join(dir, `${baseName}-0${ext}`);
  const outFile = path.join(dir, `${baseName}${ext}`);
  if (!fs.existsSync(partFile)) return;
  const content = fs.readFileSync(partFile, 'utf-8');
  fs.writeFileSync(outFile, content);
}

function skipStep(sessionId, stepIndex, reason) {
  sendStep(sessionId, stepIndex, 'skipped', reason);
  recordTrainingLog(sessionId, {
    stream: 'stdout',
    data: `Skipping "${STEPS[stepIndex]}": ${reason}\n`,
  });
  completeStep(sessionId, stepIndex, 0);
  return 'skipped';
}

function assertSafeCleanupTarget(targetPath, allowedRoot) {
  if (!targetPath) {
    throw new Error('Cleanup target path is required');
  }
  if (!allowedRoot) {
    throw new Error('Cleanup allowed root path is required');
  }

  const resolved = path.resolve(targetPath);
  const root = path.resolve(allowedRoot);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to cleanup path outside allowed cleanup root: ${targetPath}`);
  }

  return resolved;
}

export function cleanupLocalTrainingArtifacts({
  localExpDir,
  logsDir,
  sessionId,
  localTempRoot = LOCAL_TEMP_ROOT,
  logsRoot = path.join(GPT_SOVITS_ROOT, 'logs'),
} = {}) {
  const targets = [
    { label: 'training scratch', dir: localExpDir, root: localTempRoot },
    { label: 'training logs/features/checkpoints', dir: logsDir, root: logsRoot },
  ];
  const removed = [];

  for (const target of targets) {
    const resolved = assertSafeCleanupTarget(target.dir, target.root);
    if (!fs.existsSync(resolved)) {
      continue;
    }

    fs.rmSync(resolved, { recursive: true, force: true });
    removed.push({ ...target, dir: resolved });
  }

  if (sessionId && removed.length > 0) {
    recordTrainingLog(sessionId, {
      stream: 'stdout',
      data: `Cleaned local training artifacts after S3 upload:\n${removed.map(item => `- ${item.label}: ${item.dir}`).join('\n')}\n`,
    });
  }

  return removed;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function buildTrainingRunMetadata({
  sessionId = '',
  expName = '',
  ownerEmail = '',
  startedAt = '',
  completedAt = '',
  config = {},
  selectedReferences = {},
  sourceDatasetStats = {},
} = {}) {
  return {
    schemaVersion: 1,
    sessionId,
    expName,
    // The lecturer this voice belongs to. Carried into the saved voice profile
    // so a signed-in lecturer can be matched to their voice.
    ...(ownerEmail ? { ownerEmail } : {}),
    engineVersion: 'v2ProPlus',
    startedAt,
    completedAt,
    training: {
      batchSize: config.batchSize,
      sovitsEpochs: config.sovitsEpochs,
      gptEpochs: config.gptEpochs,
      sovitsSaveEvery: config.sovitsSaveEvery,
      gptSaveEvery: config.gptSaveEvery,
      asrLanguage: config.asrLanguage,
      asrModel: config.asrModel,
      skipDenoise: Boolean(config.skipDenoise),
    },
    selectedReferences: isPlainObject(selectedReferences) ? selectedReferences : {},
    sourceDatasetStats: isPlainObject(sourceDatasetStats) ? sourceDatasetStats : {},
  };
}

export async function runPipelineWithS3(sessionId, {
  expName,
  email = '',
  ownerEmail = '',
  s3Prefix: rawAudioPrefix,
  batchSize = 2,
  sovitsEpochs = 8,
  gptEpochs = 15,
  sovitsSaveEvery = 4,
  gptSaveEvery = 5,
  asrLanguage = 'en',
  asrModel = 'large-v3',
  skipDenoise = true,
  selectedReferences = {},
  sourceDatasetStats = {},
  testVoiceUrl = '',
}) {
  const startedAt = new Date().toISOString();
  const localExpDir = path.join(LOCAL_TEMP_ROOT, expName);
  const dataDir = path.join(localExpDir, 'data');
  const rawDir = path.join(dataDir, 'raw');
  const slicedDir = path.join(dataDir, 'sliced');
  const denoisedDir = path.join(dataDir, 'denoised');
  const asrDir = path.join(dataDir, 'asr');
  const clipScoresPath = path.join(dataDir, 'clip-scores.json');
  const qualityReportPath = path.join(dataDir, 'training-quality-report.json');
  const filteredAsrListPath = path.join(asrDir, 'denoised.filtered.list');
  const logsDir = path.join(GPT_SOVITS_ROOT, 'logs', expName);
  const sovitsWeightsDir = path.join(localExpDir, 'weights', 'sovits');
  const gptWeightsDir = path.join(localExpDir, 'weights', 'gpt');

  for (const dir of [rawDir, slicedDir, denoisedDir, asrDir, logsDir, sovitsWeightsDir, gptWeightsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── S3 Sync Down ──
  recordTrainingLog(sessionId, {
    stream: 'stdout',
    data: `Downloading training audio from S3: ${rawAudioPrefix}\n`,
  });

  // Start from exactly what is in S3 now: a file removed there (an earlier
  // set's recordings) must not linger in this run's raw folder.
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });
  const downloadCount = await downloadPrefix(rawAudioPrefix, rawDir);
  recordTrainingLog(sessionId, {
    stream: 'stdout',
    data: `Downloaded ${downloadCount} files from S3\n`,
  });

  if (downloadCount === 0) {
    throw new Error('No training audio files found in S3');
  }

  // Voice Studio saves the text of script readings it knows (the specialty
  // terms) beside the raw audio; ASR labels for those clips are replaced by it.
  const knownTextPath = path.join(dataDir, 'known-text.json');
  // Processed data from a previous run of this name is reused only when it was
  // made from these same recordings; otherwise every step runs again.
  if (resetIfInputsChanged({
    rawDir,
    stampPath: path.join(dataDir, 'raw-inputs.json'),
    dirs: [slicedDir, denoisedDir, asrDir, logsDir, sovitsWeightsDir, gptWeightsDir],
    files: [clipScoresPath, qualityReportPath, knownTextPath],
  })) {
    recordTrainingLog(sessionId, {
      stream: 'stdout',
      data: 'The recordings changed since this voice was last processed: slicing, transcribing and training it again from scratch.\n',
    });
  }
  const knownTextKey = `${String(rawAudioPrefix).replace(/raw\/?$/u, '')}known-text.json`;
  try {
    if (!fs.existsSync(knownTextPath) && await objectExists(knownTextKey)) {
      await downloadFile(knownTextKey, knownTextPath);
    }
  } catch (error) {
    recordTrainingLog(sessionId, {
      stream: 'stderr',
      data: `Could not download known script text (${error.message}); ASR labels are used as-is.\n`,
    });
  }
  const knownText = readKnownTextFile(knownTextPath);
  if (Object.keys(knownText).length > 0) {
    recordTrainingLog(sessionId, {
      stream: 'stdout',
      data: `Known script text found for ${Object.keys(knownText).length} recording(s); their clips will be labelled with it.\n`,
    });
  }

  function getAsrListFile() {
    if (fs.existsSync(filteredAsrListPath)) return filteredAsrListPath;
    const asrFiles = fs.readdirSync(asrDir).filter(f => f.endsWith('.list'));
    return asrFiles.length > 0
      ? path.join(asrDir, asrFiles[0])
      : path.join(asrDir, 'denoised.list');
  }

  async function ensureClipScores() {
    if (fs.existsSync(clipScoresPath)) return;
    recordTrainingLog(sessionId, {
      stream: 'stdout',
      data: 'Measuring clip quality before feature extraction...\n',
    });
    await processManager.run({
      scriptPath: SCRIPTS.scoreClips,
      args: [denoisedDir, '--json', clipScoresPath],
      sessionId,
    });
  }

  function writeFilteredTrainingManifest() {
    const originalList = fs.readdirSync(asrDir)
      .filter((filename) => filename.endsWith('.list') && filename !== path.basename(filteredAsrListPath))
      .map((filename) => path.join(asrDir, filename))[0];
    if (!originalList) throw new Error('ASR failed: no transcript manifest was produced');

    if (Object.keys(knownText).length > 0) {
      const labelled = applyKnownTextToManifestFile({
        listPath: originalList,
        backupPath: path.join(asrDir, 'asr-whisper.txt'),
        knownText,
      });
      recordTrainingLog(sessionId, {
        stream: 'stdout',
        data: `Known-text labels: ${labelled.relabelled} clip(s) relabelled from the script, `
          + `${labelled.keptAsr} kept their ASR text (did not match the script).\n`,
      });
    }

    const scoreEntries = JSON.parse(fs.readFileSync(clipScoresPath, 'utf-8'));
    const filtered = buildFilteredTrainingManifest({
      manifestText: fs.readFileSync(originalList, 'utf-8'),
      scoreEntries,
    });
    fs.writeFileSync(filteredAsrListPath, filtered.manifestText);
    fs.writeFileSync(qualityReportPath, JSON.stringify(filtered.report, null, 2));
    recordTrainingLog(sessionId, {
      stream: filtered.report.rejectedClips > 0 ? 'stderr' : 'stdout',
      data: `Training quality gate kept ${filtered.report.keptClips}/${filtered.report.totalClips} clips `
        + `(${filtered.report.keptDurationSeconds}s); rejected ${filtered.report.rejectedClips}.\n`,
    });
    return filtered.report;
  }

  const steps = [
    // Step 0: Slice Audio
    async () => {
      if (dirHasFiles(slicedDir, /\.(wav|mp3|ogg|flac)$/i)) {
        return skipStep(sessionId, 0, 'sliced audio already exists');
      }
      sendStep(sessionId, 0, 'running');
      await processManager.run({
        scriptPath: SCRIPTS.slice,
        args: [rawDir, slicedDir, '-34', '4000', '300', '10', '500', '0.9', '0.25', '0', '1'],
        sessionId,
      });
      assertDirHasFiles(slicedDir, /\.(wav|mp3|ogg|flac)$/i, 'Slice');
    },

    // Step 1: Denoise (or pass sliced audio through unchanged when disabled)
    async () => {
      if (dirHasFiles(denoisedDir, /\.(wav|mp3|ogg|flac)$/i)) {
        return skipStep(sessionId, 1, 'denoised audio already exists');
      }
      if (skipDenoise) {
        sendStep(sessionId, 1, 'running', 'denoise disabled — using sliced audio as-is');
        for (const f of fs.readdirSync(slicedDir)) {
          if (/\.(wav|mp3|ogg|flac)$/i.test(f)) {
            fs.copyFileSync(path.join(slicedDir, f), path.join(denoisedDir, f));
          }
        }
        assertDirHasFiles(denoisedDir, /\.(wav|mp3|ogg|flac)$/i, 'Denoise (skipped)');
        return;
      }
      sendStep(sessionId, 1, 'running');
      await processManager.run({
        scriptPath: SCRIPTS.denoise,
        args: ['-i', slicedDir, '-o', denoisedDir, '-p', 'float16'],
        sessionId,
      });
      assertDirHasFiles(denoisedDir, /\.(wav|mp3|ogg|flac)$/i, 'Denoise');
    },

    // Step 2: ASR
    async () => {
      const existingAsr = dirHasFiles(asrDir, /\.list$/i);
      await ensureClipScores();
      if (!existingAsr) {
        sendStep(sessionId, 2, 'running');
        await processManager.run({
          scriptPath: SCRIPTS.asr,
          args: ['-i', denoisedDir, '-o', asrDir, '-s', asrModel, '-l', asrLanguage, '-p', 'int8'],
          sessionId,
        });
        assertDirHasFiles(asrDir, /\.list$/i, 'ASR');
      }
      writeFilteredTrainingManifest();
      if (existingAsr) return skipStep(sessionId, 2, 'ASR transcript already exists; quality gate refreshed');
    },

    // Step 3: 1-get-text.py
    async () => {
      if (fs.existsSync(path.join(logsDir, '2-name2text.txt'))) {
        return skipStep(sessionId, 3, 'text features already extracted');
      }
      sendStep(sessionId, 3, 'running');
      await processManager.run({
        scriptPath: SCRIPTS.getText,
        args: [],
        env: {
          inp_text: getAsrListFile(),
          inp_wav_dir: denoisedDir,
          exp_name: expName,
          opt_dir: logsDir,
          bert_pretrained_dir: PRETRAINED.bert,
          is_half: 'True',
          _CUDA_VISIBLE_DEVICES: '0',
          i_part: '0',
          all_parts: '1',
          version: 'v2',
        },
        sessionId,
      });
      mergePartFiles(logsDir, '2-name2text', '.txt');
    },

    // Step 4: 2-get-hubert-wav32k.py
    async () => {
      if (dirHasFiles(path.join(logsDir, '4-cnhubert'))) {
        return skipStep(sessionId, 4, 'HuBERT features already extracted');
      }
      sendStep(sessionId, 4, 'running');
      await processManager.run({
        scriptPath: SCRIPTS.getHubert,
        args: [],
        env: {
          inp_text: getAsrListFile(),
          inp_wav_dir: denoisedDir,
          exp_name: expName,
          opt_dir: logsDir,
          cnhubert_base_dir: PRETRAINED.hubert,
          is_half: 'True',
          _CUDA_VISIBLE_DEVICES: '0',
          i_part: '0',
          all_parts: '1',
        },
        sessionId,
      });
    },

    // Step 5: 2-get-sv.py (speaker-verification embeddings — required for v2ProPlus)
    async () => {
      if (dirHasFiles(path.join(logsDir, '7-sv_cn'))) {
        return skipStep(sessionId, 5, 'SV embeddings already extracted');
      }
      sendStep(sessionId, 5, 'running');
      await processManager.run({
        scriptPath: SCRIPTS.getSv,
        args: [],
        env: {
          inp_text: getAsrListFile(),
          inp_wav_dir: denoisedDir,
          exp_name: expName,
          opt_dir: logsDir,
          sv_path: PRETRAINED.sv,
          is_half: 'True',
          _CUDA_VISIBLE_DEVICES: '0',
          i_part: '0',
          all_parts: '1',
        },
        sessionId,
      });
    },

    // Step 6: 3-get-semantic.py
    async () => {
      if (fs.existsSync(path.join(logsDir, '6-name2semantic.tsv'))) {
        return skipStep(sessionId, 6, 'semantic features already extracted');
      }
      sendStep(sessionId, 6, 'running');
      await processManager.run({
        scriptPath: SCRIPTS.getSemantic,
        args: [],
        env: {
          inp_text: getAsrListFile(),
          exp_name: expName,
          opt_dir: logsDir,
          pretrained_s2G: PRETRAINED.sovitsG,
          s2config_path: CONFIG_TEMPLATES.sovits,
          is_half: 'True',
          _CUDA_VISIBLE_DEVICES: '0',
          i_part: '0',
          all_parts: '1',
        },
        sessionId,
      });
      mergePartFiles(logsDir, '6-name2semantic', '.tsv');
    },

    // Step 7: Train SoVITS
    async () => {
      sendStep(sessionId, 7, 'running');
      const configPath = generateSoVITSConfig({
        expName,
        batchSize,
        epochs: sovitsEpochs,
        saveEveryEpoch: sovitsSaveEvery,
        weightsDir: sovitsWeightsDir,
      });
      await processManager.run({
        scriptPath: SCRIPTS.trainSoVITS,
        args: ['--config', configPath],
        sessionId,
      });
    },

    // Step 8: Train GPT
    async () => {
      sendStep(sessionId, 8, 'running');
      const configPath = generateGPTConfig({
        expName,
        batchSize,
        epochs: gptEpochs,
        saveEveryEpoch: gptSaveEvery,
        weightsDir: gptWeightsDir,
      });
      await processManager.run({
        scriptPath: SCRIPTS.trainGPT,
        args: ['--config_file', configPath],
        env: { _CUDA_VISIBLE_DEVICES: '0', hz: '25hz' },
        sessionId,
      });
    },
  ];

  try {
    trainingState.setStatus('running');

    for (let i = 0; i < steps.length; i++) {
      const result = await steps[i]();
      if (result !== 'skipped') {
        completeStep(sessionId, i, 0);
      }
    }

    // ── S3 Sync Up ──
    recordTrainingLog(sessionId, {
      stream: 'stdout',
      data: 'Uploading results to S3...\n',
    });

    const s3DataPrefix = `training/datasets/${expName}/`;
    await uploadDirectory(denoisedDir, `${s3DataPrefix}denoised/`);
    await uploadDirectory(asrDir, `${s3DataPrefix}asr/`);
    if (fs.existsSync(clipScoresPath)) {
      await uploadFile(clipScoresPath, `${s3DataPrefix}clip-scores.json`);
    }
    if (fs.existsSync(qualityReportPath)) {
      await uploadFile(qualityReportPath, `${s3DataPrefix}training-quality-report.json`);
    }
    await uploadDirectory(sovitsWeightsDir, `models/user-models/sovits/`);
    await uploadDirectory(gptWeightsDir, `models/user-models/gpt/`);
    const metadataPath = path.join(localExpDir, 'training-metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(buildTrainingRunMetadata({
      sessionId,
      expName,
      ownerEmail,
      startedAt,
      completedAt: new Date().toISOString(),
      config: {
        batchSize,
        sovitsEpochs,
        gptEpochs,
        sovitsSaveEvery,
        gptSaveEvery,
        asrLanguage,
        asrModel,
        skipDenoise,
      },
      selectedReferences,
      sourceDatasetStats: {
        rawFileCount: downloadCount,
        ...sourceDatasetStats,
      },
    }), null, 2));
    await uploadFile(metadataPath, `training/runs/${expName}/metadata.json`);

    recordTrainingLog(sessionId, {
      stream: 'stdout',
      data: 'S3 upload complete\n',
    });

    try {
      cleanupLocalTrainingArtifacts({ localExpDir, logsDir, sessionId });
    } catch (cleanupErr) {
      recordTrainingLog(sessionId, {
        stream: 'stderr',
        data: `S3 upload succeeded, but local training cleanup failed: ${cleanupErr.message}\n`,
      });
      console.warn('[gpu-worker] Local training cleanup failed:', cleanupErr);
    }

    trainingState.setStatus('complete');
    sseManager.send(sessionId, 'pipeline-complete', { success: true });

    if (email) {
      sendTrainingCompleteEmail(email, expName, { testVoiceUrl }).then(() => {
        recordTrainingLog(sessionId, {
          stream: 'stdout',
          data: `Notification email sent to ${email}\n`,
        });
      }).catch((emailErr) => {
        const errMsg = emailErr.message || String(emailErr);
        console.warn('[gpu-worker] Training complete email failed (non-fatal):', errMsg);
        recordTrainingLog(sessionId, {
          stream: 'stderr',
          data: `Email notification failed: ${errMsg}\n`,
        });
      });
    }
  } catch (err) {
    const errorMsg = parseError(err.message || String(err));
    trainingState.setError(errorMsg);
    sseManager.send(sessionId, 'error', { message: errorMsg, raw: String(err) });
  }
}

function parseError(msg) {
  if (/CUDA out of memory|OutOfMemoryError/i.test(msg)) {
    return 'GPU out of memory. Try reducing batch size.';
  }
  if (/FileNotFoundError/i.test(msg)) {
    return 'Required file not found. Check that audio files were uploaded correctly.';
  }
  if (/exited with code/i.test(msg)) {
    return 'Step failed. Check logs for details.';
  }
  return msg;
}

export { STEPS };
