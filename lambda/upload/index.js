import path from 'path';
import { generatePresignedPutUrl, headObject } from '../shared/s3.js';
import { isSafePathSegment, sanitizeFilename } from '../shared/paths.js';
import { ok, err, preflight, parseJsonBody } from '../shared/cors.js';
import { createLiveAuthGuard } from '../shared/liveAuth.js';
import { ownsVoiceName } from '../shared/voiceIdentity.js';
import { trainingAuthRequired } from '../training/index.js';

let uploadAuthGuard;

// With training sign-in on, audio may only be uploaded into a voice the
// signed-in account owns. Returns an error response, or null when allowed.
async function rejectUnlessOwner(event, expName) {
  if (!trainingAuthRequired()) return null;
  if (uploadAuthGuard === undefined) uploadAuthGuard = createLiveAuthGuard();
  if (!uploadAuthGuard) return err(503, 'Training sign-in is not configured');
  let identity;
  try {
    identity = await uploadAuthGuard.authorize(event);
  } catch {
    return err(401, 'Sign in with your NTU account to upload training audio');
  }
  if (identity?.synthetic || !ownsVoiceName(identity?.email, expName)) {
    return err(403, 'You can only upload audio for your own voice');
  }
  return null;
}

const ALLOWED_AUDIO_EXTS = ['.wav', '.mp3', '.ogg', '.flac', '.m4a'];
const ALLOWED_REF_AUDIO_EXTS = ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.webm', '.mp4'];

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return preflight();
  }

  const routePath = event.rawPath || '';
  let body;
  try {
    body = parseJsonBody(event);
  } catch {
    return err(400, 'Invalid JSON body');
  }

  try {
    if (routePath.endsWith('/upload/presign')) {
      const { expName, files } = body;
      if (!expName) return err(400, 'expName is required');
      if (!isSafePathSegment(expName)) return err(400, 'expName contains unsupported characters');
      if (!Array.isArray(files) || files.length === 0) return err(400, 'files array is required');
      if (files.length > 50) return err(400, 'Maximum 50 files per upload');
      const denied = await rejectUnlessOwner(event, expName);
      if (denied) return denied;

      const uploads = [];
      for (const file of files) {
        const ext = path.extname(file.name || '').toLowerCase();
        if (!ALLOWED_AUDIO_EXTS.includes(ext)) {
          return err(400, `File "${file.name}" has unsupported extension "${ext}"`);
        }
        const safeName = sanitizeFilename(file.name, 'training-audio');
        const key = `training/datasets/${expName}/raw/${safeName}`;
        const { url } = await generatePresignedPutUrl(key, file.type || 'audio/wav');
        uploads.push({ filename: safeName, url, key });
      }
      return ok({ uploads });
    }

    if (routePath.endsWith('/upload/confirm')) {
      const { expName, keys } = body;
      if (!expName || !Array.isArray(keys) || keys.length === 0) {
        return err(400, 'expName and keys array are required');
      }
      const denied = await rejectUnlessOwner(event, expName);
      if (denied) return denied;
      const ownPrefix = `training/datasets/${expName}/raw/`;
      if (keys.some((key) => !String(key || '').startsWith(ownPrefix))) {
        return err(400, 'keys must belong to this voice');
      }

      let confirmed = 0;
      const confirmedFiles = [];
      for (const key of keys) {
        const head = await headObject(key);
        if (head) {
          confirmed += 1;
          confirmedFiles.push(path.basename(key));
        }
      }
      return ok({ confirmed, files: confirmedFiles });
    }

    if (routePath.endsWith('/upload-ref/presign')) {
      const { filename, type } = body;
      if (!filename) return err(400, 'filename is required');
      const ext = path.extname(filename || '').toLowerCase();
      if (!ALLOWED_REF_AUDIO_EXTS.includes(ext)) {
        return err(400, `File "${filename}" has unsupported extension "${ext}"`);
      }

      const safeName = sanitizeFilename(filename, 'reference-audio');
      const key = `audio/reference/ref_${Date.now()}_${safeName}`;
      const { url } = await generatePresignedPutUrl(key, type || 'audio/wav');
      return ok({ url, key });
    }

    if (routePath.endsWith('/upload-ref/confirm')) {
      const { key } = body;
      if (!key) return err(400, 'key is required');
      const head = await headObject(key);
      if (!head) return err(404, 'File not found in S3');
      return ok({ key, filename: path.basename(key) });
    }

    return err(404, 'Not found');
  } catch (error) {
    return err(500, error.message);
  }
};
