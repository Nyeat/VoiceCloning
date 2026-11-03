export const ANALYTICS_SCHEMA_VERSION = 1;
export const ANALYTICS_FLUSH_INTERVAL_MS = 10000;
export const ANALYTICS_BATCH_SIZE = 20;
export const BEHAVIOR_WINDOW_MS = 120000;
export const LONG_PAUSE_SECONDS = 15;
export const REPEATED_QUESTION_MIN_SECONDS = 8;
export const REPEATED_QUESTION_MAX_SECONDS = 10 * 60;
export const REPEATED_QUESTION_SIMILARITY = 0.65;
export const SEEK_GESTURE_SETTLE_MS = 1500;

const QUESTION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'do', 'does', 'for', 'how', 'i', 'in',
  'is', 'it', 'me', 'of', 'on', 'please', 'tell', 'that', 'the', 'this', 'to',
  'what', 'when', 'why', 'with', 'would', 'you',
]);

// Terms a learner would plausibly type, per concept. A term may legitimately
// appear under several concepts ("transfusion" is discussed in both management
// and investigations); the scorer down-weights those rather than forcing an
// arbitrary single owner, so listing an ambiguous term twice is the correct fix
// rather than a compromise.
//
// `introduction-overview` is deliberately sparse. It is the concept with no
// vocabulary of its own — everything the introduction mentions belongs to a
// later section — so giving it broad terms like "gi bleeding" would make it the
// default sink for every unclassifiable question.
const QUESTION_CONCEPT_TERMS = Object.freeze({
  'introduction-overview': ['learning objective', 'lesson outline', 'introduction'],
  'presentation-epidemiology': [
    'epidemiology', 'incidence', 'prevalence', 'mortality', 'how common',
    'demographic', 'age group', 'statistic', 'presentation',
  ],
  'initial-assessment-stabilization': [
    'initial assessment', 'stabilization', 'stabilisation', 'resuscitation',
    'hemodynamic', 'haemodynamic', 'airway', 'iv access', 'intravenous access',
    'fluid resuscitation', 'vital sign', 'blood pressure', 'tachycardia',
    'shock', 'cannula', 'crystalloid', 'fluid',
  ],
  'investigations-risk-stratification': [
    'risk stratification', 'glasgow blatchford', 'blatchford', 'rockall',
    'investigation', 'blood test', 'full blood count', 'urea', 'hemoglobin',
    'haemoglobin', 'coagulation', 'inr', 'crossmatch', 'score', 'scoring',
    'risk score', 'transfusion',
  ],
  'upper-gi-causes-presentation': [
    'upper gi cause', 'upper gastrointestinal cause', 'peptic ulcer', 'ulcer',
    'varices', 'variceal', 'hematemesis', 'haematemesis', 'melena', 'melaena',
    'mallory weiss', 'gastritis', 'esophagitis', 'oesophagitis',
    'coffee ground', 'erosion', 'malignancy', 'presentation',
  ],
  'upper-gi-management': [
    'proton pump inhibitor', 'ppi', 'omeprazole', 'octreotide', 'terlipressin',
    'transfusion threshold', 'transfusion', 'antibiotic prophylaxis',
    'vasoactive', 'somatostatin', 'restrictive transfusion', 'tranexamic',
  ],
  endoscopy: [
    'endoscopy', 'endoscopic', 'gastroscopy', 'ogd', 'hemostasis', 'haemostasis',
    'endoscopic clip', 'thermal therapy', 'band ligation', 'banding',
    'adrenaline injection', 'sclerotherapy', 'second look', 'forrest',
  ],
  'lower-gi-bleeding': [
    'lower gi', 'lower gastrointestinal', 'hematochezia', 'haematochezia',
    'diverticular', 'diverticulosis', 'colonoscopy', 'angiodysplasia',
    'hemorrhoid', 'haemorrhoid', 'colitis', 'ct angiography', 'rectal bleeding',
    'per rectum',
  ],
  'key-messages': [
    'key message', 'takeaway', 'take away', 'remember from this lesson',
    'main point', 'conclusion', 'summarise the lesson', 'summarize the lesson',
  ],
});

