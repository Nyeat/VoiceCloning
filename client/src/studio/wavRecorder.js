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
