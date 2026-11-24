import { uploadBuffer, getObject, headObject, listObjects } from '../shared/s3.js';
import { ok, err, preflight, parseJsonBody } from '../shared/cors.js';
import { isSafePathSegment } from '../shared/paths.js';
import { inferencePost } from '../shared/gpuWorker.js';
import { createLiveAuthGuard, isAuthExemptOrigin } from '../shared/liveAuth.js';
import {
  peekCoordinatedModel, prepareCoordinatedModel, siteOwnerOption,
} from '../shared/modelCoordinator.js';
import { studioGpuAccess } from '../shared/studioGpuGuard.js';
import { createVoiceProfileResolver } from '../shared/voiceProfileRuntime.js';
import { buildVoiceProfileId, isNtuEmail, normalizeEmail, ownsVoiceName } from '../shared/voiceIdentity.js';
import { bestModelsForVoice, listTrainedVoiceNames } from '../shared/trainedVoices.js';
import { listElevenLabsVoices } from '../shared/elevenLabs.js';
import {
  persistSavedProfileReferenceSelection,
  resolveSavedProfileReferenceSelection,
} from '../shared/modelSelection.js';

const ACTIVE_PROFILE_KEY = 'voice-profiles/active.json';
const PROFILE_PREFIX = 'voice-profiles/';
const MY_PROFILES_PATH = /^\/api\/voice-profile\/mine\/?$/u;
const ENSURE_PROFILE_PATH = /^\/api\/voice-profile\/ensure\/?$/u;
const ACTIVE_PROFILE_PATH = /^\/api\/voice-profile\/active\/?$/u;
const ACTIVATE_PROFILE_PATH = /^\/api\/voice-profile\/activate\/?$/u;
const CAPACITY_PROFILE_PATH = /^\/api\/voice-profile\/capacity\/?$/u;
const INTERNAL_PROFILE_PATH = /^\/api\/voice-profile\/internal\/([^/]+)\/?$/u;
const PINNED_PROFILE_PATH = /^\/api\/voice-profile\/pinned\/([^/]+)\/?$/u;
const VOICE_LABEL_PATH = /^\/api\/voice-profile\/label\/?$/u;
const VOICE_LABEL_PREFIX = 'voice-labels/';
const VOICE_LABEL_MAX = 40;

// The name a lecturer gives a trained voice ("Lecture voice, Nov"). Display
// only: the voice's id (cs-name_5) stays the key everywhere.
export function cleanVoiceLabel(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, VOICE_LABEL_MAX)
    .trim();
}

export function voiceLabelKey(voiceName) {
  return `${VOICE_LABEL_PREFIX}${voiceName}.json`;
}

async function readVoiceLabel(readObject, voiceName) {
  try {
    const buffer = await readObject(voiceLabelKey(voiceName));
    if (!buffer) return '';
    return cleanVoiceLabel(JSON.parse(buffer.toString('utf-8'))?.label);
  } catch {
    return '';
  }
}

// Same rule as the supervisor analytics routes: an app role, or an explicit
// object-id allowlist. Deliberately not a second admin mechanism.
function isAdminIdentity(identity, env = process.env) {
  const requiredRole = env.SUPERVISOR_APP_ROLE || 'Supervisor';
  const allowedOids = new Set(
    String(env.SUPERVISOR_OIDS || '').split(',').map((value) => value.trim()).filter(Boolean),
  );
  return Boolean(identity?.roles?.includes(requiredRole) || allowedOids.has(identity?.oid));
}

// Profiles saved before ownerEmail existed carry no owner, so ownership falls
// back to the naming rule — DeanVoice belongs to josephsung@ whether or not the
// record says so.
export function profileBelongsTo(profile, email) {
  const owner = normalizeEmail(profile?.ownerEmail);
  if (owner) return owner === normalizeEmail(email);
  return ownsVoiceName(email, profile?.displayName);
}

function getProfileStorageKey(voiceProfileId) {
  return `voice-profiles/${voiceProfileId}.json`;
}

function hasValue(value) {
  return String(value || '').trim() !== '';
}

function normalizeLanguage(value, fallback = 'en') {
  return String(value || fallback).trim().toLowerCase() || fallback;
}

function normalizePreferredRoute(value) {
  return String(value || '').trim().toLowerCase() === 'full' ? 'full' : 'sentence';
}

