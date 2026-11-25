// Background-safe export (beta). Instead of playing the clip in real time and
// recording the screen-like canvas stream, this steps through the clip frame
// by frame (seek -> draw -> encode) with WebCodecs, encodes the audio from the
// decoded file, and muxes an MP4 in memory. It does not depend on
// requestAnimationFrame or playback, so a hidden tab keeps working.
// Loaded only when the creator turns it on.
import { compose, outSize, clipWords, groupWords, cropFraction } from './render.js';
import { openVideo, seek } from './export.js';
import { trackSpeaker } from './reframe.js';

const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm';
const FPS = 30;
export const fastSupported = () => 'VideoEncoder' in window && 'AudioEncoder' in window && 'VideoFrame' in window;
const abortErr = () => Object.assign(new Error('Export cancelled.'), { name: 'AbortError' });

async function pickVideoCodec(w, h) {
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42003e', 'avc1.640033']) {
    const cfg = { codec, width: w, height: h, bitrate: w * h >= 1920 * 1080 * 0.9 ? 8_000_000 : 5_000_000, framerate: FPS, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(cfg).catch(() => ({}))).supported) return cfg;
  }
  throw new Error('This browser can’t encode H.264 video with WebCodecs.');
}
async function pickAudioCodec(sampleRate) {
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate, numberOfChannels: 2, bitrate: 160_000 };
    if ((await AudioEncoder.isConfigSupported(cfg).catch(() => ({}))).supported) return { cfg, mux };
  }
  return null;
}

