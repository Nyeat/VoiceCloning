import { WebSocket, WebSocketServer } from 'ws';
import { sessionActivity } from '../services/sessionActivity.js';
import {
  CORS_ORIGIN,
  ENTRA_ALLOWED_EMAIL_DOMAINS,
  ENTRA_AUDIENCE,
  ENTRA_TENANT_ID,
  FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS,
  STUDIO_ALLOWED_EMAIL_DOMAINS,
  STUDIO_HOME_DOMAINS,
  STUDIO_SITE_ORIGINS,
  LECTURER_TABLE_NAME,
  LIVE_AUTH_ENABLED,
  LIVE_AUTH_LOADTEST_SECRET,
  isAuthExemptOrigin,
  TRANSCRIPT_STORE_ASSISTANT,
  TRANSCRIPT_STORE_SYNTHETIC,
  TRANSCRIPT_TABLE_NAME,
  TRANSCRIPT_TABLE_REGION,
  TRANSCRIPT_TTL_DAYS,
} from '../config.js';
import { createDynamoPutItem } from '../services/dynamoTranscriptClient.js';
import { createEntraVerifier, TokenError } from '../services/entraToken.js';
import {
  AUTH_TIMEOUT_MS,
  closeCodeForError,
  createLiveChatAuthenticator,
  parseAuthFrame,
} from '../services/liveChatAuth.js';
import { OpenAiRealtimeBridge } from '../services/openaiRealtimeBridge.js';
import {
  NOISE_REDUCTION,
  normalizeRealtimeLanguage,
  TRANSCRIPTION_MODELS,
  normalizeTurnDetection,
  TURN_EAGERNESS,
} from '../services/openaiRealtimeEvents.js';
import { createTranscriptStore } from '../services/transcriptStore.js';
import { enforceFacultyAccess, isFacultyRequest } from '../services/facultyAccess.js';

export const LIVE_CHAT_PATH = '/api/live/chat/realtime';

// A client that opens the socket and floods it during verification must not be
// able to grow this buffer unbounded.
const MAX_PENDING_MESSAGES = 8;

export function buildConfiguredAuthenticator() {
  if (!LIVE_AUTH_ENABLED) {
    return null;
  }

  // A gateway that thinks auth is on but has no tenant configured must not accept
  // callers. It also must not crash: a dead process cannot serve /readyz, so the
  // operator gets a restart loop instead of the reason. Refuse every connection
  // and stay up — /readyz reports 503 and the load balancer pulls the instance.
  if (!ENTRA_TENANT_ID || !ENTRA_AUDIENCE) {
    console.error(
      '[live-chat] LIVE_AUTH_ENABLED is on but ENTRA_TENANT_ID/ENTRA_AUDIENCE are missing; '
      + 'refusing all live-chat connections. See GET /readyz.',
    );
    return {
      authenticate: async () => {
        throw new TokenError('misconfigured', 'Live chat authentication is not configured.');
      },
    };
  }

  return createLiveChatAuthenticator({
    verifier: createEntraVerifier({
      tenantId: ENTRA_TENANT_ID,
      audience: ENTRA_AUDIENCE,
      allowedEmailDomains: ENTRA_ALLOWED_EMAIL_DOMAINS,
    }),
    loadTestSecret: LIVE_AUTH_LOADTEST_SECRET,
  });
}

/** Any-Microsoft-account authenticator for the Voice Studio site; null when not configured. */
export function buildConfiguredStudioAuthenticator() {
  if (!LIVE_AUTH_ENABLED || STUDIO_SITE_ORIGINS.length === 0 || !ENTRA_TENANT_ID || !ENTRA_AUDIENCE) return null;
  return createLiveChatAuthenticator({
    verifier: createEntraVerifier({
      tenantId: ENTRA_TENANT_ID,
      audience: ENTRA_AUDIENCE,
      allowedEmailDomains: STUDIO_ALLOWED_EMAIL_DOMAINS,
      multiTenant: true,
      homeDomains: STUDIO_HOME_DOMAINS,
    }),
    loadTestSecret: '',
  });
}

export function isStudioOrigin(origin, origins = STUDIO_SITE_ORIGINS) {
  const value = String(origin || '').trim().replace(/\/+$/u, '');
  return Boolean(value) && origins.includes(value);
}