function normalizeDefaults(defaults = {}) {
  return {
    ...(defaults.top_k !== undefined ? { top_k: defaults.top_k } : {}),
    ...(defaults.top_p !== undefined ? { top_p: defaults.top_p } : {}),
    ...(defaults.temperature !== undefined ? { temperature: defaults.temperature } : {}),
    ...(defaults.repetition_penalty !== undefined ? { repetition_penalty: defaults.repetition_penalty } : {}),
    ...(defaults.speed_factor !== undefined ? { speed_factor: defaults.speed_factor } : {}),
    ...(defaults.max_chunk_words !== undefined ? { max_chunk_words: defaults.max_chunk_words } : {}),
    ...(defaults.max_sentences_per_chunk !== undefined
      ? { max_sentences_per_chunk: defaults.max_sentences_per_chunk }
      : {}),
  };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeMetadata(metadata = {}) {
  if (!isPlainObject(metadata)) return {};
  const normalized = {
    ...(isPlainObject(metadata.training) ? { training: metadata.training } : {}),
    ...(isPlainObject(metadata.reference) ? { reference: metadata.reference } : {}),
    ...(isPlainObject(metadata.liveFast) ? { liveFast: metadata.liveFast } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : {};
}

// A lecturer owns several voices, so ownership cannot be read back out of a
// name. It is stored on the record instead, falling back to the owner the
// training run recorded so profiles saved from the TTS page inherit it without
// the browser having to pass it.
function resolveOwnerEmail(body) {
  for (const candidate of [body.ownerEmail, body.metadata?.training?.ownerEmail]) {
    const email = normalizeEmail(candidate);
    if (email && isNtuEmail(email)) return email;
  }
  return '';
}

function createVoiceProfileRecord(body, now) {
  const voiceProfileId = String(body.voiceProfileId || '').trim();
  const displayName = String(body.displayName || '').trim();
  const gptKey = String(body.gptKey || '').trim();
  const gptPath = String(body.gptPath || '').trim();
  const sovitsKey = String(body.sovitsKey || '').trim();
  const sovitsPath = String(body.sovitsPath || '').trim();
  const refAudioPath = String(body.ref_audio_path || '').trim();
  const promptText = String(body.prompt_text || '');
  const promptLang = normalizeLanguage(body.prompt_lang, 'en');
  const textLang = normalizeLanguage(body.text_lang, promptLang);
  const preferredRoute = normalizePreferredRoute(body.preferredRoute);
  const ownerEmail = resolveOwnerEmail(body);

  if (!voiceProfileId) {
    throw new Error('voiceProfileId is required');
  }
  if (!isSafePathSegment(voiceProfileId)) {
    throw new Error('voiceProfileId must be a safe path segment');
  }
  if (!displayName) {
    throw new Error('displayName is required');
  }
  if (!hasValue(gptKey) && !hasValue(gptPath)) {
    throw new Error('gptKey or gptPath is required');
  }
  if (!hasValue(sovitsKey) && !hasValue(sovitsPath)) {
    throw new Error('sovitsKey or sovitsPath is required');
  }
  if (!refAudioPath) {
    throw new Error('ref_audio_path is required');
  }

  return {
    voiceProfileId,
    displayName,
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(gptKey ? { gptKey } : {}),
    ...(gptPath ? { gptPath } : {}),
    ...(sovitsKey ? { sovitsKey } : {}),
    ...(sovitsPath ? { sovitsPath } : {}),
    ref_audio_path: refAudioPath,
    prompt_text: promptText,
    prompt_lang: promptLang,
    text_lang: textLang,
    preferredRoute,
    aux_ref_audio_paths: Array.isArray(body.aux_ref_audio_paths)
      ? body.aux_ref_audio_paths.filter((item) => hasValue(item))
      : [],
    defaults: normalizeDefaults({
      ...(isPlainObject(body.metadata?.liveFast?.defaults) ? body.metadata.liveFast.defaults : {}),
      ...(isPlainObject(body.defaults) ? body.defaults : {}),
    }),
    ...(Object.keys(normalizeMetadata(body.metadata)).length > 0
      ? { metadata: normalizeMetadata(body.metadata) }
      : {}),
    updatedAt: now,
  };
}

export function buildVoiceProfileSummary(profile) {
  if (!profile) return null;
  return {
    voiceProfileId: profile.voiceProfileId,
    displayName: profile.displayName,
    ...(profile.ownerEmail ? { ownerEmail: profile.ownerEmail } : {}),
    ...(profile.activatedAt ? { activatedAt: profile.activatedAt } : {}),
  };
}

function buildOwnedVoiceSummary({ voiceName, profile = null, email }) {
  return {
    voiceProfileId: profile?.voiceProfileId || buildVoiceProfileId(voiceName),
    displayName: voiceName,
    // A trained voice with no saved profile is still the lecturer's voice; it
    // just has no reference clip or synthesis settings chosen yet.
    hasSavedProfile: Boolean(profile),
    ...(profile?.ownerEmail ? { ownerEmail: profile.ownerEmail } : {}),
    ...(profile?.updatedAt ? { updatedAt: profile.updatedAt } : {}),
    ...(profile?.activatedAt ? { activatedAt: profile.activatedAt } : {}),
    isMine: profile ? profileBelongsTo(profile, email) : ownsVoiceName(email, voiceName),
  };
}

async function defaultReadObject(key) {
  const existing = await headObject(key);
  if (!existing) return null;
  return getObject(key);
}

async function parseStoredProfile(readObject, key) {
  const buffer = await readObject(key);
  if (!buffer) return null;
  const stored = JSON.parse(buffer.toString('utf-8'));
  const promptLang = normalizeLanguage(stored.prompt_lang, 'en');
  return {
    ...stored,
    ...(stored.prompt_lang !== undefined ? { prompt_lang: promptLang } : {}),
    text_lang: normalizeLanguage(stored.text_lang, promptLang),
    preferredRoute: normalizePreferredRoute(stored.preferredRoute),
    aux_ref_audio_paths: Array.isArray(stored.aux_ref_audio_paths)
      ? stored.aux_ref_audio_paths.filter((item) => hasValue(item))
      : [],
    defaults: normalizeDefaults({
      ...(isPlainObject(stored.metadata?.liveFast?.defaults) ? stored.metadata.liveFast.defaults : {}),
      ...(isPlainObject(stored.defaults) ? stored.defaults : {}),
    }),
    ...(Object.keys(normalizeMetadata(stored.metadata)).length > 0
      ? { metadata: normalizeMetadata(stored.metadata) }
      : {}),
  };
}

/**
 * Creates the saved profile record for a trained voice that has none (synthesis
 * and GPU warm-up resolve a voice by reading it). Used by POST /ensure and by
 * Voice Studio's slot warm-up, which runs before anyone opened the voice.
 * Returns { voiceProfileId, displayName, created } or { error, status }.
 */
export async function ensureVoiceProfileRecord(voiceName, {
  ownerEmail = '',
  readObject = defaultReadObject,
  findBestModels = bestModelsForVoice,
  resolveReferences = resolveSavedProfileReferenceSelection,
  persistProfile = persistSavedProfileReferenceSelection,
} = {}) {
  const voiceProfileId = buildVoiceProfileId(voiceName);
  const existing = await parseStoredProfile(readObject, getProfileStorageKey(voiceProfileId));
  if (existing) return { voiceProfileId, displayName: existing.displayName, created: false };

  const models = await findBestModels(voiceName);
  if (!models) return { status: 404, error: `${voiceName} has no trained models to build a voice from` };

  const draft = {
    voiceProfileId,
    displayName: voiceName,
    ...(ownerEmail ? { ownerEmail: normalizeEmail(ownerEmail) } : {}),
    gptKey: models.gptKey,
    sovitsKey: models.sovitsKey,
    prompt_lang: 'en',
    text_lang: 'en',
    preferredRoute: 'sentence',
    aux_ref_audio_paths: [],
    defaults: {},
  };

  // Reference clips are chosen from the run's own training audio. Without
  // them there is nothing to speak from, so this is a hard failure rather
  // than a half-built record.
  const selection = await resolveReferences(draft);
  if (!selection?.ref_audio_path) {
    return { status: 409, error: `${voiceName} has no usable reference audio yet. Open it in the TTS page and pick a reference clip.` };
  }

  // force: the persister otherwise writes only when the selection differs
  // from what the profile holds, and this new record already carries it —
  // so nothing was ever saved and the voice never got ready (2026-11-21).
  const written = await persistProfile({ ...draft, ...selection }, selection, { force: true });
  if (written === false) return { status: 500, error: `Could not save the voice record for ${voiceName}. Please try again.` };
  return { voiceProfileId, displayName: voiceName, created: true };
}

function getHeaderValue(headers, headerName) {
  const normalizedHeaderName = String(headerName || '').trim().toLowerCase();
  if (!normalizedHeaderName) return '';

  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key || '').trim().toLowerCase() === normalizedHeaderName) {
      return Array.isArray(value) ? String(value[0] || '') : String(value || '');
    }
  }

  return '';
}

