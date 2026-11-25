// Real-time export: plays each range of the short on hidden video elements,
// draws every frame with the shared compositor (render.js) and records the
// canvas plus audio with the browser's own encoder (MediaRecorder). Ranges
// are joined by pausing the recorder while the next range seeks.
// Everything stays on the device. A 30 s short takes ~30 s; keep the tab visible.

import { trackSpeaker } from './reframe.js';
import { compose, outSize, clipWords, groupWords, cropFraction } from './render.js';

const MIME_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
export const exportMime = MIME_TYPES.find((t) => window.MediaRecorder?.isTypeSupported(t)) || '';
export const exportExt = exportMime.startsWith('video/mp4') ? 'mp4' : 'webm';
export { clipWords };

// A promise that gives up after ms, so a stuck media event can't freeze the queue.
export const within = (ms, what, setup) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`${what} took too long.`)), ms);
  setup((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});
const abortErr = () => Object.assign(new Error('Export cancelled.'), { name: 'AbortError' });

export async function openVideo(url) {
  const v = document.createElement('video');
  v.src = url; v.playsInline = true; v.preload = 'auto';
  await within(15000, 'Opening the source file', (res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Could not open the source file.')); });
  return v;
}
export async function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 0.01 && v.readyState >= 2) return;
  v.currentTime = t;
  await within(10000, 'Seeking', (res) => { v.onseeked = res; });
}