export function buildConfiguredTranscriptStore(tableName = TRANSCRIPT_TABLE_NAME) {
  if (!tableName) {
    return null;
  }

  return createTranscriptStore({
    putItem: createDynamoPutItem({
      tableName,
      region: TRANSCRIPT_TABLE_REGION,
    }),
    ttlDays: TRANSCRIPT_TTL_DAYS,
    storeSynthetic: TRANSCRIPT_STORE_SYNTHETIC,
    storeAssistantTurns: TRANSCRIPT_STORE_ASSISTANT,
  });
}

export function buildConfiguredTranscriptStoreForRequest() {
  const mainStore = buildConfiguredTranscriptStore();
  const lecturerStore = buildConfiguredTranscriptStore(LECTURER_TABLE_NAME);
  return (req) => (isFacultyRequest(req) ? lecturerStore : mainStore);
}

export function enforceConfiguredIdentityPolicy(identity, req) {
  return enforceFacultyAccess(identity, req, FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS);
}

// Maps the bridge's app-events to transcript turns. Anything not listed here —
// deltas, status events, errors — is not a completed turn and is not stored.
export function turnFromAppEvent(payload) {
  if (payload?.type === 'user.text.done') {
    return { role: 'user', text: payload.text };
  }

  if (payload?.type === 'assistant.text.done') {
    return { role: 'assistant', text: payload.text };
  }

  // Barge-in: the student heard this much before interrupting, so it belongs in
  // the transcript, flagged rather than silently recorded as a full reply.
  if (payload?.type === 'assistant.text.cancelled') {
    return { role: 'assistant', text: payload.text, cancelled: true };
  }

  return null;
}

export function parseRequestUrl(req) {
  const host = req.headers.host || 'localhost';
  return new URL(req.url || '/', 'http://' + host);
}

export function getLiveChatLanguage(url) {
  return normalizeRealtimeLanguage(url.searchParams.get('language') || '');
}

export function originAllowed(origin, options = {}) {
  const {
    nodeEnv = process.env.NODE_ENV || 'development',
    corsOrigin = CORS_ORIGIN,
    requestHost = '',
  } = options;

  if (nodeEnv !== 'production') {
    return true;
  }

  // Browsers always send an Origin header on the WebSocket handshake, so a
  // missing Origin in production means a non-browser client (e.g. a script
  // opening the socket directly to drain the OpenAI Realtime budget). Reject it.
  if (!origin) {
    return false;
  }

  if (corsOrigin === '*') {
    return true;
  }

  const allowedOrigins = String(corsOrigin || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  try {
    const originHost = new URL(origin).host.toLowerCase();
    if (requestHost && originHost === String(requestHost).toLowerCase()) {
      return true;
    }
  } catch {
    return false;
  }

  return allowedOrigins.includes(origin);
}

export function rejectUpgrade(socket, response) {
  socket.write(response);
  socket.destroy();
}

export function sendBrowser(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export function handleBrowserMessage(bridge, data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return;
  }

  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return;
  }

  if (message.type === 'audio.chunk') {
    bridge.sendAudio(message.audio);
    return;
  }

  // Where the student's lesson video is right now. Unknown message types are
  // ignored above and below, so a client that sends this to an older gateway —
  // or a client that never sends it — both stay working.
  if (message.type === 'video.position') {
    bridge.setVideoPosition({
      seconds: message.seconds,
      paused: message.paused,
      ...(message.behavior && typeof message.behavior === 'object'
        ? { behavior: message.behavior }
        : {}),
    });
    return;
  }

  // A question typed instead of spoken — for people with no microphone.
  if (message.type === 'user.text') {
    bridge.sendText(message.text);
    return;
  }

  if (message.type === 'input.pause') {
    bridge.pauseInput();
    return;
  }

  if (message.type === 'input.resume') {
    bridge.resumeInput();
    return;
  }

  if (message.type === 'input.commit') {
    bridge.commitInput();
    return;
  }

  if (message.type === 'response.cancel') {
    bridge.cancelResponse();
  }
}

export function parseLiveChatInit(data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return null;
  }

  if (typeof message !== 'object' || message === null || message.type !== 'session.init') {
    return null;
  }

  return {
    systemPrompt: typeof message.systemPrompt === 'string' ? message.systemPrompt : '',
    ...(typeof message.turnEagerness === 'string' ? { turnEagerness: message.turnEagerness } : {}),
    ...(message.turnDetection && typeof message.turnDetection === 'object' ? { turnDetection: message.turnDetection } : {}),
    ...(typeof message.transcriptionPrompt === 'string' ? { transcriptionPrompt: message.transcriptionPrompt } : {}),
    ...(typeof message.noiseReduction === 'string' ? { noiseReduction: message.noiseReduction } : {}),
    ...(typeof message.transcriptionModel === 'string' ? { transcriptionModel: message.transcriptionModel } : {}),
  };
}

