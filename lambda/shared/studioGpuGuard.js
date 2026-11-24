// Voice Studio GPU access, in one place for every route that can load, switch
// or speak a voice (capacity, model select, Live Fast, full inference).
//
// One person, one GPU: super users test any trained voice on their shared GPU at
// any time; a lecturer uses only their own approved voices, on a GPU of their
// own (until they send feedback). Nobody takes anyone else's GPU.
// Voice Studio decides (studioVoiceScope); this only applies its answer.
import { isStudioRequest } from './liveAuth.js';
import { buildVoiceProfileId } from './voiceIdentity.js';
import { STUDIO_GPU_OWNER, studioPersonOwner } from './modelCoordinator.js';

export const STUDIO_GPU_RESERVED = 'This voice is not one Voice Studio can test.';
export const STUDIO_VOICE_NOT_NOW = 'This voice cannot be tested now (testing closes once you send your feedback).';

async function defaultStudioScope(email, options) {
  return (await import('../studio/index.js')).studioVoiceScope(email, options);
}

/**
 * For an already signed-in caller: { refusal, ownerKey }. refusal is null when
 * allowed, else { status, message }; ownerKey is the Voice Studio GPU this
 * caller uses (super users: their shared GPU; lecturers: their own), '' for other callers.
 * voiceProfileId '' (a raw model load) is allowed only when every voice is.
 */
export async function studioGpuAccess({ identity, voiceProfileId = '', studioScope = defaultStudioScope }) {
  if (!identity?.studio) return { refusal: null, ownerKey: '' };
  let scope;
  try {
    scope = await studioScope(identity.email, { passwordAccount: identity.passwordAccount === true });
  } catch (error) {
    return { refusal: { status: 503, message: `Voice Studio is unavailable: ${error.message}` }, ownerKey: '' };
  }
  const ownerKey = scope.superuser ? STUDIO_GPU_OWNER : studioPersonOwner(identity.email);
  const id = String(voiceProfileId || '').trim();
  // A named voice must be one Voice Studio lists for this person now (super users:
  // voices trained through Voice Studio only); a raw model load needs a free GPU.
  if (id ? scope.voiceNames.some((name) => buildVoiceProfileId(name) === id) : scope.allVoices) return { refusal: null, ownerKey };
  return { refusal: { status: 403, message: scope.superuser ? STUDIO_GPU_RESERVED : STUDIO_VOICE_NOT_NOW }, ownerKey };
}

/** studioGpuAccess's refusal only (null when allowed). */
export async function studioGpuRefusal(args) {
  return (await studioGpuAccess(args)).refusal;
}

/**
 * For routes that do not sign every caller in: a request from the Voice Studio
 * site must sign in, then pass studioGpuRefusal. Other sites are untouched.
 */
export async function studioRequestAccess(event, {
  authGuard, voiceProfileId = '', studioScope = defaultStudioScope, env = process.env,
} = {}) {
  if (!isStudioRequest(event, env)) return { refusal: null, ownerKey: '' };
  if (!authGuard) return { refusal: { status: 503, message: 'Voice Studio sign-in is not configured' }, ownerKey: '' };
  let identity;
  try {
    identity = await authGuard.authorize(event);
  } catch {
    return { refusal: { status: 401, message: 'Sign in to use Voice Studio.' }, ownerKey: '' };
  }
  return studioGpuAccess({ identity, voiceProfileId, studioScope });
}

/** studioRequestAccess's refusal only (null when allowed). */
export async function studioRequestRefusal(event, options = {}) {
  return (await studioRequestAccess(event, options)).refusal;
}
