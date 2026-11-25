// Speech-to-text worker: runs Whisper on the GPU (WebGPU) with transformers.js.
// Receives 16 kHz mono audio, transcribes it in 30 s windows and streams the
// timed segments back so the page can show progress as it goes.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

let asr = null;
let loadedModel = null;

const SR = 16000;
const WIN = 30; // seconds per window (Whisper's native input length)

async function load(model, device) {
  if (asr && loadedModel === model) return;
  asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype: device === 'webgpu'
      ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
      : 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        self.postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
      }
    },
  });
  loadedModel = model;
}

function rms(a) {
  let s = 0;
  for (let i = 0; i < a.length; i += 8) s += a[i] * a[i];
  return Math.sqrt(s / (a.length / 8));
}

self.onmessage = async (e) => {
  const { audio, model, language, device } = e.data;
  try {
    self.postMessage({ type: 'status', text: 'Loading speech model…' });
    await load(model, device);

    // Sequential long-form decoding: each 30 s window starts where the last
    // complete segment ended, and a segment cut off by the window edge is
    // dropped and re-read at the start of the next window (no lost words).
    const duration = audio.length / SR;
    const t0 = performance.now();
    let cursor = 0;
    while (cursor < duration - 0.5) {
      const winEnd = Math.min(duration, cursor + WIN);
      const last = winEnd >= duration;
      const chunk = audio.subarray(Math.floor(cursor * SR), Math.floor(winEnd * SR));
      let segments = [];
      let next = winEnd;
      if (rms(chunk) > 0.004) { // skip near-silent windows
        const out = await asr(chunk, {
          return_timestamps: true,
          ...(language ? { language, task: 'transcribe' } : {}),
        });
        const raw = (out.chunks || [{ timestamp: [0, null], text: out.text }]).map((c) => ({
          start: cursor + (c.timestamp[0] ?? 0),
          end: c.timestamp[1] == null ? null : Math.min(winEnd, cursor + c.timestamp[1]),
          text: c.text.trim(),
        }));
        const cut = (s) => s.end == null || s.end > winEnd - 0.6;
        if (!last) {
          // Whisper often stops after its last complete sentence and leaves
          // the window's tail unread, so always resume from the last full
          // segment's end (dropping a segment the window edge cut in half).
          if (raw.length > 1 && cut(raw[raw.length - 1])) raw.pop();
          next = raw[raw.length - 1].end ?? winEnd;
        }
        segments = raw
          .map((s) => ({ ...s, end: s.end ?? winEnd }))
          .filter((s) => s.text && !/^\[.*\]$|^\(.*\)$/.test(s.text));
      }
      if (next <= cursor + 1) next = winEnd; // never stall
      cursor = next;
      const elapsed = (performance.now() - t0) / 1000;
      self.postMessage({ type: 'segments', segments, done: cursor, total: duration, elapsed });
    }
    self.postMessage({ type: 'finished' });
  } catch (err) {
    self.postMessage({ type: 'error', text: String(err?.message || err) });
  }
};
