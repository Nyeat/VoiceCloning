// A progress stream that survives the GPU going away.
//
// The browser's EventSource only auto-reconnects after a dropped stream. If the
// reconnect itself gets an HTTP error (the ALB answers 503 while the instance is
// stopped or still booting), it closes for good and fires nothing else, so the
// page used to sit on "running" forever. This wrapper reopens a closed stream
// with backoff and tells the caller the connection is lost, so the UI can say so
// instead of hanging. It keeps the `.close()` handle every caller relies on.
export const SSE_RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 15_000];
export const SSE_LOST_AFTER_MS = 20_000;

export function openResilientStream(url, listeners, {
  onConnectionChange,
  EventSourceImpl = globalThis.EventSource,
  setTimeoutImpl = globalThis.setTimeout.bind(globalThis),
  clearTimeoutImpl = globalThis.clearTimeout.bind(globalThis),
  now = Date.now,
} = {}) {
  let es = null;
  let closed = false;
  let attempt = 0;
  let retryTimer = null;
  let lostTimer = null;
  let lostReported = false;
  let downSince = null;

  function reportUp() {
    attempt = 0;
    downSince = null;
    if (lostTimer) { clearTimeoutImpl(lostTimer); lostTimer = null; }
    if (lostReported) {
      lostReported = false;
      onConnectionChange?.({ state: 'connected' });
    }
  }

  function reportDown() {
    if (downSince === null) downSince = now();
    if (lostReported || lostTimer) return;
    lostTimer = setTimeoutImpl(() => {
      lostTimer = null;
      if (closed) return;
      lostReported = true;
      onConnectionChange?.({ state: 'lost', since: downSince });
    }, SSE_LOST_AFTER_MS);
  }

  function open() {
    if (closed) return;
    es = new EventSourceImpl(url);
    es.addEventListener('open', reportUp);
    for (const [eventName, handler] of Object.entries(listeners)) {
      es.addEventListener(eventName, (event) => {
        // A bare 'error' (no data) is the connection failing, not a message.
        if (eventName === 'error' && !event?.data) return;
        reportUp();
        handler(event, stream);
      });
    }
    es.addEventListener('error', (event) => {
      if (event?.data) return; // server-sent 'error' event; handled by listeners
      if (closed) return;
      reportDown();
      // CONNECTING (0): the browser is already retrying. CLOSED (2): it gave up,
      // so reopen ourselves with backoff.
      if (es.readyState === 2) scheduleReopen();
    });
  }

  function scheduleReopen() {
    if (closed || retryTimer) return;
    const delay = SSE_RECONNECT_DELAYS_MS[Math.min(attempt, SSE_RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      try { es?.close(); } catch { /* already closed */ }
      open();
    }, delay);
  }

  const stream = {
    close() {
      closed = true;
      if (retryTimer) clearTimeoutImpl(retryTimer);
      if (lostTimer) clearTimeoutImpl(lostTimer);
      retryTimer = null;
      lostTimer = null;
      try { es?.close(); } catch { /* already closed */ }
    },
  };

  open();
  return stream;
}
