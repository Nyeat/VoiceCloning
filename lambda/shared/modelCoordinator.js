import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { inferencePost, inferencePostBinary, workerDeadlineMs } from './gpuWorker.js';

const client = new LambdaClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });

function functionName() {
  return String(process.env.MODEL_COORDINATOR_FUNCTION_NAME || '').trim();
}

// The browser's CloudFront request gives up at 60 s, so the coordinator call
// must end (with a retryable answer) before that rather than outlive it.
export async function invokeCoordinator(payload, { lambdaClient = client, timeoutMs = workerDeadlineMs() } = {}) {
  const name = functionName();
  if (!name) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await lambdaClient.send(new InvokeCommand({
      FunctionName: name,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }), { abortSignal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    const timeout = new Error('The voice GPU is busy and did not answer in time. Your request will retry shortly.');
    timeout.statusCode = 503;
    timeout.code = 'MODEL_QUEUE_TIMEOUT';
    timeout.retryAfterSeconds = 2;
    throw timeout;
  } finally {
    clearTimeout(timer);
  }
  const raw = Buffer.from(response.Payload || []).toString('utf8');
  let result;
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { statusCode: 500, error: raw || 'Invalid coordinator response' }; }
  if (response.FunctionError) {
    const error = new Error(result.errorMessage || result.error || 'Model coordinator failed');
    error.statusCode = 503;
    throw error;
  }
  return result;
}

function throwCoordinatorError(result) {
  const error = new Error(result.error || `Model coordinator request failed (${result.statusCode || 500})`);
  error.statusCode = Number(result.statusCode) || 500;
  error.code = result.code;
  error.retryAfterSeconds = result.retryAfterSeconds;
  error.scaleStarted = result.scaleStarted;
  error.voiceProfileId = result.voiceProfileId;
  throw error;
}

export async function coordinatedInferencePostBinary(routePath, body = {}, headers = {}) {
  if (!functionName()) return inferencePostBinary(routePath, body, headers);
  const result = await invokeCoordinator({ action: 'synthesize', routePath, body, headers });
  if (!result || Number(result.statusCode) >= 400) throwCoordinatorError(result || {});
  return {
    buffer: Buffer.from(result.bodyBase64 || '', 'base64'),
    contentType: result.contentType || 'application/octet-stream',
    queueWaitMs: result.queueWaitMs,
    capacityRetryCount: 0,
    capacityRetrySleepMs: 0,
    workerId: result.workerId,
  };
}

export async function coordinatedInferencePost(routePath, body = {}, headers = {}) {
  if (!functionName()) return inferencePost(routePath, body, headers);
  if (routePath === '/live/cancel') {
    const result = await invokeCoordinator({ action: 'cancel', replyToken: body.replyToken });
    if (!result || Number(result.statusCode) >= 400) throwCoordinatorError(result || {});
    return result;
  }
  const result = await invokeCoordinator({ action: 'synthesize', routePath, body, headers });
  if (!result || Number(result.statusCode) >= 400) throwCoordinatorError(result || {});
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(result.bodyBase64 || '', 'base64').toString('utf8'));
  } catch {
    const error = new Error('Coordinator returned an invalid JSON worker response');
    error.statusCode = 502;
    throw error;
  }
  return {
    ...parsed,
    coordinatorAdmission: {
      workerId: result.workerId || '',
      queueWaitMs: Number(result.queueWaitMs) || 0,
      capacityAction: result.capacityAction?.type || result.capacityAction || 'none',
      simulated: result.capacityAction?.simulated === true,
    },
  };
}

export async function getCoordinatedModelStatus(body = {}) {
  if (!functionName()) return null;
  return invokeCoordinator({ action: 'status', body });
}

export async function prepareCoordinatedModel(body = {}, { allowScale = false, source = 'preflight' } = {}) {
  if (!functionName()) {
    return {
      statusCode: 200,
      state: 'READY',
      canStartConversation: true,
      capacityAction: 'none',
      coordinatorConfigured: false,
    };
  }
  const result = await invokeCoordinator({ action: 'prepare', body, allowScale, source });
  if (!result || Number(result.statusCode) >= 400) throwCoordinatorError(result || {});
  return { ...result, coordinatorConfigured: true };
}
