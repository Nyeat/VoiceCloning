import fs from 'fs';
import { fileURLToPath } from 'url';

const CONFIG_FILE = fileURLToPath(new URL('../.env', import.meta.url));

function loadOptionalEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadOptionalEnvFile(CONFIG_FILE);

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
export const OPENAI_REALTIME_SYSTEM_PROMPT = process.env.OPENAI_REALTIME_SYSTEM_PROMPT
  || 'You are a casual, helpful assistant. Keep replies concise and conversational.';
export const OPENAI_REALTIME_VAD = process.env.OPENAI_REALTIME_VAD || 'semantic_vad';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.0-flash';
export const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
// The `cors` package compares a string origin with `===`, so handing it the raw
// comma-joined value silently rejects every browser request once more than one
// origin is configured. Nothing caught this before the sign-in route: the
// WebSocket is not subject to CORS, and it does its own allowlist parsing in
// originAllowed(). Splitting here keeps the two readings of the same variable
// from disagreeing.
export function parseCorsOrigins(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '*') {
    return '*';
  }

  const origins = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return origins.length > 0 ? origins : '*';
}

export const CORS_ORIGINS = parseCorsOrigins(CORS_ORIGIN);
export const PORT = Number.parseInt(process.env.PORT || '3002', 10);

// Live-chat authentication. Defaults to off so existing deployments keep working
// until the Entra app registration is in place and the client sends a token.
export const LIVE_AUTH_ENABLED = (process.env.LIVE_AUTH_ENABLED || 'false') === 'true';
export const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID || '';
// The API's app ID URI (api://<clientId>), not the bare client ID.
export const ENTRA_AUDIENCE = process.env.ENTRA_AUDIENCE || '';
export const ENTRA_ALLOWED_EMAIL_DOMAINS = (process.env.ENTRA_ALLOWED_EMAIL_DOMAINS || '')
  .split(',')
  .map((domain) => domain.trim())
  .filter(Boolean);
export const FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS = (
  process.env.FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS || ''
)
  .split(',')
  .map((domain) => domain.trim())
  .filter(Boolean);

// Voice Studio: chats opened from these page origins accept any Microsoft
// account (work, school or personal). Addresses in STUDIO_HOME_DOMAINS are
// still accepted only from the home tenant. Every other origin is unchanged.
const splitList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
export const STUDIO_SITE_ORIGINS = splitList(process.env.STUDIO_SITE_ORIGINS).map((origin) => origin.replace(/\/+$/u, ''));
export const STUDIO_ALLOWED_EMAIL_DOMAINS = splitList(process.env.STUDIO_ALLOWED_EMAIL_DOMAINS);
export const STUDIO_HOME_DOMAINS = splitList(process.env.STUDIO_HOME_DOMAINS || 'ntu.edu.sg');
// Separate credential for the load tests, which have no interactive sign-in.
// Empty disables the bypass; it is never implied by LIVE_AUTH_ENABLED.
export const LIVE_AUTH_LOADTEST_SECRET = process.env.LIVE_AUTH_LOADTEST_SECRET || '';

// Origins that may open a live chat without signing in, while every other
// origin still must. One gateway process serves several distributions, and
// LIVE_AUTH_ENABLED is process-wide, so this is the only way to keep the
// SSO-backed app locked while an open kiosk build works.
//
// This is a soft gate. Origin is a browser-supplied header: it keeps a browser
// on a protected distribution from skipping sign-in, but any scripted client can
// set it freely. Treat an exempt origin as "this gateway is publicly reachable"
// and size the OpenAI/GPU spend accordingly.
export const LIVE_AUTH_EXEMPT_ORIGINS = (process.env.LIVE_AUTH_EXEMPT_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/u, ''))
  .filter(Boolean);

/** True when `origin` may skip the session.auth handshake. */
export function isAuthExemptOrigin(origin, exempt = LIVE_AUTH_EXEMPT_ORIGINS) {
  if (exempt.length === 0) return false;
  const normalized = String(origin || '').trim().replace(/\/+$/u, '');
  if (!normalized) return false; // No Origin at all is never exempt.
  return exempt.includes(normalized);
}

// Transcript storage. Empty table name disables it entirely — the gateway runs
// exactly as before, which is what every local dev run needs.
export const TRANSCRIPT_TABLE_NAME = process.env.TRANSCRIPT_TABLE_NAME || '';
export const LECTURER_TABLE_NAME = process.env.LECTURER_TABLE_NAME || '';
export const TRANSCRIPT_TABLE_REGION = process.env.TRANSCRIPT_TABLE_REGION || 'ap-northeast-2';
// Identifiable rows expire after 90 days; long-term research use is served by a
// de-identified export instead (scripts/export-transcripts-deidentified.mjs),
// which is not personal data and needs no expiry. Defaults to 90 rather than 0
// so that forgetting to configure it cannot silently mean indefinite retention
// of health-adjacent free text about named students. Set 0 to disable expiry.
export const TRANSCRIPT_TTL_DAYS = Number.parseInt(process.env.TRANSCRIPT_TTL_DAYS || '90', 10);
// Load-test sessions are dropped by default so rehearsals do not bury real
// transcripts under thousands of synthetic turns.
export const TRANSCRIPT_STORE_SYNTHETIC = process.env.TRANSCRIPT_STORE_SYNTHETIC === 'true';
// What the student asked is the research interest; the model's replies are
// reproducible from the prompt and the lesson. Off by default, but a flag rather
// than deleted code: a turn not written cannot be recovered later, and follow-up
// questions ("what about the other one?") lose their referent without the reply
// they answered. Set true before a session if that context is needed.
export const TRANSCRIPT_STORE_ASSISTANT = process.env.TRANSCRIPT_STORE_ASSISTANT === 'true';

/**
 * Configuration problems that should keep the gateway out of a load balancer.
 * Reports every problem rather than the first, so one restart surfaces the whole
 * list instead of one per deploy attempt.
 *
 * @returns {string[]} empty when the service is ready
 */
export function readinessProblems(env = process.env) {
  const problems = [];

  if (!(env.OPENAI_API_KEY || '')) {
    problems.push('OPENAI_API_KEY is not set; live chat cannot connect to OpenAI.');
  }

  if ((env.LIVE_AUTH_ENABLED || 'false') === 'true') {
    if (!(env.ENTRA_TENANT_ID || '')) {
      problems.push('LIVE_AUTH_ENABLED is on but ENTRA_TENANT_ID is not set.');
    }
    if (!(env.ENTRA_AUDIENCE || '')) {
      problems.push('LIVE_AUTH_ENABLED is on but ENTRA_AUDIENCE is not set.');
    }
    if (!(env.ENTRA_ALLOWED_EMAIL_DOMAINS || '')) {
      // Not fatal to the code path — an empty allowlist admits any account in the
      // tenant — but on this deployment it always means a missing config value.
      problems.push('LIVE_AUTH_ENABLED is on but ENTRA_ALLOWED_EMAIL_DOMAINS is empty.');
    }
  }

  // Transcripts are only written for authenticated sessions, so a table with no
  // authentication in front of it would silently never be used.
  if ((env.TRANSCRIPT_TABLE_NAME || '') && (env.LIVE_AUTH_ENABLED || 'false') !== 'true') {
    problems.push(
      'TRANSCRIPT_TABLE_NAME is set but LIVE_AUTH_ENABLED is off; no transcript would be stored.',
    );
  }

  if ((env.LECTURER_TABLE_NAME || '') && !(env.FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS || '')) {
    problems.push(
      'LECTURER_TABLE_NAME is set but FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS is empty.',
    );
  }

  return problems;
}
