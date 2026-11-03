import path from 'path';
import { generatePresignedGetUrl, listObjects, getObject } from '../shared/s3.js';
import { loadClipQualityMetrics } from '../shared/clipScores.js';
import { gpuGet, gpuPublicUrl } from '../shared/gpuWorker.js';
import { useGpuWorkerArtifacts } from '../shared/artifacts.js';
import { isSafePathSegment } from '../shared/paths.js';
import { ok, err, preflight } from '../shared/cors.js';

function decodeSegment(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return '';
  }
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return preflight();
  }

  const routePath = event.rawPath || '';
  const query = event.queryStringParameters || {};

  try {
    if (routePath.endsWith('/ref-audio')) {
      const filePath = query.filePath;
      if (!filePath) return err(400, 'filePath is required');
      if (useGpuWorkerArtifacts()) {
        return ok({ url: gpuPublicUrl(`/ref-audio?filePath=${encodeURIComponent(filePath)}`) });
      }
      const url = await generatePresignedGetUrl(filePath);
      return ok({ url });
    } 

    if (routePath.includes('/training-audio/file/')) {
      const suffix = routePath.split('/training-audio/file/')[1] || '';
      const [rawExpName, rawFilename] = suffix.split('/');
      const expName = decodeSegment(rawExpName);
      const filename = decodeSegment(rawFilename);
      if (!isSafePathSegment(expName) || !isSafePathSegment(filename)) {
        return err(400, 'Invalid path');
      }
      if (useGpuWorkerArtifacts()) {
        return ok({
          url: gpuPublicUrl(`/training-audio/file/${encodeURIComponent(expName)}/${encodeURIComponent(filename)}`),
        });
      }
      const url = await generatePresignedGetUrl(`training/datasets/${expName}/denoised/${filename}`);
      return ok({ url });
    }

    if (routePath.includes('/training-audio/')) {
      const expName = decodeSegment(routePath.split('/training-audio/')[1]?.replace(/\/$/u, ''));
      if (!expName || !isSafePathSegment(expName)) {
        return err(400, 'Invalid experiment name');
      }
      if (useGpuWorkerArtifacts()) {
        return ok(await gpuGet(`/training-audio/${encodeURIComponent(expName)}`));
      }

      const denoisedPrefix = `training/datasets/${expName}/denoised/`;
      const objects = await listObjects(denoisedPrefix);
      const wavFiles = objects
        .filter((object) => object.key.endsWith('.wav'))
        .map((object) => path.basename(object.key))
        .sort();

      const transcriptMap = new Map();
      try {
        const asrBuffer = await getObject(`training/datasets/${expName}/asr/denoised.list`);
        for (const line of asrBuffer.toString('utf-8').split('\n').filter(Boolean)) {
          const parts = line.split('|');
          if (parts.length >= 4) {
            const filename = parts[0].replace(/\\/gu, '/').split('/').pop();
            transcriptMap.set(filename, {
              transcript: parts.slice(3).join('|'),
              lang: parts[2],
            });
          }
        }
      } catch {
        // ASR file may not exist yet.
      }

      const clipMetrics = await loadClipQualityMetrics(expName);
      // Presigning is a local signature (no network), so return every clip's
      // playable URL here. Clients used to ask for each URL separately: one
      // Lambda call per clip on every page load (229 for one voice).
      const urls = await Promise.all(wavFiles.map((filename) => (
        generatePresignedGetUrl(`${denoisedPrefix}${filename}`).catch(() => '')
      )));
      const files = wavFiles.map((filename, index) => {
        const info = transcriptMap.get(filename) || {};
        const qualityMetrics = clipMetrics.get(filename);
        return {
          filename,
          key: `${denoisedPrefix}${filename}`,
          path: `${denoisedPrefix}${filename}`,
          transcript: info.transcript || '',
          lang: info.lang || '',
          qualityScore: qualityMetrics?.score,
          qualityMetrics,
          ...(urls[index] ? { url: urls[index] } : {}),
        };
      });
      return ok({ expName, files, urlExpiresInSeconds: 3600 });
    }

    return err(404, 'Not found');
  } catch (error) {
    return err(500, error.message);
  }
};
