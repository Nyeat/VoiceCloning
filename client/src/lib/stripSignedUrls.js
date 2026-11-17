// Reference clips carry a presigned S3 download link (`file.url`, ~1.9 KB each)
// and per-clip scoring detail for the in-page picker. Saved into a voice profile
// or config, six of them made the automatic default-config save ~21 KB — over the
// 8 KB WAF body limit on the training and Live Fast sites — so lecturers saw
// "This text is too long to send" without typing anything.
//
// What is dropped is never read back from a saved config: signed links expire,
// and the server re-scores clips from the training-audio listing. Kept: paths,
// transcripts, languages, scores, eligibility and reasons.
const SIGNED_URL_RE = /^https?:\/\/[^\s]*[?&]X-Amz-(Signature|Credential)=/iu;

export function stripSignedUrls(value) {
  if (Array.isArray(value)) return value.map(stripSignedUrls);
  if (!value || typeof value !== 'object') return value;
  // A reference-candidate descriptor (describeReferenceCandidate) has `eligible`.
  const candidate = Object.prototype.hasOwnProperty.call(value, 'eligible');
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && SIGNED_URL_RE.test(item)) continue;
    if (key === 'qualityMetrics') continue;
    if (candidate && (key === 'breakdown' || key === 'checks')) continue;
    out[key] = stripSignedUrls(item);
  }
  return out;
}