// job = { clip (frozen: ranges, title, overlay), style (effective), urls: {srcId: url},
//         segments: {srcId: [...]}, overlayUrl, overlayKind }
// returns { blob, framing: 'followed' | 'fixed' | 'none', width, height }
export async function exportClip(job, { onProgress, signal } = {}) {
  if (!exportMime) throw new Error('This browser cannot record video (no MediaRecorder).');
  const { clip, style } = job;
  const speed = style.speed || 1;
  const vids = {};
  let ac = null, stream = null, rec = null, backup = null, ovEl = null;
  const check = () => { if (signal?.aborted) throw abortErr(); };
  try {
    for (const r of clip.ranges) if (!vids[r.src]) vids[r.src] = await openVideo(job.urls[r.src]);
    check();
    const first = vids[clip.ranges[0].src];
    const hasVideo = first.videoWidth > 0;
    const { w: W, h: H } = outSize(style, first.videoWidth, first.videoHeight);

    // Follow the speaker: track faces per range before recording.
    const follows = [];
    let framing = hasVideo && style.layout === 'auto' ? 'fixed' : 'none';
    if (hasVideo && style.layout === 'auto' && !style.rotate) {
      for (let i = 0; i < clip.ranges.length; i++) {
        const r = clip.ranges[i], v = vids[r.src];
        try {
          follows[i] = job.follows?.[i] !== undefined ? job.follows[i] : await trackSpeaker(job.urls[r.src], r, cropFraction(style, v.videoWidth, v.videoHeight),
            (p) => onProgress?.((i + p) / clip.ranges.length, 'Finding the speaker'), signal);
        } catch (e) { if (e.name === 'AbortError') throw e; console.warn('[omniclip] face tracking unavailable', e); follows[i] = null; }
        check();
      }
      if (follows.some(Boolean)) framing = 'followed';
    }

    if (job.overlayUrl) {
      ovEl = job.overlayKind === 'video' ? await openVideo(job.overlayUrl) : await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Could not open the overlay image.')); im.src = job.overlayUrl; });
      if (ovEl.tagName === 'VIDEO') { ovEl.muted = true; ovEl.loop = true; }
    }

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Audio: every source feeds one gain node (clip gain, mute, fades) -> recorder.
    ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const gain = ac.createGain();
    const analyser = ac.createAnalyser();
    analyser.fftSize = 128;
    gain.connect(dest); gain.connect(analyser);
    for (const v of Object.values(vids)) ac.createMediaElementSource(v).connect(gain);
    const level = style.mute ? 0 : Math.pow(10, (style.gain || 0) / 20);
    const levels = new Uint8Array(analyser.frequencyBinCount);

    const wordsBy = clip.ranges.map((r) => clipWords(job.segments[r.src] || [], r.start, r.end));
    const groupsBy = wordsBy.map((w) => groupWords(w, style.words || 3));
    const total = clip.ranges.reduce((s, r) => s + (r.end - r.start) / speed, 0);
    let done = 0; // output seconds finished before the current range

    stream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
    rec = new MediaRecorder(stream, { mimeType: exportMime, videoBitsPerSecond: W * H >= 1920 * 1080 * 0.9 ? 8_000_000 : 5_000_000, audioBitsPerSecond: 160_000 });
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    await ac.resume();

    for (let i = 0; i < clip.ranges.length; i++) {
      const r = clip.ranges[i], v = vids[r.src];
      v.playbackRate = speed; v.preservesPitch = true;
      await seek(v, r.start);
      check();
      const frame = (st) => {
        const seqT = done + (st - r.start) / speed;
        let g = level; // fades follow the output timeline
        if (style.fadeIn) g *= Math.min(1, seqT / style.fadeIn);
        if (style.fadeOut) g *= Math.min(1, Math.max(0, total - seqT) / style.fadeOut);
        gain.gain.setTargetAtTime(g, ac.currentTime, 0.015);
        if (!hasVideo) analyser.getByteFrequencyData(levels);
        if (ovEl?.tagName === 'VIDEO' && ovEl.paused) ovEl.play().catch(() => {});
        compose(ctx, W, H, {
          media: hasVideo ? v : null, mw: v.videoWidth, mh: v.videoHeight, st, seqT, dur: total,
          style, title: clip.title, words: wordsBy[i], groups: groupsBy[i], levels: hasVideo ? null : levels,
          follow: follows[i] || null, overlay: clip.overlay, overlayEl: ovEl,
        });
        onProgress?.(Math.min(1, seqT / total), 'Recording');
      };
      frame(r.start);
      if (i === 0) rec.start(1000); else rec.resume();
      await v.play().catch((e) => { throw new Error(`The browser refused to play the source (${e.message}).`); });
      let lastT = -1, stalls = 0;
      await new Promise((resolve, reject) => {
        let finished = false;
        const next = (fn) => (hasVideo && v.requestVideoFrameCallback) ? v.requestVideoFrameCallback(fn) : requestAnimationFrame(fn);
        const tick = () => {
          if (finished) return true;
          if (signal?.aborted) { finished = true; clearInterval(backup); reject(abortErr()); return true; }
          frame(Math.min(v.currentTime, r.end));
          if (v.currentTime >= r.end || v.ended) { finished = true; clearInterval(backup); resolve(); return true; }
          return false;
        };
        backup = setInterval(() => {
          // Keeps drawing if frame callbacks stall; gives up if playback stops moving for ~8 s.
          if (v.currentTime === lastT && !v.paused) {
            if (++stalls > 32) { finished = true; clearInterval(backup); reject(new Error('Playback stalled. Keep this tab visible while exporting.')); return; }
          } else stalls = 0;
          lastT = v.currentTime;
          tick();
        }, 250);
        const loop = () => { if (!tick()) next(loop); };
        next(loop);
      });
      v.pause();
      if (i < clip.ranges.length - 1) rec.pause();
      done += (r.end - r.start) / speed;
    }
    rec.stop();
    await within(10000, 'Finishing the file', (res) => stopped.then(res));
    return { blob: new Blob(parts, { type: exportMime.split(';')[0] }), framing, width: W, height: H };
  } finally {
    // Always release the recorder, audio graph and media, also after errors or cancel.
    clearInterval(backup);
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* already stopped */ }
    stream?.getTracks().forEach((tr) => tr.stop());
    ac?.close().catch(() => {});
    for (const v of Object.values(vids)) { v.pause(); v.removeAttribute('src'); v.load(); }
    if (ovEl?.tagName === 'VIDEO') { ovEl.pause(); ovEl.removeAttribute('src'); ovEl.load(); }
  }
}
