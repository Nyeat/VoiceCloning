import { corsHeaders, err, ok, preflight, parseJsonBody } from '../shared/cors.js';
import { capacityErrorResponse, coordinatedInferencePost, coordinatedInferencePostBinary } from '../shared/modelCoordinator.js';
import { createVoiceProfileResolver, VoiceProfileResolutionError } from '../shared/voiceProfileRuntime.js';
import { isElevenLabsRequest, synthesizeElevenLabsSpeech } from '../shared/elevenLabs.js';
import { demoHeaders, isDemoEvent } from '../shared/demoOrigin.js';
import { createLiveAuthGuard, isAuthExemptOrigin } from '../shared/liveAuth.js';
import { randomUUID } from 'node:crypto';

const REPLY_TOKEN_HEADER = 'X-VCS-Reply-Token';

export function liveAuthRequired(event, env = process.env) {
  if ((env.LIVE_AUTH_DEMO_ONLY || 'false') !== 'true') return true;
  return isDemoEvent(event, { demoHost: env.DEMO_CLOUDFRONT_HOST || '' });
}

// Header names arrive lower-cased on Function URL events, but casing is not
// guaranteed across invoke paths — match case-insensitively.
export function readReplyToken(event) {
  const headers = event?.headers || {};
  const key = Object.keys(headers)
    .find((name) => name.toLowerCase() === REPLY_TOKEN_HEADER.toLowerCase());
  return key ? String(headers[key] || '').trim() : '';
}

function isCancelPath(event) {
  const path = event?.rawPath || event?.requestContext?.http?.path || '';
  return /\/api\/live\/cancel\/?$/u.test(path);
}

