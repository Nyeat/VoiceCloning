import { applyCors, err, preflight } from './shared/cors.js';
import { handler as liveHandler } from './live/index.js';

export const ROUTES = [
  { name: 'ConfigFunction', methods: ['GET'], pattern: /^\/api\/config\/?$/u, modulePath: './config/index.js' },
  { name: 'ChatbotPromptFunction', methods: ['GET', 'PUT'], pattern: /^\/api\/chatbot\/system-prompt(?:\/categories)?\/?$/u, modulePath: './chatbot-prompt/index.js' },
  { name: 'AnalyticsFunction', methods: ['POST'], pattern: /^\/api\/analytics\/events\/?$/u, modulePath: './analytics/index.js' },
  { name: 'LearnersFunction', methods: ['GET', 'DELETE'], pattern: /^\/api\/(?:learner\/me|supervisor\/(?:concepts|users(?:\/[^/]+|\/[^/]+\/events|\/[^/]+\/lessons\/[^/]+\/concepts\/[^/]+)?))\/?$/u, modulePath: './learners/index.js' },
  { name: 'UploadFunction', methods: ['POST'], pattern: /^\/api\/(?:upload|upload-ref)\/(?:presign|confirm)\/?$/u, modulePath: './upload/index.js' },
  { name: 'TrainingLibraryFunction', methods: ['GET', 'POST', 'DELETE'], pattern: /^\/api\/training-library(?:\/(?:snapshot|presign|confirm|[^/]+(?:\/(?:replace-presign|replace-confirm))?))?\/?$/u, modulePath: './training-library/index.js' },
  { name: 'TrainingFunction', methods: ['GET', 'POST'], pattern: /^\/api\/train(?:\/(?:stop|current|next-name|metadata\/[^/]+))?\/?$/u, modulePath: './training/index.js' },
  { name: 'ModelsFunction', methods: ['GET', 'POST'], pattern: /^\/api\/models(?:\/select)?\/?$/u, modulePath: './models/index.js' },
  { name: 'InferenceFunction', methods: ['GET', 'POST'], pattern: /^\/api\/inference(?:\/(?:generate|regenerate-chunk|restore-chunk|insert-chunk|delete-chunk|scan-oov|result\/[A-Za-z0-9-]+|chunk\/[A-Za-z0-9-]+\/\d+|chunk-preview\/[A-Za-z0-9-]+\/\d+|chunk-version\/[A-Za-z0-9-]+\/\d+\/[A-Za-z0-9-]+|cancel|current|status|start|stop))?\/?$/u, modulePath: './inference/index.js' },
  { name: 'TranscribeFunction', methods: ['POST'], pattern: /^\/api\/transcribe\/?$/u, modulePath: './transcribe/index.js' },
  { name: 'TrainingAudioFunction', methods: ['GET'], pattern: /^\/api\/(?:training-audio(?:\/file\/[^/]+\/[^/]+|\/[^/]+)|ref-audio)\/?$/u, modulePath: './training-audio/index.js' },
  { name: 'LiveFunction', methods: ['POST'], pattern: /^\/api\/live\/(?:tts-sentence|cancel)\/?$/u, modulePath: './live/index.js' },
  { name: 'VoiceProfileFunction', methods: ['GET', 'POST'], pattern: /^\/api\/voice-profile\/(?:activate|active|capacity|label|mine|ensure|(?:internal|pinned)\/[^/]+)\/?$/u, modulePath: './voice-profile/index.js' },
  { name: 'VoiceProfileConfigsFunction', methods: ['GET', 'POST', 'PUT', 'DELETE'], pattern: /^\/api\/voice-profile\/configs\/[^/]+(?:\/[^/]+)?\/?$/u, modulePath: './voice-profile-configs/index.js' },
  { name: 'PronunciationDictionaryFunction', methods: ['GET', 'POST'], pattern: /^\/api\/pronunciation-dictionary\/?$/u, modulePath: './pronunciation-dictionary/index.js' },
  { name: 'StudioFunction', methods: ['GET', 'POST', 'PUT', 'DELETE'], pattern: /^\/api\/studio\/[A-Za-z0-9._@%:-]+(?:\/[A-Za-z0-9._@%:-]+){0,4}\/?$/u, modulePath: './studio/index.js' },
  { name: 'InstanceFunction', methods: ['GET', 'POST'], pattern: /^\/api\/instance\/(?:status|start|activity|idle-check)\/?$/u, modulePath: './instance/index.js' },
];

// Live TTS has the largest dependency tree and is latency-sensitive. Load it while
// the Lambda environment initializes so a warmup through any route also prepares
// Live, rather than charging the first student for a lazy dynamic import.
const handlerCache = new Map([
  ['./live/index.js', Promise.resolve(liveHandler)],
]);

export function getMethod(event) {
  return String(event?.requestContext?.http?.method || event?.httpMethod || 'GET').toUpperCase();
}

export function getPath(event) {
  return event?.rawPath
    || event?.requestContext?.http?.path
    || event?.path
    || '/';
}

export function findRoute(method, pathname) {
  const route = ROUTES.find((entry) =>
    entry.methods.includes(method.toUpperCase()) && entry.pattern.test(pathname)
  );
  return route ? { ...route, lambdaPath: pathname } : null;
}

export async function getRouteHandler(route) {
  if (!handlerCache.has(route.modulePath)) {
    handlerCache.set(route.modulePath, import(route.modulePath).then((module) => module.handler));
  }
  return handlerCache.get(route.modulePath);
}

export async function dispatch(event, context) {
  const method = getMethod(event);
  const pathname = getPath(event);

  if (method === 'OPTIONS') {
    return preflight(event);
  }

  const route = findRoute(method, pathname);
  if (!route) {
    return err(404, `No Lambda route for ${method} ${pathname}`, event);
  }

  const handler = await getRouteHandler(route);
  const normalizedEvent = {
    ...event,
    rawPath: pathname,
    requestContext: {
      ...(event.requestContext || {}),
      http: {
        ...(event.requestContext?.http || {}),
        method,
        path: pathname,
      },
    },
  };

  return applyCors(await handler(normalizedEvent, context), normalizedEvent);
}