// A term matched in exactly one concept is strong evidence; one spread across
// several is weak. This is plain IDF over the term table, which is what lets an
// ambiguous term be listed under every concept it genuinely belongs to.
const CONCEPT_COUNT = Object.keys(QUESTION_CONCEPT_TERMS).length;
const TERM_INDEX = (() => {
  const documentFrequency = new Map();
  const byConcept = new Map();
  for (const [conceptId, terms] of Object.entries(QUESTION_CONCEPT_TERMS)) {
    const stemmed = terms.map((term) => stemSequence(term)).filter((words) => words.length > 0);
    byConcept.set(conceptId, stemmed);
    for (const words of stemmed) {
      const key = words.join(' ');
      documentFrequency.set(key, (documentFrequency.get(key) || 0) + 1);
    }
  }
  return { documentFrequency, byConcept };
})();

function termWeight(words) {
  const frequency = TERM_INDEX.documentFrequency.get(words.join(' ')) || 1;
  const idf = Math.log(1 + CONCEPT_COUNT / frequency);
  // A multi-word phrase pins the meaning far harder than a bare word does
  // ("risk stratification" vs "risk"), so length earns a bonus.
  return idf * (1 + 0.5 * (words.length - 1));
}

// A single specific term ("varices", idf 2.3) has to clear this on its own,
// while one broad term shared by four concepts must not.
const MIN_CONCEPT_SCORE = 2;
const QUESTION_CONFIDENCE = 0.75;