export function applyLiveChatInitToBridge(bridge, init) {
  if (init && typeof init.systemPrompt === 'string' && init.systemPrompt.trim()) {
    bridge.systemPrompt = init.systemPrompt;
  }
  if (init && TURN_EAGERNESS.has(init.turnEagerness)) {
    bridge.turnEagerness = init.turnEagerness;
  }
  if (init && normalizeTurnDetection(init.turnDetection)) {
    bridge.turnDetection = init.turnDetection;
  }
  if (init && typeof init.transcriptionPrompt === 'string') {
    bridge.transcriptionPrompt = init.transcriptionPrompt.slice(0, 1000);
  }
  if (init && NOISE_REDUCTION.has(init.noiseReduction)) {
    bridge.noiseReduction = init.noiseReduction;
  }
  if (init && TRANSCRIPTION_MODELS.has(init.transcriptionModel)) {
    bridge.transcriptionModel = init.transcriptionModel;
  }
}

export function attachLiveChatSocket(server, options = {}) {
  const {
    authenticator = buildConfiguredAuthenticator(),
    studioAuthenticator = buildConfiguredStudioAuthenticator(),
    studioOrigin = isStudioOrigin,
    transcriptStore = buildConfiguredTranscriptStore(),
    transcriptStoreForRequest = null,
    identityPolicy = enforceConfiguredIdentityPolicy,
    // Seams for tests: a stub bridge avoids dialling OpenAI, and a short timeout
    // keeps the unauthenticated-socket test fast.
    createBridge = (bridgeOptions) => new OpenAiRealtimeBridge(bridgeOptions),
    authTimeoutMs = AUTH_TIMEOUT_MS,
    authExempt = isAuthExemptOrigin,
    activity = sessionActivity,
  } = options;
  const wss = new WebSocketServer({ noServer: true });
  const activeClients = new Map();

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = parseRequestUrl(req);
    } catch {
      rejectUpgrade(socket, 'HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    if (url.pathname !== LIVE_CHAT_PATH) {
      rejectUpgrade(socket, 'HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    const origin = req.headers.origin || '';
    const requestHost = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (!originAllowed(origin, { requestHost })) {
      rejectUpgrade(socket, 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    wss.handleUpgrade(req, socket, head, (browserSocket) => {
      wss.emit('connection', browserSocket, req);
    });
  });

  wss.on('connection', (browserSocket, req) => {
    const url = parseRequestUrl(req);
    const language = getLiveChatLanguage(url);
    const bridge = createBridge({ language });
    const requestTranscriptStore = transcriptStoreForRequest
      ? transcriptStoreForRequest(req)
      : transcriptStore;
    activeClients.set(browserSocket, bridge);
    activity.opened();

    let transcriptSession = null;
    bridge.on('app-event', (payload) => {
      sendBrowser(browserSocket, payload);

      if (transcriptSession) {
        const turn = turnFromAppEvent(payload);
        if (turn) transcriptSession.recordTurn(turn);
      }
    });

    // Turns the browser must not be told about again. A typed question is the
    // only one today: it never reaches OpenAI's transcription, so no app-event
    // carries it, but the browser drew it locally the moment it was sent.
    bridge.on('transcript-turn', (turn) => {
      if (transcriptSession) transcriptSession.recordTurn(turn);
    });

    bridge.on('close', () => {
      activeClients.delete(browserSocket);
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.close(1000, 'Live session ended');
      }
    });

    let connected = false;
    let closed = false;
    let initTimer = null;
    let authTimer = null;
    const ensureConnected = () => {
      if (connected) return;
      connected = true;
      clearTimeout(initTimer);
      bridge.connect();
    };
    // Safety net: a client that never sends session.init must not hang.
    // Kept short so frontends that don't send a handshake (e.g. the normal
    // client, which waits for session.ready before sending anything) connect
    // promptly; still leaves margin for a chatbot client's session.init,
    // which is sent the instant the socket opens.
    const startInitWindow = () => {
      initTimer = setTimeout(ensureConnected, 200);
    };

    const handleSessionMessage = (data) => {
      if (!connected) {
        // A newer client sends session.auth even when this gateway has auth
        // disabled. Ignore it rather than treating it as the first real message:
        // that would connect early and drop the session.init behind it, losing
        // the system prompt whenever client and gateway deploy out of step.
        if (parseAuthFrame(data)) return;

        const init = parseLiveChatInit(data);
        if (init) {
          applyLiveChatInitToBridge(bridge, init);
          ensureConnected();
          return; // session.init is handshake-only; do not forward downstream.
        }
        // First real message arrived before any handshake — connect, then handle it.
        ensureConnected();
      }
      handleBrowserMessage(bridge, data);
    };

    // An exempt origin (an open kiosk distribution with no sign-in) skips the
    // handshake and runs as a synthetic identity, exactly as the load tests do.
    // Every other origin still has to present a token.
    const exemptOrigin = Boolean(authenticator) && authExempt(req.headers?.origin || '');
    if (exemptOrigin) {
      bridge.identity = { oid: 'ANON#kiosk', email: '', name: '', synthetic: true };
      try {
        transcriptSession = requestTranscriptStore?.openSession(bridge.identity) || null;
      } catch (error) {
        console.error('[transcript] could not open session', error?.message);
      }
    }

    // With no authenticator configured the socket behaves exactly as before.
    let authenticated = !authenticator || exemptOrigin;
    let authInFlight = false;
    const pendingMessages = [];

    const failAuth = (error) => {
      clearTimeout(authTimer);
      pendingMessages.length = 0;
      sendBrowser(browserSocket, {
        type: 'session.auth.failed',
        code: error?.code || 'unauthorized',
        message: error?.message || 'Authentication failed.',
      });
      browserSocket.close(closeCodeForError(error), 'Authentication failed');
    };

    const runAuth = async (data) => {
      authInFlight = true;
      let identity;
      try {
        // Voice Studio pages accept any Microsoft account; the faculty rule is not applied there.
        if (studioAuthenticator && studioOrigin(req.headers?.origin || '')) {
          identity = await studioAuthenticator.authenticate(parseAuthFrame(data));
        } else {
          identity = await authenticator.authenticate(parseAuthFrame(data));
          identity = identityPolicy(identity, req);
        }
      } catch (error) {
        authInFlight = false;
        failAuth(error);
        return;
      }

      authInFlight = false;
      if (closed) return; // Socket went away mid-verification; do not spin up a bridge.

      authenticated = true;
      clearTimeout(authTimer);
      // Bound to the socket for its lifetime — every transcript turn written
      // from this connection is attributed to this identity and no other.
      bridge.identity = identity;
      // Storage must never take down a conversation, so a store that refuses to
      // open leaves the session unrecorded rather than failing the connection.
      try {
        transcriptSession = requestTranscriptStore?.openSession(identity) || null;
      } catch (error) {
        console.error('[transcript] could not open session', error?.message);
      }
      sendBrowser(browserSocket, {
        type: 'session.authenticated',
        synthetic: identity.synthetic,
      });
      startInitWindow();

      for (const queued of pendingMessages.splice(0)) {
        handleSessionMessage(queued);
      }
    };

    if (authenticated) {
      startInitWindow();
    } else {
      // No bridge is created upstream until this resolves, so an unauthenticated
      // socket costs us nothing but the connection itself.
      authTimer = setTimeout(() => {
        failAuth({ code: 'timeout', message: 'Authentication timed out.' });
      }, authTimeoutMs);
    }

    browserSocket.on('message', (data) => {
      activity.touched();
      if (!authenticated) {
        if (authInFlight) {
          // Clients that send session.init immediately after session.auth must
          // not lose it, but the queue stays bounded against a flood.
          if (pendingMessages.length < MAX_PENDING_MESSAGES) pendingMessages.push(data);
          return;
        }
        void runAuth(data);
        return;
      }
      handleSessionMessage(data);
    });

    const closeBridge = () => {
      if (!closed) activity.closed();
      closed = true;
      activeClients.delete(browserSocket);
      clearTimeout(initTimer);
      clearTimeout(authTimer);
      bridge.close();
    };

    browserSocket.on('close', closeBridge);
    browserSocket.on('error', closeBridge);
  });

  return {
    close() {
      for (const [client, bridge] of activeClients.entries()) {
        if (
          client.readyState === WebSocket.OPEN
          || client.readyState === WebSocket.CONNECTING
        ) {
          client.close(1001, 'Live gateway shutting down');
        }
        bridge.close();
      }

      activeClients.clear();
      wss.close();
    },
  };
}
