// Records the microphone with MediaRecorder, then converts the take to a mono
// 16-bit WAV in the browser. Training accepts WAV directly, so nothing depends
// on the server decoding WebM/Opus, and the file the lecturer replays is the
// exact file that is uploaded.

export const TARGET_SAMPLE_RATE = 32000;

/** Pure: Float32 mono samples (-1..1) -> WAV bytes. */
export function encodeWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/** Pure: peak level of a take, used to warn about a silent or clipped recording. */
export function describeLevels(samples) {
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
    if (value >= 0.99) clipped += 1;
  }
  return {
    peak,
    clippedRatio: samples.length ? clipped / samples.length : 0,
    tooQuiet: peak < 0.05,
    tooLoud: samples.length > 0 && clipped / samples.length > 0.001,
  };
}

async function decodeToMono(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const context = new AudioCtx();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
    const offline = new OfflineAudioContext(1, Math.max(1, frames), TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded; // multi-channel is down-mixed to the mono destination
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return { samples: rendered.getChannelData(0), duration: decoded.duration };
  } finally {
    context.close().catch(() => {});
  }
}

// Raw capture first (no browser processing, mono). Some devices or drivers
// reject those constraints, and Chrome reports a default microphone that has
// just changed (headset unplugged, Bluetooth switching) as "Device was
// removed" — so on those errors it asks once more, plainly.
const RETRYABLE_MIC_ERRORS = new Set(['NotReadableError', 'OverconstrainedError', 'AbortError', 'NotFoundError']);

export async function openMicrophone(deviceId = '') {
  const device = deviceId ? { deviceId: { exact: deviceId } } : {};
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { ...device, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (error) {
    if (!RETRYABLE_MIC_ERRORS.has(error?.name)) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: deviceId ? device : true });
  }
}

/** Microphones the browser can see (labels only once permission was given). */
export async function listMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
}

/** A sentence a lecturer can act on, for a microphone that would not start. */
export function microphoneErrorText(error) {
  if (error?.name === 'NotAllowedError') return 'Microphone access was blocked. Allow the microphone in your browser\'s address bar, then try again.';
  if (error?.name === 'NotFoundError') return 'No microphone was found. Plug one in (or pick another below), then press Start again.';
  if (error?.name === 'NotReadableError' || error?.name === 'AbortError' || /removed/iu.test(error?.message || '')) {
    return 'The microphone was disconnected or another app (Teams, Zoom…) is using it. Check it is plugged in, close other apps using it or pick another microphone below, then press Start again.';
  }
  return `Could not start the microphone: ${error?.message || 'unknown error'}`;
}

export function microphoneSupported() {
  return typeof window !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof window.MediaRecorder !== 'undefined';
}

/**
 * start() -> resolves when recording; stop() -> resolves { file, url, duration, levels }.
 * onLevel(0..1) is called ~20x per second for the meter.
 */
export function createRecorder({ onLevel } = {}) {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let meterContext = null;
  let meterTimer = null;
  let startedAt = 0;

  function cleanup() {
    if (meterTimer) window.clearInterval(meterTimer);
    meterTimer = null;
    meterContext?.close().catch(() => {});
    meterContext = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      chunks = [];
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => window.MediaRecorder.isTypeSupported?.(type)) || '';
      recorder = new window.MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined);
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.start(1000);
      startedAt = Date.now();
      if (onLevel) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        meterContext = new AudioCtx();
        const analyser = meterContext.createAnalyser();
        analyser.fftSize = 1024;
        meterContext.createMediaStreamSource(stream).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        meterTimer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
          onLevel(peak);
        }, 50);
      }
    },
    elapsedSeconds() {
      return startedAt ? (Date.now() - startedAt) / 1000 : 0;
    },
    async stop(fileName = 'recording.wav') {
      if (!recorder) throw new Error('Not recording');
      const done = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.stop();
      await done;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      recorder = null;
      startedAt = 0;
      cleanup();
      const { samples, duration } = await decodeToMono(blob);
      const wav = encodeWav(samples);
      const file = new File([wav], fileName, { type: 'audio/wav' });
      return { file, url: URL.createObjectURL(file), duration, levels: describeLevels(samples) };
    },
    cancel() {
      try { recorder?.stop(); } catch { /* already stopped */ }
      recorder = null;
      startedAt = 0;
      cleanup();
    },
  };
}

// ── Continuous recording (the guided script, start to finish) ─────────────
//
// One recording for the whole script: the lecturer moves between sections
// (swipe, arrows, keys) without stopping, and may pause for a break. The
// microphone is captured as raw PCM, resampled to 32 kHz and kept as 16-bit
// chunks, so 30 minutes is ~115 MB held once (no decode/re-encode copies), and
// the WAV is assembled from those chunks without concatenating them.

