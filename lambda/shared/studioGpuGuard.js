// Voice Studio GPU lockout, in one place for every route that can load, switch
// or speak a voice (capacity, model select, Live Fast, full inference).
//
// A lecturer's test slot holds the GPU from its warm-up to its end (and across
// a short gap to the next slot). During that window only that lecturer's own
// approved voices may be prepared or spoken; super users and everyone else are
// refused. Outside it, super users may use any trained voice and lecturers none.
// Voice Studio decides (studioVoiceScope); this only applies its answer.
import { isStudioRequest } from './liveAuth.js';
import { buildVoiceProfileId } from './voiceIdentity.js';

export const STUDIO_GPU_RESERVED = "The GPU is reserved for a lecturer's test slot right now. Testing opens again after it.";
export const STUDIO_VOICE_NOT_NOW = 'This voice can be tested only during your test slot.';

async function defaultStudioScope(email, options) {
  return (await import('../studio/index.js')).studioVoiceScope(email, options);
}

/**
 * For an already signed-in caller. Returns null when allowed, else
 * { status, message }. Callers that are not Voice Studio sign-ins pass.
 * voiceProfileId '' (a raw model load) is allowed only when every voice is.
 */
export async function studioGpuRefusal({ identity, voiceProfileId = '', studioScope = defaultStudioScope }) {
  if (!identity?.studio) return null;
  let scope;
  try {
    scope = await studioScope(identity.email, { passwordAccount: identity.passwordAccount === true });
  } catch (error) {
    return { status: 503, message: `Voice Studio is unavailable: ${error.message}` };
  }
  const id = String(voiceProfileId || '').trim();
  // A named voice must be one Voice Studio lists for this person now (super users:
  // voices trained through Voice Studio only); a raw model load needs a free GPU.
  if (id ? scope.voiceNames.some((name) => buildVoiceProfileId(name) === id) : scope.allVoices) return null;
  return { status: 403, message: scope.superuser ? STUDIO_GPU_RESERVED : STUDIO_VOICE_NOT_NOW };
}

/**
 * For routes that do not sign every caller in: a request from the Voice Studio
 * site must sign in, then pass studioGpuRefusal. Other sites are untouched.
 */
export async function studioRequestRefusal(event, {
  authGuard, voiceProfileId = '', studioScope = defaultStudioScope, env = process.env,
} = {}) {
  if (!isStudioRequest(event, env)) return null;
  if (!authGuard) return { status: 503, message: 'Voice Studio sign-in is not configured' };
  let identity;
  try {
    identity = await authGuard.authorize(event);
  } catch {
    return { status: 401, message: 'Sign in to use Voice Studio.' };
  }
  return studioGpuRefusal({ identity, voiceProfileId, studioScope });
}
