import test from 'node:test';
import assert from 'node:assert/strict';
import { openResilientStream, SSE_LOST_AFTER_MS } from './resilientStream.js';

function harness() {
  const sources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      this.closed = false;
      sources.push(this);
    }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, event = {}) { for (const fn of this.listeners[name] || []) fn(event); }
    close() { this.closed = true; this.readyState = 2; }
  }
  let clock = 0;
  const timers = [];
  const setTimeoutImpl = (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; };
  const clearTimeoutImpl = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  const advance = (ms) => {
    clock += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at <= clock && timers.includes(t)) { clearTimeoutImpl(t); t.fn(); }
    }
  };
  return { sources, FakeEventSource, setTimeoutImpl, clearTimeoutImpl, advance, now: () => clock };
}

test('a stream the browser gave up on is reopened and reported lost, then recovered', () => {
  const h = harness();
  const changes = [];
  const messages = [];
  openResilientStream('/train/progress/s1', { log: (e) => messages.push(e.data) }, {
    onConnectionChange: (c) => changes.push(c.state),
    EventSourceImpl: h.FakeEventSource,
    setTimeoutImpl: h.setTimeoutImpl,
    clearTimeoutImpl: h.clearTimeoutImpl,
    now: h.now,
  });
  const first = h.sources[0];
  first.readyState = 2; // HTTP 503 on reconnect: EventSource closes permanently
  first.emit('error', {});
  h.advance(2_000);
  assert.equal(h.sources.length, 2, 'reopened after backoff');
  h.sources[1].readyState = 2;
  h.sources[1].emit('error', {});
  h.advance(SSE_LOST_AFTER_MS);
  assert.deepEqual(changes, ['lost']);
  const latest = h.sources.at(-1);
  latest.emit('open');
  latest.emit('log', { data: '{"x":1}' });
  assert.deepEqual(changes, ['lost', 'connected']);
  assert.deepEqual(messages, ['{"x":1}']);
});

test('a server-sent error event is delivered once and stops reconnecting', () => {
  const h = harness();
  const errors = [];
  const stream = openResilientStream('/inference/progress/s1', {
    error: (e, s) => { if (!e.data) return; errors.push(e.data); s.close(); },
  }, { EventSourceImpl: h.FakeEventSource, setTimeoutImpl: h.setTimeoutImpl, clearTimeoutImpl: h.clearTimeoutImpl, now: h.now });
  h.sources[0].emit('error', { data: '{"message":"boom"}' });
  assert.deepEqual(errors, ['{"message":"boom"}']);
  h.advance(60_000);
  assert.equal(h.sources.length, 1);
  assert.ok(h.sources[0].closed);
  stream.close();
});

test('close() cancels a pending reopen', () => {
  const h = harness();
  const stream = openResilientStream('/x', {}, { EventSourceImpl: h.FakeEventSource, setTimeoutImpl: h.setTimeoutImpl, clearTimeoutImpl: h.clearTimeoutImpl, now: h.now });
  h.sources[0].readyState = 2;
  h.sources[0].emit('error', {});
  stream.close();
  h.advance(60_000);
  assert.equal(h.sources.length, 1);
});