export function withoutOwnerIdentity(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const { ownerEmail: _ownerEmail, ...rest } = profile;
  const training = rest.metadata?.training;
  if (training && typeof training === 'object' && 'ownerEmail' in training) {
    const { ownerEmail: _trainingOwner, ...trainingRest } = training;
    return { ...rest, metadata: { ...rest.metadata, training: trainingRest } };
  }
  return rest;
}

function wantsFullActiveProfile(event) {
  const query = event?.queryStringParameters || {};
  const full = String(query.full || query.include || '').trim().toLowerCase();
  return ['1', 'true', 'full'].includes(full);
}

export function createHandler({
  readObject = defaultReadObject,
  listProfileObjects = () => listObjects(PROFILE_PREFIX),
  listVoiceNames = listTrainedVoiceNames,
  findBestModels = bestModelsForVoice,
  resolveReferences = resolveSavedProfileReferenceSelection,
  persistProfile = persistSavedProfileReferenceSelection,
  writeObject = uploadBuffer,
  warmReferenceAudio = async (profile) => inferencePost('/ref-audio/warm', {
    ref_audio_path: profile.ref_audio_path,
    aux_ref_audio_paths: profile.aux_ref_audio_paths || [],
  }),
  listStandardVoices = listElevenLabsVoices,
  now = () => new Date().toISOString(),
  internalAuthHeaderName = process.env.VOICE_PROFILE_INTERNAL_AUTH_HEADER_NAME || '',
  internalAuthHeaderValue = process.env.VOICE_PROFILE_INTERNAL_AUTH_HEADER_VALUE || '',
  authGuard = createLiveAuthGuard(),
  resolveCapacityBody = createVoiceProfileResolver(),
  prepareModelCapacity = prepareCoordinatedModel,
  peekModelCapacity = peekCoordinatedModel,
  studioScope = async (email, options = {}) => (await import('../studio/index.js')).studioVoiceScope(email, options),
} = {}) {
  return async function handler(event) {
    if (event.requestContext?.http?.method === 'OPTIONS') {
      return preflight(event);
    }

    const method = event.requestContext?.http?.method || 'GET';
    const routePath = event.rawPath || '';
    const internalMatch = routePath.match(INTERNAL_PROFILE_PATH);
    const pinnedMatch = routePath.match(PINNED_PROFILE_PATH);

    try {
      if (method === 'GET' && ACTIVE_PROFILE_PATH.test(routePath)) {
        const activeProfile = await parseStoredProfile(readObject, ACTIVE_PROFILE_KEY);
        if (!activeProfile) {
          return err(404, 'No active voice profile has been saved', event);
        }
        // This route is public (staff tools read it unsigned), so it must never
        // reveal who owns the voice. Ownership is served only by the signed-in
        // /mine route.
        const { ownerEmail: _ownerEmail, ...publicSummary } = buildVoiceProfileSummary(activeProfile);
        return ok(
          wantsFullActiveProfile(event) ? withoutOwnerIdentity(activeProfile) : publicSummary,
          {},
          event,
        );
      }

      // A lecturer sees the voices they own; an admin can ask for all of them.
      // Ownership is never taken from the request — only from the signed-in
      // identity — so ?scope=all is inert without the admin role.
      if (method === 'GET' && MY_PROFILES_PATH.test(routePath)) {
        if (!authGuard) return err(503, 'Voice profile authentication is not configured', event);
        let identity;
        try {
          identity = await authGuard.authorize(event);
        } catch {
          return err(401, 'Sign in to see your voices', event);
        }

        const isAdmin = isAdminIdentity(identity);
        const requestedScope = String(event?.queryStringParameters?.scope || '').trim().toLowerCase();
        const wantsAll = requestedScope === 'all';
        // Voice Studio: exactly the voices this person may use right now — a
        // super user's review list, or a lecturer's approved voice during their
        // booked slot. Studio decides; this route only lists.
        let studioVoices = null;
        let studioAll = false;
        let studioLabels = {};
        if (requestedScope === 'studio') {
          try {
            const studio = await studioScope(identity?.email, { passwordAccount: identity?.passwordAccount === true });
            studioVoices = new Set(studio.voiceNames);
            studioAll = studio.allVoices === true;
            studioLabels = studio.labels || {};
          } catch (error) {
            return err(503, `Voice Studio is unavailable: ${error.message}`, event);
          }
        }
        const scope = studioVoices ? 'studio' : wantsAll && isAdmin ? 'all' : 'mine';
        const email = identity?.email;

        // Trained models are the source of truth for which voices exist; saved
        // profiles only add reference audio and settings on top. Reading only
        // the profiles would hide every voice that has been trained but never
        // opened in the TTS page — which is every freshly trained voice.
        const [trainedNames, objects] = await Promise.all([listVoiceNames(), listProfileObjects()]);
        const profileKeys = (objects || [])
          .map((object) => String(object?.key || ''))
          .filter((key) => key.endsWith('.json') && key !== ACTIVE_PROFILE_KEY);
        // Read the saved profiles in parallel (bounded). Reading them one after
        // another made the faculty voice picker wait ~6.5 s on every load.
        const profiles = new Array(profileKeys.length).fill(null);
        let nextIndex = 0;
        await Promise.all(Array.from({ length: Math.min(16, profileKeys.length) }, async () => {
          while (nextIndex < profileKeys.length) {
            const index = nextIndex;
            nextIndex += 1;
            try {
              profiles[index] = await parseStoredProfile(readObject, profileKeys[index]);
            } catch {
              // One unreadable record must not hide every other voice.
            }
          }
        }));
        const profilesByName = new Map();
        for (const profile of profiles) {
          const name = String(profile?.displayName || '').trim();
          if (name) profilesByName.set(name, profile);
        }

        const names = new Set([...trainedNames, ...profilesByName.keys()]);
        const voices = [];
        for (const voiceName of names) {
          const summary = buildOwnedVoiceSummary({
            voiceName,
            profile: profilesByName.get(voiceName) || null,
            email,
          });
          if (studioVoices) {
            if (studioVoices.has(voiceName)) voices.push({ ...summary, isMine: true, ownedByCaller: summary.isMine, ...(studioLabels[voiceName] ? { studioLabel: studioLabels[voiceName] } : {}) });
          } else if (scope === 'all' || summary.isMine) voices.push(summary);
        }

        voices.sort((left, right) => String(left.displayName || '').localeCompare(String(right.displayName || '')));
        await Promise.all(voices.map(async (voice) => {
          const label = await readVoiceLabel(readObject, voice.displayName);
          if (label) voice.label = label;
        }));

        // Stock voices are appended after the sort, not merged into it: they are
        // owned by nobody, so the isMine filter above would drop them from the
        // 'mine' scope — which is the scope every lecturer actually sees. They
        // are offered to everyone alike, in both scopes.
        const standardVoices = studioVoices ? [] : await listStandardVoices();
        return ok({
          email: normalizeEmail(email),
          isAdmin,
          scope,
          voices,
          standardVoices,
        }, {}, event);
      }

      // A lecturer names (or renames) one of their own trained voices. The
      // owner comes from the signed-in identity, never from the request.
      if (method === 'POST' && VOICE_LABEL_PATH.test(routePath)) {
        if (!authGuard) return err(503, 'Voice profile authentication is not configured', event);
        let identity;
        try {
          identity = await authGuard.authorize(event);
        } catch {
          return err(401, 'Sign in to name your voice', event);
        }
        let body;
        try {
          body = parseJsonBody(event);
        } catch {
          return err(400, 'Invalid JSON body', event);
        }
        const voiceName = String(body?.voiceName || '').trim();
        if (!voiceName || !isSafePathSegment(voiceName)) return err(400, 'voiceName is required', event);
        if (!ownsVoiceName(identity?.email, voiceName)) return err(403, 'You can only name your own voices', event);
        const label = cleanVoiceLabel(body?.label);
        await writeObject(
          voiceLabelKey(voiceName),
          Buffer.from(JSON.stringify({ voiceName, label, updatedAt: now() })),
          'application/json',
        );
        return ok({ voiceName, label }, {}, event);
      }

      // Synthesis resolves a voice per request by id, which is the only thing
      // that works when more than one GPU instance sits behind the load
      // balancer. That resolution reads voice-profiles/<id>.json, and training
      // never writes one — so a freshly trained voice needs its record created
      // before it can be spoken. This does exactly that, once, on demand.
      if (method === 'POST' && ENSURE_PROFILE_PATH.test(routePath)) {
        if (!authGuard) return err(503, 'Voice profile authentication is not configured', event);
        let identity;
        try {
          identity = await authGuard.authorize(event);
        } catch {
          return err(401, 'Sign in to set up your voice', event);
        }

        let body;
        try {
          body = parseJsonBody(event);
        } catch {
          return err(400, 'Invalid JSON body', event);
        }

        const voiceName = String(body.voiceName || '').trim();
        if (!voiceName || !isSafePathSegment(voiceName)) {
          return err(400, 'voiceName must be a safe path segment', event);
        }
        // A lecturer may only ever create a record for a voice they own. Voice
        // Studio callers (any Microsoft account) may instead set up a voice the
        // studio currently lets them use; the record keeps the real owner.
        let studioOwner = '';
        // A super user testing another user's voice: allowed, and the record
        // keeps that voice's real owner (or none, so ownership falls back to
        // the voice name) — never the super user.
        let superuserAnyVoice = false;
        if (identity?.studio) {
          try {
            const scope = await studioScope(identity.email, { passwordAccount: identity.passwordAccount === true });
            if (scope.voiceNames.includes(voiceName)) studioOwner = scope.owners?.[voiceName] || normalizeEmail(identity.email);
            else if (scope.allVoices) {
              superuserAnyVoice = true;
              studioOwner = scope.studioOwners?.[voiceName] || '';
            }
          } catch {
            studioOwner = '';
          }
        }
        if (!studioOwner && !superuserAnyVoice && !ownsVoiceName(identity?.email, voiceName)) {
          return err(403, `${normalizeEmail(identity?.email)} does not own a voice called ${voiceName}`, event);
        }

        const ensured = await ensureVoiceProfileRecord(voiceName, {
          ownerEmail: superuserAnyVoice ? studioOwner : (studioOwner || identity?.email),
          readObject, findBestModels, resolveReferences, persistProfile,
        });
        if (ensured.error) return err(ensured.status, ensured.error, event);
        return ok(ensured, {}, event);
      }

      if (method === 'GET' && internalMatch) {
        if (!hasValue(internalAuthHeaderName) || !hasValue(internalAuthHeaderValue)) {
          return err(500, 'Internal voice profile auth is not configured', event);
        }

        const providedSecret = getHeaderValue(event.headers, internalAuthHeaderName);
        if (providedSecret !== internalAuthHeaderValue) {
          return err(403, 'Forbidden', event);
        }

        const voiceProfileId = String(internalMatch[1] || '').trim();
        if (!voiceProfileId || !isSafePathSegment(voiceProfileId)) {
          return err(400, 'voiceProfileId must be a safe path segment', event);
        }

        const storedProfile = await parseStoredProfile(readObject, getProfileStorageKey(voiceProfileId));
        if (!storedProfile) {
          return err(404, `Voice profile ${voiceProfileId} not found`, event);
        }

        return ok(storedProfile, {}, event);
      }

      if (method === 'GET' && pinnedMatch) {
        if (!authGuard) return err(503, 'Pinned voice authentication is not configured', event);
        try {
          await authGuard.authorize(event);
        } catch {
          return err(401, 'Sign in to load the lesson voice', event);
        }
        const voiceProfileId = decodeURIComponent(String(pinnedMatch[1] || '')).trim();
        if (!voiceProfileId || !isSafePathSegment(voiceProfileId)) {
          return err(400, 'voiceProfileId must be a safe path segment', event);
        }
        const storedProfile = await parseStoredProfile(readObject, getProfileStorageKey(voiceProfileId));
        if (!storedProfile) return err(404, `Voice profile ${voiceProfileId} not found`, event);
        return ok(storedProfile, {}, event);
      }

      if (method === 'POST' && CAPACITY_PROFILE_PATH.test(routePath)) {
        // An origin allowed to synthesise unsigned (Live MC) may also ask
        // whether its voice is ready: synthesis would start the same GPU.
        let capacityIdentity = null;
        if (!isAuthExemptOrigin(event)) {
          if (!authGuard) return err(503, 'Voice capacity authentication is not configured', event);
          try {
            capacityIdentity = await authGuard.authorize(event);
          } catch {
            return err(401, 'Sign in to prepare the lesson voice', event);
          }
        }
        let body;
        try {
          body = parseJsonBody(event);
        } catch {
          return err(400, 'Invalid JSON body', event);
        }
        const voiceProfileId = String(body.voiceProfileId || '').trim();
        if (!voiceProfileId || !isSafePathSegment(voiceProfileId)) {
          return err(400, 'voiceProfileId must be a safe path segment', event);
        }
        // Voice Studio: only a voice this person may use right now, on their
        // own GPU (super users: the QC GPU; a lecturer in their slot: the slot GPU).
        let studioOwner = '';
        if (capacityIdentity?.studio && body.peek !== true) {
          const access = await studioGpuAccess({ identity: capacityIdentity, voiceProfileId, studioScope });
          if (access.refusal) return err(access.refusal.status, access.refusal.message, event);
          studioOwner = access.ownerKey;
        }
        const resolvedBody = await resolveCapacityBody({
          voiceProfileId,
          text: 'Lecture voice capacity preflight.',
        });
        // `peek`: every open page on a voice polls whether it is heavily loaded.
        // Read-only, so a polling tab never counts as using (protecting) a GPU.
        if (body.peek === true) {
          return ok(await peekModelCapacity(resolvedBody), {}, event);
        }
        // Opening a lecture prepares its voice. Warming/pending short-circuits
        // and the preflight reassignment grace keep polling lectures from
        // thrashing or purchasing duplicate GPUs.
        // `prewarm`: the training site guessing the person's next voice. Same
        // preparation, but it does not count as using the voice (see coordinator).
        return ok(await prepareModelCapacity(resolvedBody, {
          allowScale: true,
          source: body.source === 'prewarm' ? 'prewarm' : 'lecture-preflight',
          // Every site's GPU has an owner; only that owner switches it.
          ...await siteOwnerOption(event, { authGuard, studioOwner, voiceProfileId }),
        }), {}, event);
      }

      if (method === 'POST' && ACTIVATE_PROFILE_PATH.test(routePath)) {
        let body;
        try {
          body = parseJsonBody(event);
        } catch {
          return err(400, 'Invalid JSON body', event);
        }

        const currentTime = now();
        let record;
        try {
          record = createVoiceProfileRecord(body, currentTime);
        } catch (validationError) {
          return err(400, validationError.message, event);
        }

        const activeRecord = {
          ...record,
          activatedAt: currentTime,
        };

        await writeObject(
          getProfileStorageKey(record.voiceProfileId),
          Buffer.from(JSON.stringify(record), 'utf-8'),
          'application/json',
        );
        // Pages sync a voice's saved settings automatically whenever they load
        // it. Those syncs must not also change the backend-wide default voice:
        // otherwise whoever opened any page last (Faculty included) silently
        // changes the voice every other staff user gets.
        if (body.makeActive === false) {
          try {
            await warmReferenceAudio(record);
          } catch (warmError) {
            console.warn(`[voice-profile] ref-audio warm failed for ${record.voiceProfileId}: ${warmError.message}`);
          }
          return ok({ ...buildVoiceProfileSummary(record), madeActive: false }, {}, event);
        }
        await writeObject(
          ACTIVE_PROFILE_KEY,
          Buffer.from(JSON.stringify(activeRecord), 'utf-8'),
          'application/json',
        );
        try {
          await warmReferenceAudio(activeRecord);
        } catch (warmError) {
          console.warn(`[voice-profile] ref-audio warm failed for ${record.voiceProfileId}: ${warmError.message}`);
        }

        return ok(buildVoiceProfileSummary(activeRecord), {}, event);
      }

      return err(404, 'Not found', event);
    } catch (error) {
      return err(500, error.message, event);
    }
  };
}

export const handler = createHandler();