function containsPhrase(haystack, words) {
  if (words.length === 0 || words.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - words.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < words.length; offset += 1) {
      if (haystack[start + offset] !== words[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

const ANALYTICS_ENDPOINT = '/api/analytics/events';
const CLARIFICATION_FOLLOW_UP = /\b(?:again|simpler|simplify|still (?:don'?t|do not) understand|rephrase|another way|more simply|what do you mean)\b/iu;

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function finiteSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1000) / 1000 : null;
}

// Plural is stripped before the verb endings, which is what makes the result
// idempotent: stemming "messages" and "message" has to land on the same token or
// a phrase silently stops matching its own vocabulary. Handling `es` as one
// suffix did not — it took "messages" to "messag" while "message" stayed whole.
// `ss` is excluded so "happiness" is not mistaken for a plural.
function stemToken(token) {
  // Short enough that stripping anything destroys the word, and it is also the
  // length of the abbreviations the lesson uses (ppi, ogd, inr) — but "ppis"
  // has to reach "ppi", so the guard sits at 3 rather than 4.
  if (token.length <= 3) return token;
  const singular = token.endsWith('ies')
    ? `${token.slice(0, -3)}y` // endoscopies -> endoscopy
    : (token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token);
  return singular.length > 5 ? singular.replace(/(?:ing|ed)$/u, '') : singular;
}

// Ordered and un-deduplicated, unlike questionTokens: phrase matching needs the
// original word order, and both sides of a comparison must be stemmed by the
// same function or "endoscopy" and "endoscopies" stop matching.
export function stemSequence(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .map(stemToken);
}

export function questionTokens(value) {
  return [...new Set(stemSequence(value)
    .filter((token) => token.length >= 2 && !QUESTION_STOP_WORDS.has(token)))];
}

export function questionSimilarity(left, right) {
  const a = questionTokens(left);
  const b = questionTokens(right);
  if (a.length < 2 || b.length < 2) return 0;
  const rightTokens = new Set(b);
  const shared = a.filter((token) => rightTokens.has(token)).length;
  return Math.round((shared / Math.min(a.length, b.length)) * 1000) / 1000;
}

/**
 * Decides which concept a question is about from the question itself.
 *
 * Deliberately independent of the video position: a learner may ask about
 * something from three minutes ago, or read ahead, and attributing by playhead
 * quietly turns "what the learner was watching" into "what the learner does not
 * understand". Returning null is the honest answer for a question this cannot
 * place, and the backend records no concept evidence for it.
 *
 * Matching is on stemmed whole tokens rather than raw substrings, so "ppi" no
 * longer matches inside "happiness". Two independent gates have to pass: the
 * winning concept needs enough absolute evidence (MIN_CONCEPT_SCORE), and it
 * needs to clearly beat the runner-up (QUESTION_CONFIDENCE). The old scorer had
 * only the second, which is why a lone generic keyword scored a confidence of 1.
 */
export function classifyQuestionConcept(value) {
  const sequence = stemSequence(value);
  if (sequence.length === 0) return null;

  const ranked = [...TERM_INDEX.byConcept.entries()]
    .map(([conceptId, terms]) => ({
      conceptId,
      score: terms.reduce(
        (total, words) => total + (containsPhrase(sequence, words) ? termWeight(words) : 0),
        0,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.conceptId.localeCompare(right.conceptId));

  const best = ranked[0];
  if (!best || best.score < MIN_CONCEPT_SCORE) return null;

  const runnerUp = ranked[1]?.score || 0;
  const confidence = best.score / (best.score + runnerUp);
  if (confidence < QUESTION_CONFIDENCE) return null;
  return { conceptId: best.conceptId, confidence: Math.round(confidence * 1000) / 1000 };
}

export function isClarificationFollowUp(value) {
  return CLARIFICATION_FOLLOW_UP.test(String(value || '').trim());
}

export function createRepeatedQuestionTracker({
  now = () => Date.now(),
  classifyConcept = classifyQuestionConcept,
} = {}) {
  const questions = [];
  const repeatCounts = new Map();
  let nextClusterId = 1;
  return {
    record(text, videoTime) {
      const tokens = questionTokens(text);
      // Retained for the event audit trail only. A repeat used to be dropped
      // outright when the position was unreadable, which made a text-level
      // judgement depend on the video after all.
      const seconds = finiteSeconds(videoTime);
      const clarification = isClarificationFollowUp(text);
      if (!clarification && tokens.length < 2) return null;
      const atMs = now();
      let classification = classifyConcept(text);
      while (questions.length && atMs - questions[0].atMs > REPEATED_QUESTION_MAX_SECONDS * 1000) {
        questions.shift();
      }
      let best = null;
      for (const previous of questions) {
        const elapsedSeconds = (atMs - previous.atMs) / 1000;
        const similarity = clarification ? 1 : questionSimilarity(previous.text, text);
        if (similarity >= REPEATED_QUESTION_SIMILARITY && (!best || similarity > best.similarity)) {
          best = {
            clusterId: previous.clusterId,
            previousVideoTime: previous.videoTime,
            similarity,
            elapsedSeconds,
            semanticConceptId:
              classification?.conceptId === previous.classification?.conceptId
                ? classification.conceptId
                : '',
            semanticConfidence:
              classification?.conceptId === previous.classification?.conceptId
                ? Math.min(classification.confidence, previous.classification.confidence)
                : 0,
            inheritedClassification: previous.classification || null,
          };
        }
      }
      if (clarification && best && !classification) {
        classification = best.inheritedClassification;
        best.semanticConceptId = classification?.conceptId || '';
        best.semanticConfidence = classification?.confidence || 0;
      }
      const clusterId = best?.clusterId || nextClusterId++;
      questions.push({ text: String(text), videoTime: seconds, atMs, clusterId, classification });
      if (
        !best
        || best.elapsedSeconds < REPEATED_QUESTION_MIN_SECONDS
        || (repeatCounts.get(clusterId) || 0) >= 2
      ) return null;
      repeatCounts.set(clusterId, (repeatCounts.get(clusterId) || 0) + 1);
      return best;
    },
  };
}

export function createLessonBehaviorState({ now = () => Date.now() } = {}) {
  const seeks = [];
  let pausedAtMs = null;

  function prune(timestampMs) {
    while (seeks.length && timestampMs - seeks[0].atMs > BEHAVIOR_WINDOW_MS) {
      seeks.shift();
    }
  }

  return {
    recordSeek(fromSeconds, toSeconds) {
      const from = finiteSeconds(fromSeconds);
      const to = finiteSeconds(toSeconds);
      if (from === null || to === null || Math.abs(to - from) < 1) return null;
      const entry = { atMs: now(), deltaSeconds: to - from };
      seeks.push(entry);
      prune(entry.atMs);
      return entry;
    },
    recordPause() {
      if (pausedAtMs === null) pausedAtMs = now();
    },
    recordResume() {
      const durationSeconds = pausedAtMs === null ? 0 : Math.max(0, (now() - pausedAtMs) / 1000);
      pausedAtMs = null;
      return Math.round(durationSeconds * 10) / 10;
    },
    getContext({ transcriptReading = false } = {}) {
      const timestampMs = now();
      prune(timestampMs);
      const backwards = seeks.filter((entry) => entry.deltaSeconds < 0);
      const forwards = seeks.filter((entry) => entry.deltaSeconds >= 30);
      const pauseDurationSeconds = pausedAtMs === null
        ? 0
        : Math.max(0, Math.round((timestampMs - pausedAtMs) / 1000));
      return {
        rewindCount: backwards.length,
        largestBackwardSeekSeconds: backwards.length
          ? Math.round(Math.max(...backwards.map((entry) => Math.abs(entry.deltaSeconds))))
          : 0,
        forwardSkipCount: forwards.length,
        pauseDurationSeconds,
        transcriptReading: Boolean(transcriptReading && pauseDurationSeconds >= LONG_PAUSE_SECONDS),
      };
    },
  };
}

// Native video controls may emit several seeking/seeked pairs while one scrubber
// gesture is still in progress. Collapse that burst to its original start and
// final destination so a single rewind cannot be counted several times.
export function createSeekGestureTracker({
  onGesture,
  delayMs = SEEK_GESTURE_SETTLE_MS,
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (timer) => window.clearTimeout(timer),
} = {}) {
  let startSeconds = null;
  let endSeconds = null;
  let timer = null;

  function flush() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (startSeconds !== null && endSeconds !== null) {
      onGesture?.(startSeconds, endSeconds);
    }
    startSeconds = null;
    endSeconds = null;
  }

  return {
    record(fromSeconds, toSeconds) {
      const from = finiteSeconds(fromSeconds);
      const to = finiteSeconds(toSeconds);
      if (from === null || to === null) return;
      if (startSeconds === null) startSeconds = from;
      endSeconds = to;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, delayMs);
    },
    flush,
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      startSeconds = null;
      endSeconds = null;
    },
  };
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) return '';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createLessonAnalyticsClient({
  lessonSlug,
  fetchImpl = globalThis.fetch,
  getAuthToken = null,
} = {}) {
  const sessionId = createId();
  let queue = [];
  let sending = false;
  let flushTimer = null;

  async function flush({ useBeacon = false } = {}) {
    if (sending || queue.length === 0) return false;
    const events = queue.splice(0, ANALYTICS_BATCH_SIZE);
    const body = JSON.stringify({ schemaVersion: ANALYTICS_SCHEMA_VERSION, events });

    // sendBeacon cannot attach an Authorization header. It remains useful only
    // for explicitly anonymous/local builds; identified analytics uses a
    // keepalive fetch during teardown instead.
    if (
      useBeacon
      && !getAuthToken
      && typeof navigator !== 'undefined'
      && typeof navigator.sendBeacon === 'function'
    ) {
      const accepted = navigator.sendBeacon(
        ANALYTICS_ENDPOINT,
        new Blob([body], { type: 'application/json' }),
      );
      if (accepted) return true;
    }

    if (typeof fetchImpl !== 'function') {
      queue = [...events, ...queue].slice(-100);
      return false;
    }

    sending = true;
    try {
      const token = getAuthToken ? await getAuthToken() : '';
      if (getAuthToken && !token) throw new Error('Analytics token is unavailable.');
      const payloadHash = await sha256Hex(body);
      const response = await fetchImpl(ANALYTICS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // CloudFront signs the Lambda origin request (OAC); a POST body must
          // carry its own SHA-256 or the Function URL rejects it.
          ...(payloadHash ? { 'x-amz-content-sha256': payloadHash } : {}),
          ...(token ? { 'X-VCS-Entra-Token': token } : {}),
        },
        body,
        keepalive: true,
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`Analytics ingest returned ${response.status}`);
      return true;
    } catch {
      queue = [...events, ...queue].slice(-100);
      return false;
    } finally {
      sending = false;
    }
  }

  function scheduleFlush() {
    if (flushTimer !== null || typeof window === 'undefined') return;
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      void flush();
    }, ANALYTICS_FLUSH_INTERVAL_MS);
  }

  function track(eventName, { videoTime = null, properties = {} } = {}) {
    queue.push({
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      eventId: createId(),
      sessionId,
      occurredAt: new Date().toISOString(),
      eventName,
      lessonSlug: String(lessonSlug || '').slice(0, 80),
      ...(finiteSeconds(videoTime) === null ? {} : { videoTime: finiteSeconds(videoTime) }),
      properties,
    });
    if (queue.length >= ANALYTICS_BATCH_SIZE) void flush();
    else scheduleFlush();
  }

  return {
    sessionId,
    track,
    flush,
    close() {
      if (flushTimer !== null && typeof window !== 'undefined') {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      return flush({ useBeacon: true });
    },
  };
}
