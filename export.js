// Clip export: renders a vertical 9:16 short with burned-in captions on a
// canvas while the source plays, and records canvas + audio with the
// browser's own encoder (MediaRecorder). Everything stays on the device.
//
// Runs in real time (a 30 s clip takes ~30 s), so the tab must stay visible.

import { trackSpeaker } from './reframe.js';

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

// ---------- word timings ----------
// Whisper gives timed segments; spread each segment's time over its words by
// character position to get word timings good enough for captions.
export function clipWords(segments, start, end) {
  const words = [];
  for (const s of segments) {
    if (s.end <= start || s.start >= end) continue;
    const re = /\S+/g;
    const len = s.text.length || 1;
    let m;
    while ((m = re.exec(s.text))) {
      const t0 = s.start + ((s.end - s.start) * m.index) / len;
      const t1 = s.start + ((s.end - s.start) * (m.index + m[0].length)) / len;
      if (t1 > start && t0 < end) words.push({ t0, t1, w: m[0] });
    }
  }
  return words;
}

// Group words into short caption chunks (max 3 words, break after punctuation).
function chunks(words, max = 3) {
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= max || /[.!?,;:]$/.test(w.w)) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out.map((ws) => ({ t0: ws[0].t0, t1: ws[ws.length - 1].t1, words: ws }));
}

// ---------- drawing ----------
function drawCaptionsPop(ctx, W, H, groups, t, y) {
  const g = groups.find((c) => t >= c.t0 && t < c.t1 + 0.15) || null;
  if (!g) return;
  let size = Math.round(W * 0.085);
  const font = (s) => `900 ${s}px system-ui, "Segoe UI", Arial, sans-serif`;
  const texts = g.words.map((w) => w.w.toUpperCase().replace(/[,;:]$/, ''));
  const measure = () => {
    ctx.font = font(size);
    return texts.reduce((s, x) => s + ctx.measureText(x).width, 0) + size * 0.35 * (texts.length - 1);
  };
  let width = measure();
  if (width > W * 0.88) { size = Math.floor((size * (W * 0.88)) / width); width = measure(); }
  const space = size * 0.35;
  let x = (W - width) / 2;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, size * 0.16);
  g.words.forEach((w, i) => {
    // The spoken word turns yellow and lifts slightly (no scaling, so it never
    // collides with its neighbours).
    const active = t >= w.t0 && t < w.t1 + 0.05;
    const yy = active ? y - size * 0.06 : y;
    ctx.strokeStyle = '#000';
    ctx.strokeText(texts[i], x, yy);
    ctx.fillStyle = active ? '#ffd400' : '#fff';
    ctx.fillText(texts[i], x, yy);
    x += ctx.measureText(texts[i]).width + space;
  });
}