/** Pure: a 44-byte PCM WAV header for `dataBytes` of mono 16-bit audio. */
export function wavHeader(dataBytes, sampleRate = TARGET_SAMPLE_RATE) {
  const header = encodeWav(new Float32Array(0), sampleRate);
  const view = new DataView(header.buffer);
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * Pure, streaming: resamples Float32 blocks from inRate to outRate (linear
 * interpolation, continuous across blocks) and returns 16-bit samples.
 */
export function createResampler(inRate, outRate = TARGET_SAMPLE_RATE) {
  const step = inRate / outRate;
  let position = 0; // next output position, in input samples relative to `previous`
  let previous = 0; // last input sample of the previous block (index -1)
  return function push(block) {
    const out = [];
    // Needs block[index + 1]; the remainder waits for the next block.
    while (position < block.length - 1) {
      const index = Math.floor(position);
      const frac = position - index;
      const left = index < 0 ? previous : block[index];
      const right = block[index + 1];
      const value = left + (right - left) * frac;
      const clamped = Math.max(-1, Math.min(1, value));
      out.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
      position += step;
    }
    position -= block.length;
    previous = block[block.length - 1] ?? previous;
    return Int16Array.from(out);
  };
}

const WORKLET_SOURCE = `
class VsCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('vs-capture', VsCapture);
`;

/**
 * start() -> recording; pause()/resume(); seconds() = recorded time;
 * finish(name) -> { file, url, duration, levels }; cancel().
 * onLevel(0..1) is called with the live peak (also while paused, so the meter
 * still shows the microphone works).
 */
export function createContinuousRecorder({ onLevel, deviceId = '', onDeviceLost } = {}) {
  let stream = null;
  let context = null;
  let node = null;
  let mute = null;
  let paused = false;
  let push = null;
  let chunks = [];
  let samples = 0;
  let peak = 0;
  let clipped = 0;
  let inputSamples = 0;

  function onBlock(block) {
    let blockPeak = 0;
    for (let i = 0; i < block.length; i += 1) {
      const value = Math.abs(block[i]);
      if (value > blockPeak) blockPeak = value;
    }
    onLevel?.(blockPeak);
    if (paused) return;
    for (let i = 0; i < block.length; i += 1) if (Math.abs(block[i]) >= 0.99) clipped += 1;
    inputSamples += block.length;
    if (blockPeak > peak) peak = blockPeak;
    const pcm = push(block);
    if (pcm.length) {
      chunks.push(pcm);
      samples += pcm.length;
    }
  }

  function teardown() {
    try { node?.disconnect(); } catch { /* gone */ }
    try { mute?.disconnect(); } catch { /* gone */ }
    if (node?.port) node.port.onmessage = null;
    if (node && 'onaudioprocess' in node) node.onaudioprocess = null;
    node = null;
    mute = null;
    context?.close().catch(() => {});
    context = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  return {
    async start() {
      stream = await openMicrophone(deviceId);
      // A microphone unplugged mid-reading: stop taking audio (what was
      // recorded is kept) and let the page say so.
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => { paused = true; onDeviceLost?.(); };
      });
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      context = new AudioCtx();
      if (context.state === 'suspended') await context.resume().catch(() => {});
      push = createResampler(context.sampleRate, TARGET_SAMPLE_RATE);
      chunks = [];
      samples = 0;
      peak = 0;
      clipped = 0;
      inputSamples = 0;
      paused = false;
      const source = context.createMediaStreamSource(stream);
      mute = context.createGain();
      mute.gain.value = 0; // keeps the graph pulled without playing the mic back
      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        await context.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        node = new window.AudioWorkletNode(context, 'vs-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        node.port.onmessage = (event) => onBlock(event.data);
      } catch {
        // Older browsers or a strict policy on blob: workers.
        node = context.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (event) => onBlock(event.inputBuffer.getChannelData(0));
      }
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
    },
    pause() { paused = true; },
    resume() { paused = false; },
    isPaused() { return paused; },
    seconds() { return samples / TARGET_SAMPLE_RATE; },
    async finish(fileName = 'reading.wav') {
      if (!context) throw new Error('Not recording');
      teardown();
      const dataBytes = samples * 2;
      const file = new File([wavHeader(dataBytes), ...chunks], fileName, { type: 'audio/wav' });
      const duration = samples / TARGET_SAMPLE_RATE;
      const levels = {
        peak,
        clippedRatio: inputSamples ? clipped / inputSamples : 0,
        tooQuiet: peak < 0.05,
        tooLoud: inputSamples > 0 && clipped / inputSamples > 0.001,
      };
      chunks = [];
      return { file, url: URL.createObjectURL(file), duration, levels };
    },
    cancel() {
      teardown();
      chunks = [];
      samples = 0;
    },
  };
}
