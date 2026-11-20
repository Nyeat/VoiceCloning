// Voice Studio state lives in one S3 JSON document. Every change is a
// read-modify-write guarded by the object's ETag (S3 conditional writes), so two
// Lambdas booking the same hour or dispatching the same job cannot both win:
// the loser re-reads and re-applies its change against the new state.
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { normalizeState } from './workflow.js';

export const STATE_KEY = 'studio/state.json';
const MAX_ATTEMPTS = 6;

function fullKey(key, env = process.env) {
  const prefix = env.S3_PREFIX ? `${String(env.S3_PREFIX).replace(/\/+$/u, '')}/` : '';
  return prefix + key;
}

let client = null;
function s3() {
  if (!client) client = new S3Client({ region: process.env.S3_REGION || 'us-east-1' });
  return client;
}

async function bodyToString(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

export function createS3StateStore({ env = process.env, send = (command) => s3().send(command) } = {}) {
  const Bucket = env.S3_BUCKET;
  const Key = fullKey(STATE_KEY, env);
  return {
    async read() {
      if (!Bucket) throw new Error('S3_BUCKET env var is not set');
      try {
        const response = await send(new GetObjectCommand({ Bucket, Key }));
        return { state: normalizeState(JSON.parse(await bodyToString(response.Body))), etag: response.ETag || null };
      } catch (error) {
        if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
          return { state: normalizeState(null), etag: null };
        }
        throw error;
      }
    },
    async write(state, etag) {
      await send(new PutObjectCommand({
        Bucket,
        Key,
        Body: JSON.stringify(state),
        ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
      }));
    },
  };
}

export function isWriteConflict(error) {
  const status = error?.$metadata?.httpStatusCode;
  return status === 412 || status === 409 || error?.name === 'PreconditionFailed' || error?.name === 'ConditionalRequestConflict';
}

/**
 * Applies `mutate(state)` atomically. `mutate` may return a value (passed back
 * to the caller) and may throw to abort without writing. Side effects such as
 * email must happen AFTER this resolves, using the returned value, because
 * `mutate` can run more than once.
 */
export async function updateState(store, mutate) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { state, etag } = await store.read();
    const result = await mutate(state);
    if (result?.skipWrite) return { state, result };
    try {
      await store.write(state, etag);
      return { state, result };
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
      lastError = error;
      await new Promise((resolve) => { setTimeout(resolve, 40 + Math.random() * 120); });
    }
  }
  throw lastError || new Error('Could not save Voice Studio state');
}

/** In-memory store with the same conflict semantics, for tests. */
export function createMemoryStore(initial = null) {
  let current = initial ? JSON.stringify(initial) : null;
  let version = initial ? 1 : 0;
  return {
    async read() {
      return { state: normalizeState(current ? JSON.parse(current) : null), etag: current ? String(version) : null };
    },
    async write(state, etag) {
      const expected = current ? String(version) : null;
      if (etag !== expected) {
        const error = new Error('conflict');
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      current = JSON.stringify(state);
      version += 1;
    },
    snapshot() {
      return current ? JSON.parse(current) : null;
    },
  };
}