// Title card at the top of the frame (first seconds, or the whole clip).
function drawTitle(ctx, W, H, title, alpha) {
  if (!title || alpha <= 0) return;
  const size = Math.round(W * 0.058);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `800 ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
  const lines = wrap(ctx, title, W * 0.8).slice(0, 2);
  const lh = size * 1.25;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 1.2;
  const boxH = lh * lines.length + size * 0.7;
  const y0 = H * 0.09;
  ctx.fillStyle = '#fff';
  roundRect(ctx, (W - boxW) / 2, y0, boxW, boxH, size * 0.35);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'middle';
  lines.forEach((l, k) => ctx.fillText(l, (W - ctx.measureText(l).width) / 2, y0 + size * 0.35 + lh * (k + 0.5)));
  ctx.restore();
}

function wrap(ctx, text, maxW) {
  const lines = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawCaptionsClassic(ctx, W, H, words, t, y) {
  // Show the words of the current ~sentence window (up to 2 lines).
  const i = words.findIndex((w) => t >= w.t0 && t < w.t1 + 0.3);
  if (i < 0) return;
  const from = Math.floor(i / 8) * 8;
  const text = words.slice(from, from + 8).map((w) => w.w).join(' ');
  const size = Math.round(W * 0.05);
  ctx.font = `700 ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
  const lines = wrap(ctx, text, W * 0.84).slice(0, 2);
  const lh = size * 1.3;
  const boxH = lh * lines.length + size * 0.6;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size;
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  roundRect(ctx, (W - boxW) / 2, y - boxH / 2, boxW, boxH, size * 0.3);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  lines.forEach((l, k) => {
    ctx.fillText(l, (W - ctx.measureText(l).width) / 2, y - boxH / 2 + size * 0.3 + lh * (k + 0.5));
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Audio-only sources become an "audiogram": title + live level bars.
function drawAudiogram(ctx, W, H, title, analyser, bins) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1d1f27');
  g.addColorStop(1, '#3a1810');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const size = Math.round(W * 0.075);
  ctx.font = `800 ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  wrap(ctx, title, W * 0.84).slice(0, 3).forEach((l, i) => {
    ctx.fillText(l, (W - ctx.measureText(l).width) / 2, H * 0.16 + i * size * 1.2);
  });
  analyser.getByteFrequencyData(bins);
  const n = 28, bw = (W * 0.8) / n, cy = H * 0.47;
  ctx.fillStyle = '#ff5a36';
  for (let i = 0; i < n; i++) {
    const v = bins[2 + i * 2] / 255;
    const h = Math.max(W * 0.01, v * H * 0.16);
    roundRect(ctx, W * 0.1 + i * bw + bw * 0.2, cy - h / 2, bw * 0.6, h, bw * 0.3);
    ctx.fill();
  }
}

// ---------- export ----------
// opts: { width, height, layout: 'crop'|'blur', pos: 0..1, captions: 'pop'|'classic'|'none' }
export async function exportClip({ url, clip, segments, opts, onProgress }) {
  if (!exportMime) throw new Error('This browser cannot record video (no MediaRecorder).');
  const W = opts.width, H = opts.height;
  const v = document.createElement('video');
  v.src = url;
  v.playsInline = true;
  v.preload = 'auto';
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Could not open the source file.')); });
  const hasVideo = v.videoWidth > 0;

  // Auto layout: find the speaker first, then crop to follow them.
  let follow = null;
  if (hasVideo && opts.layout === 'auto') {
    const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
    const cropFrac = W / scale / v.videoWidth;
    try {
      follow = await trackSpeaker(url, clip, cropFrac, (p) => onProgress?.(p, 'Finding the speaker…'));
    } catch (e) { console.warn('[omniclip] face tracking unavailable', e); }
    console.log(`[omniclip] auto-reframe: ${follow ? 'following the speaker' : 'no face found, using the crop position'}`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // Small canvas for the blurred background: drawing tiny and scaling up is a
  // cheap blur, far lighter than ctx.filter on weak GPUs.
  const small = document.createElement('canvas');
  small.width = 54; small.height = 96;
  const sctx = small.getContext('2d');

  const ac = new AudioContext();
  const src = ac.createMediaElementSource(v);
  const dest = ac.createMediaStreamDestination();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 128;
  src.connect(dest);
  src.connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount);

  const words = clipWords(segments, clip.start, clip.end);
  const groups = chunks(words);
  const capY = opts.layout === 'blur' && hasVideo ? H * 0.78 : H * 0.72;
  // (crop and auto share the same drawing path; auto just moves the crop)

  const draw = () => {
    const t = v.currentTime;
    if (!hasVideo) {
      drawAudiogram(ctx, W, H, clip.title, analyser, bins);
    } else {
      const vw = v.videoWidth, vh = v.videoHeight;
      if (opts.layout === 'blur') {
        sctx.drawImage(v, 0, 0, small.width, small.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(small, 0, 0, W, H);
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.fillRect(0, 0, W, H);
        const h = (W * vh) / vw;
        ctx.drawImage(v, 0, (H - h) / 2 - H * 0.04, W, h);
      } else {
        const scale = Math.max(W / vw, H / vh);
        const sw = W / scale, sh = H / scale;
        const pos = follow ? follow(t) : opts.pos;
        const sx = (vw - sw) * pos, sy = (vh - sh) / 2;
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
      }
    }
    if (opts.captions === 'pop') drawCaptionsPop(ctx, W, H, groups, t, capY);
    else if (opts.captions === 'classic') drawCaptionsClassic(ctx, W, H, words, t, capY);
    if (hasVideo && opts.title !== 'none') {
      const since = t - clip.start;
      const alpha = opts.title === 'always' ? 1 : Math.max(0, Math.min(1, 3.5 - since)); // fade out after ~3 s
      drawTitle(ctx, W, H, clip.title, alpha);
    }
  };

  v.currentTime = clip.start;
  await new Promise((r) => { v.onseeked = r; });
  draw();

  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  const rec = new MediaRecorder(stream, {
    mimeType: exportMime,
    videoBitsPerSecond: W >= 1080 ? 8_000_000 : 5_000_000,
    audioBitsPerSecond: 160_000,
  });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise((r) => { rec.onstop = r; });

  await ac.resume();
  rec.start(1000);
  await v.play();

  await new Promise((resolve) => {
    // Video frames drive drawing when there are any; otherwise animation frames.
    const next = (fn) => (hasVideo && v.requestVideoFrameCallback) ? v.requestVideoFrameCallback(fn) : requestAnimationFrame(fn);
    const backup = setInterval(() => tick(), 250); // keeps going if frames stall
    let finished = false;
    function tick() {
      if (finished) return true; // a frame callback can still fire after the end
      draw();
      onProgress?.(Math.min(1, (v.currentTime - clip.start) / (clip.end - clip.start)), 'Recording…');
      if (v.currentTime >= clip.end || v.ended) { finished = true; clearInterval(backup); resolve(); return true; }
      return false;
    }
    const loop = () => { if (!tick()) next(loop); };
    next(loop);
  });

  v.pause();
  rec.stop();
  await stopped;
  stream.getTracks().forEach((tr) => tr.stop());
  ac.close();
  v.removeAttribute('src');
  v.load();
  return new Blob(parts, { type: exportMime.split(';')[0] });
}
