// The training and Live Fast/TTS CloudFront sites sit behind an AWS WAF whose
// managed CommonRuleSet blocks any request body over 8 KB with a bare 403 page.
// That rule cannot be changed from this project, so the client refuses an
// oversized body up front and tells the user what to do instead.
export const WAF_BODY_LIMIT_BYTES = 8 * 1024;
const WAF_PROTECTED_MODES = new Set(['combined', 'training', 'live-fast']);

export const OVERSIZED_REQUEST_MESSAGE = 'This text is too long to send in one go. Please shorten it or split it into smaller parts (about 1,500 words at most).';

export function oversizedRequestError(bodyText, mode) {
  if (!WAF_PROTECTED_MODES.has(mode)) return null;
  const bytes = new TextEncoder().encode(String(bodyText || '')).length;
  if (bytes <= WAF_BODY_LIMIT_BYTES) return null;
  const error = new Error(OVERSIZED_REQUEST_MESSAGE);
  error.code = 'REQUEST_TOO_LARGE';
  error.status = 413;
  error.response = { status: 413, data: { error: OVERSIZED_REQUEST_MESSAGE, code: 'REQUEST_TOO_LARGE' } };
  return error;
}

// A WAF block reaches the browser as CloudFront's HTML 403, not our JSON.
export function isWafBlockResponse(status, contentType = '') {
  return Number(status) === 403 && !/json/iu.test(String(contentType));
}