export async function fastExportClip(job, { onProgress, signal } = {}) {
  const { clip, style } = job;
  const speed = style.speed || 1;
  const check = () => { if (signal?.aborted) throw abortErr(); };
  const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);
  const vids = {};
  let venc = null, aenc = null;
  try {
    for (const r of clip.ranges) if (!vids[r.src]) { vids[r.src] = await openVideo(job.urls[r.src]); vids[r.src].muted = true; }
    const first = vids[clip.ranges[0].src];
    const hasVideo = first.videoWidth > 0;
    const { w: W, h: H } = outSize(style, first.videoWidth, first.videoHeight);

    // speaker tracking, as in the real-time export
    const follows = [];
    let framing = hasVideo && style.layout === 'auto' ? 'fixed' : 'none';
    if (hasVideo && style.layout === 'auto' && !style.rotate) {
      for (let i = 0; i < clip.ranges.length; i++) {
        const r = clip.ranges[i], v = vids[r.src];
        follows[i] = job.follows?.[i] !== undefined ? job.follows[i]
          : await trackSpeaker(job.urls[r.src], r, cropFraction(style, v.videoWidth, v.videoHeight), (p) => onProgress?.((i + p) / clip.ranges.length, 'Finding the speaker'), signal).catch((e) => { if (e.name === 'AbortError') throw e; return null; });
        check();
      }
      if (follows.some(Boolean)) framing = 'followed';
    }

    // ---- audio: decode each source once at 48 kHz, cut the ranges, apply gain and fades ----
    onProgress?.(0, 'Reading the audio');
    const SR = 48000;
    const decoded = {};
    for (const r of clip.ranges) {
      if (decoded[r.src] !== undefined) continue;
      try {
        const buf = await (await fetch(job.urls[r.src])).arrayBuffer();
        const ctx = new OfflineAudioContext(2, 1, SR);
        decoded[r.src] = await ctx.decodeAudioData(buf);
      } catch { decoded[r.src] = null; } // no audio track
      check();
    }
    const total = clip.ranges.reduce((s, r) => s + (r.end - r.start) / speed, 0);
    const nOut = Math.ceil(total * SR);
    const L = new Float32Array(nOut), Rr = new Float32Array(nOut);
    let o = 0;
    for (const r of clip.ranges) {
      const b = decoded[r.src];
      const len = Math.round(((r.end - r.start) / speed) * SR);
      if (b) {
        const l = b.getChannelData(0), rr = b.numberOfChannels > 1 ? b.getChannelData(1) : l;
        for (let k = 0; k < len && o + k < nOut; k++) {
          const si = Math.floor(r.start * b.sampleRate + k * speed * (b.sampleRate / SR)); // speed changes pitch here (beta)
          L[o + k] = l[si] || 0; Rr[o + k] = rr[si] || 0;
        }
      }
      o += len;
    }
    const level = style.mute ? 0 : Math.pow(10, (style.gain || 0) / 20);
    for (let k = 0; k < nOut; k++) {
      const t = k / SR;
      let g = level;
      if (style.fadeIn) g *= Math.min(1, t / style.fadeIn);
      if (style.fadeOut) g *= Math.min(1, (total - t) / style.fadeOut);
      L[k] = Math.max(-1, Math.min(1, L[k] * g)); Rr[k] = Math.max(-1, Math.min(1, Rr[k] * g));
    }

    // ---- encoders and muxer ----
    const vcfg = await pickVideoCodec(W, H);
    const ac = await pickAudioCodec(SR);
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target, fastStart: 'in-memory', firstTimestampBehavior: 'offset',
      video: { codec: 'avc', width: W, height: H, frameRate: FPS },
      ...(ac ? { audio: { codec: ac.mux, sampleRate: SR, numberOfChannels: 2 } } : {}),
    });
    let encErr = null;
    venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
    venc.configure(vcfg);
    if (ac) {
      aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { encErr = e; } });
      aenc.configure(ac.cfg);
      const CH = 1024 * 8;
      for (let k = 0; k < nOut; k += CH) {
        const n = Math.min(CH, nOut - k);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(k, k + n), 0); data.set(Rr.subarray(k, k + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((k / SR) * 1e6), data });
        aenc.encode(ad); ad.close();
      }
    }

    // ---- video: seek, draw, encode, frame by frame ----
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const levels = new Uint8Array(64);
    let ovEl = null;
    if (job.overlayUrl) ovEl = job.overlayKind === 'video' ? await openVideo(job.overlayUrl) : await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = job.overlayUrl; });
    const frames = Math.max(1, Math.round(total * FPS));
    let done = 0;
    for (let i = 0, f = 0; i < clip.ranges.length; i++) {
      const r = clip.ranges[i], v = vids[r.src];
      const words = clipWords(job.segments[r.src] || [], r.start, r.end), groups = groupWords(words, style.words || 3);
      const rFrames = Math.round(((r.end - r.start) / speed) * FPS);
      for (let k = 0; k < rFrames; k++, f++) {
        check();
        if (encErr) throw encErr;
        const seqT = done + k / FPS, st = Math.min(r.end - 0.001, r.start + (k / FPS) * speed);
        if (hasVideo) await seek(v, st);
        if (!hasVideo) { // audiogram bars from the audio around this frame
          const a = Math.floor(seqT * SR);
          for (let b = 0; b < 64; b++) { let m = 0; for (let j = 0; j < 64; j++) m = Math.max(m, Math.abs(L[a + b * 32 + j] || 0)); levels[b] = Math.min(255, m * 400); }
        }
        if (ovEl?.tagName === 'VIDEO' && ovEl.duration) await seek(ovEl, seqT % ovEl.duration);
        compose(ctx, W, H, {
          media: hasVideo ? v : null, mw: v.videoWidth, mh: v.videoHeight, st, seqT, dur: total, style, title: clip.title,
          words, groups, levels: hasVideo ? null : levels, follow: follows[i] || null, overlay: clip.overlay, overlayEl: ovEl,
        });
        const frame = new VideoFrame(canvas, { timestamp: Math.round((f / FPS) * 1e6), duration: Math.round(1e6 / FPS) });
        venc.encode(frame, { keyFrame: f % (FPS * 2) === 0 });
        frame.close();
        while (venc.encodeQueueSize > 6) await new Promise((res) => setTimeout(res, 5));
        if (f % 5 === 0) onProgress?.(f / frames, 'Rendering');
      }
      done += (r.end - r.start) / speed;
    }
    await venc.flush();
    if (aenc) await aenc.flush();
    if (encErr) throw encErr;
    muxer.finalize();
    onProgress?.(1, 'Rendering');
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), framing, width: W, height: H };
  } finally {
    try { if (venc && venc.state !== 'closed') venc.close(); } catch { /* closed */ }
    try { if (aenc && aenc.state !== 'closed') aenc.close(); } catch { /* closed */ }
    for (const v of Object.values(vids)) { v.removeAttribute('src'); v.load(); }
  }
}