export function createHandler({
  resolveSynthesisBody = createVoiceProfileResolver(),
  postBinary = coordinatedInferencePostBinary,
  post = coordinatedInferencePost,
  synthesizeStandardVoice = synthesizeElevenLabsSpeech,
  isStandardVoiceRequest = isElevenLabsRequest,
  now = () => performance.now(),
  invocationState = { cold: true, environmentId: randomUUID() },
  authGuard = createLiveAuthGuard(),
  authRequired = liveAuthRequired,
  authExempt = isAuthExemptOrigin,
} = {}) {
  return async function handler(event, context = {}) {
    const coldStart = invocationState.cold;
    invocationState.cold = false;
    const requestStartedAt = now();
    if (event.requestContext?.http?.method === 'OPTIONS') {
      return preflight(event);
    }

    // Before any work: synthesis costs GPU time, so an unauthenticated caller
    // must not get past this point. Cancel is checked too — it takes a
    // replyToken belonging to someone else's in-flight reply.
    if (authGuard && authRequired(event) && !authExempt(event)) {
      try {
        await authGuard.authorize(event);
      } catch (error) {
        return err(401, 'Sign in to use the voice assistant.', event);
      }
    }

    let body;
    try {
      body = parseJsonBody(event);
    } catch {
      return err(400, 'Invalid JSON body');
    }

    // Barge-in cancel. Deliberately does no voice-profile resolution: it must be
    // as cheap as possible, since it races the clip request it is cancelling.
    if (isCancelPath(event)) {
      const replyToken = String(body.replyToken || '').trim();
      if (!replyToken) {
        return err(400, 'replyToken is required', event);
      }
      try {
        return ok(await post('/live/cancel', { replyToken }), {}, event);
      } catch (error) {
        // A cancel that fails costs one wasted clip, never a broken conversation.
        return ok({ freed: 0, error: error.message }, {}, event);
      }
    }

    if (!body.text?.trim()) {
      return err(400, 'text is required');
    }

    // A stock voice never touches the GPU, so it skips voice-profile resolution
    // (there is no saved record to read), the model-selection snapshot, and the
    // synthesis queue entirely. That is also why it still works while the GPU is
    // cold or scaling.
    if (isStandardVoiceRequest(body)) {
      try {
        const { buffer, contentType, characterCount } = await synthesizeStandardVoice(body);
        const elapsedMs = Math.max(0, now() - requestStartedAt);
        const timingHeaders = {
          'X-VCS-Voice-Provider': 'elevenlabs',
          'X-VCS-Lambda-Total-Ms': elapsedMs.toFixed(1),
          'X-VCS-Lambda-Cold-Start': coldStart ? '1' : '0',
          'X-VCS-Lambda-Environment-Id': invocationState.environmentId,
          // Billing is per character, so the one number worth surfacing.
          ...(characterCount != null ? { 'X-VCS-Voice-Characters': String(characterCount) } : {}),
          ...(context.awsRequestId
            ? { 'X-VCS-Lambda-Request-Id': String(context.awsRequestId) }
            : {}),
        };
        return {
          statusCode: 200,
          isBase64Encoded: true,
          headers: {
            'Content-Type': contentType || 'audio/mpeg',
            'Content-Length': String(buffer.length),
            'Access-Control-Expose-Headers': Object.keys(timingHeaders).join(', '),
            ...timingHeaders,
            ...corsHeaders,
          },
          body: buffer.toString('base64'),
        };
      } catch (error) {
        if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
          return err(error.statusCode, error.message, event);
        }
        return err(500, error.message, event);
      }
    }

    const replyToken = readReplyToken(event);
    try {
      const resolvedBody = await resolveSynthesisBody(body);
      const profileResolvedAt = now();
      if (!resolvedBody.ref_audio_path) {
        return err(400, 'ref_audio_path is required');
      }

      const {
        buffer,
        contentType,
        queueWaitMs,
        capacityRetryCount = 0,
        capacityRetrySleepMs = 0,
      } = await postBinary('/inference/tts', {
        ...resolvedBody,
        text: `${resolvedBody.text.trim()} `,
        text_split_method: 'cut0',
        batch_size: 1,
        streaming_mode: false,
        split_bucket: true,
        parallel_infer: false,
        fragment_interval: 0.1,
      }, {
        ...demoHeaders(event),
        // Lets barge-in free this clip if it is still queued on the worker.
        ...(replyToken ? { [REPLY_TOKEN_HEADER]: replyToken } : {}),
      });
      const workerCompletedAt = now();
      const profileResolveMs = Math.max(0, profileResolvedAt - requestStartedAt);
      const workerRoundTripMs = Math.max(0, workerCompletedAt - profileResolvedAt);
      const lambdaTotalMs = Math.max(0, workerCompletedAt - requestStartedAt);
      const timingHeaders = {
        'X-VCS-Profile-Resolve-Ms': profileResolveMs.toFixed(1),
        'X-VCS-Worker-Round-Trip-Ms': workerRoundTripMs.toFixed(1),
        'X-VCS-Lambda-Total-Ms': lambdaTotalMs.toFixed(1),
        'X-VCS-Lambda-Cold-Start': coldStart ? '1' : '0',
        'X-VCS-Lambda-Environment-Id': invocationState.environmentId,
        'X-VCS-Capacity-Retry-Count': String(capacityRetryCount),
        'X-VCS-Capacity-Retry-Sleep-Ms': String(capacityRetrySleepMs),
        ...(context.awsRequestId
          ? { 'X-VCS-Lambda-Request-Id': String(context.awsRequestId) }
          : {}),
        ...(queueWaitMs != null && queueWaitMs !== ''
          ? { 'X-VCS-GPU-Queue-Wait-Ms': String(queueWaitMs) }
          : {}),
      };

      return {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          'Content-Type': contentType || 'audio/wav',
          'Content-Length': String(buffer.length),
          'Access-Control-Expose-Headers': Object.keys(timingHeaders).join(', '),
          ...timingHeaders,
          ...corsHeaders,
        },
        body: buffer.toString('base64'),
      };
    } catch (error) {
      if (error instanceof VoiceProfileResolutionError) {
        return err(error.statusCode, error.message);
      }
      const capacity = capacityErrorResponse(error, corsHeaders);
      if (capacity) return capacity;
      if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
        return err(error.statusCode, error.message);
      }
      return err(500, error.message);
    }
  };
}

export const handler = createHandler();
