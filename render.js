// One compositor for everything a short shows: the Output monitor and the
// exported file call the same compose(), so what you preview is what you get.
// All sizes are relative to the canvas, so it draws at any resolution.

// ---------- styles ----------
export const DEFAULT_STYLE = {
  aspect: '9:16', res: 1080,
  layout: 'auto', pos: 0.5, posY: 0.5, zoom: 1, rotate: 0, flip: false,
  captions: 'pop', font: 'sans', weight: 900, case: 'upper', size: 1, y: 0.72,
  color: '#ffffff', hi: '#ffd400', outline: 'stroke', words: 3, dir: 'auto',
  title: 'intro', titleDur: 3, titleY: 0.09,
  gain: 0, mute: false, fadeIn: 0, fadeOut: 0, speed: 1,
};

export const PRESETS = {
  bold: { label: 'Bold pop', captions: 'pop', font: 'sans', weight: 900, case: 'upper', size: 1, color: '#ffffff', hi: '#ffd400', outline: 'stroke', words: 3 },
  clean: { label: 'Clean', captions: 'pop', font: 'sans', weight: 700, case: 'none', size: 0.85, color: '#ffffff', hi: '#ffffff', outline: 'shadow', words: 4 },
  boxed: { label: 'Boxed', captions: 'classic', font: 'sans', weight: 700, case: 'none', size: 0.9, color: '#ffffff', hi: '#ffffff', outline: 'box', words: 8 },
  karaoke: { label: 'Karaoke', captions: 'pop', font: 'rounded', weight: 800, case: 'none', size: 1, color: '#bdbdbd', hi: '#ffffff', outline: 'stroke', words: 4 },
  minimal: { label: 'Minimal', captions: 'classic', font: 'serif', weight: 500, case: 'none', size: 0.8, color: '#ffffff', hi: '#ffffff', outline: 'shadow', words: 8 },
  neon: { label: 'Neon', captions: 'pop', font: 'sans', weight: 900, case: 'upper', size: 1.05, color: '#ffffff', hi: '#39ff88', outline: 'stroke', words: 2 },
};
export const CAPTION_KEYS = ['captions', 'font', 'weight', 'case', 'size', 'y', 'color', 'hi', 'outline', 'words', 'dir'];

const FONTS = {
  sans: 'system-ui, "Segoe UI", Arial, sans-serif',
  geist: 'Geist, system-ui, sans-serif',
  rounded: '"Arial Rounded MT Bold", "Nunito", "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Geist Mono", ui-monospace, Consolas, monospace',
};
export const FONT_LABELS = { sans: 'Bold sans', geist: 'Geist', rounded: 'Rounded', serif: 'Serif', mono: 'Mono' };

// ---------- output size ----------
const RATIOS = { '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5], '16:9': [16, 9] };
export function outSize(style, mw = 0, mh = 0) {
  const short = style.res || 1080;
  let [a, b] = RATIOS[style.aspect] || [0, 0];
  if (!a) { // original: the source's own shape (after rotation)
    if (!mw || !mh) [a, b] = [9, 16];
    else [a, b] = style.rotate % 180 ? [mh, mw] : [mw, mh];
  }
  const even = (x) => Math.round(x / 2) * 2;
  return a <= b ? { w: even(short), h: even((short * b) / a) } : { w: even((short * a) / b), h: even(short) };
}

// ---------- words and caption groups ----------
// Whisper gives timed segments; each segment's time is spread over its words
// by character position. These are estimates, good enough for captions.
export function clipWords(segments, start, end) {
  const words = [];
  for (const s of segments || []) {
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
export function groupWords(words, max = 3) {
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= max || /[.!?,;:،؟]$/.test(w.w)) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out.map((ws) => ({ t0: ws[0].t0, t1: ws[ws.length - 1].t1, words: ws }));
}
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const isRTL = (style, words) => style.dir === 'rtl' || (style.dir !== 'ltr' && words.some((w) => RTL.test(w.w)));

// ---------- primitives ----------
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
const font = (style, px) => `${style.weight || 800} ${px}px ${FONTS[style.font] || FONTS.sans}`;
const cased = (style, s) => (style.case === 'upper' ? s.toLocaleUpperCase() : s);

function textFx(ctx, style, size) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, size * 0.16);
  ctx.strokeStyle = '#000';
  if (style.outline === 'shadow') { ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = size * 0.25; ctx.shadowOffsetY = size * 0.05; }
}
function noFx(ctx) { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; }

// ---------- captions ----------
function drawPop(ctx, W, H, style, groups, t) {
  const g = groups.find((c) => t >= c.t0 && t < c.t1 + 0.15);
  if (!g) return;
  const y = H * style.y;
  let size = Math.round(Math.min(W, H * 0.5625) * 0.085 * style.size);
  const texts = g.words.map((w) => cased(style, w.w).replace(/[,;:،]$/, ''));
  const measure = () => { ctx.font = font(style, size); return texts.reduce((s, x) => s + ctx.measureText(x).width, 0) + size * 0.35 * (texts.length - 1); };
  let width = measure();
  if (width > W * 0.88) { size = Math.floor((size * (W * 0.88)) / width); width = measure(); }
  const space = size * 0.35;
  const rtl = isRTL(style, g.words);
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = 'left';
  if (style.outline === 'box') {
    ctx.fillStyle = 'rgba(0,0,0,.62)';
    roundRect(ctx, (W - width) / 2 - size * 0.4, y - size * 0.75, width + size * 0.8, size * 1.5, size * 0.3);
    ctx.fill();
  }
  textFx(ctx, style, size);
  // Right-to-left scripts read from the right, so their words are laid out from the right edge.
  let x = rtl ? (W + width) / 2 : (W - width) / 2;
  g.words.forEach((w, i) => {
    const active = t >= w.t0 && t < w.t1 + 0.05;
    const yy = active ? y - size * 0.06 : y;
    const ww = ctx.measureText(texts[i]).width;
    const xx = rtl ? x - ww : x;
    if (style.outline === 'stroke') ctx.strokeText(texts[i], xx, yy);
    ctx.fillStyle = active ? style.hi : style.color;
    ctx.fillText(texts[i], xx, yy);
    x += (rtl ? -1 : 1) * (ww + space);
  });
  ctx.restore();
}

function drawClassic(ctx, W, H, style, words, t) {
  const i = words.findIndex((w) => t >= w.t0 && t < w.t1 + 0.3);
  if (i < 0) return;
  const n = Math.max(4, style.words || 8);
  const from = Math.floor(i / n) * n;
  const text = cased(style, words.slice(from, from + n).map((w) => w.w).join(' '));
  const size = Math.round(Math.min(W, H * 0.5625) * 0.05 * style.size);
  const y = H * style.y;
  ctx.save();
  ctx.font = font(style, size);
  ctx.direction = isRTL(style, words.slice(from, from + n)) ? 'rtl' : 'ltr';
  ctx.textAlign = 'center';
  const lines = wrap(ctx, text, W * 0.84).slice(0, 2);
  const lh = size * 1.3;
  const boxH = lh * lines.length + size * 0.6;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size;
  if (style.outline === 'box') {
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    roundRect(ctx, (W - boxW) / 2, y - boxH / 2, boxW, boxH, size * 0.3);
    ctx.fill();
  }
  textFx(ctx, style, size);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = style.color;
  lines.forEach((l, k) => {
    const yy = y - boxH / 2 + size * 0.3 + lh * (k + 0.5);
    if (style.outline === 'stroke') ctx.strokeText(l, W / 2, yy);
    ctx.fillText(l, W / 2, yy);
  });
  ctx.restore();
}

// ---------- title card ----------
function drawTitle(ctx, W, H, style, title, alpha) {
  if (!title || alpha <= 0) return;
  const size = Math.round(Math.min(W, H * 0.5625) * 0.058);
  ctx.save();
  noFx(ctx);
  ctx.globalAlpha = alpha;
  ctx.font = `800 ${size}px ${FONTS.sans}`;
  ctx.direction = RTL.test(title) ? 'rtl' : 'ltr';
  ctx.textAlign = 'center';
  const lines = wrap(ctx, title, W * 0.8).slice(0, 2);
  const lh = size * 1.25;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 1.2;
  const boxH = lh * lines.length + size * 0.7;
  const y0 = H * style.titleY;
  ctx.fillStyle = '#fff';
  roundRect(ctx, (W - boxW) / 2, y0, boxW, boxH, size * 0.35);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'middle';
  lines.forEach((l, k) => ctx.fillText(l, W / 2, y0 + size * 0.35 + lh * (k + 0.5)));
  ctx.restore();
  return { top: y0, bottom: y0 + boxH };
}

// ---------- audiogram (audio-only sources) ----------
function drawAudiogram(ctx, W, H, style, title, levels) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1a1a1a');
  g.addColorStop(1, '#050505');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const size = Math.round(Math.min(W, H * 0.5625) * 0.075);
  if (title && style.title !== 'none') {
    ctx.font = `800 ${size}px ${FONTS.sans}`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    wrap(ctx, title, W * 0.84).slice(0, 3).forEach((l, i) => ctx.fillText(l, W / 2, H * 0.16 + i * size * 1.2));
    ctx.textAlign = 'left';
  }
  const n = 28, bw = (W * 0.8) / n, cy = H * 0.47;
  ctx.fillStyle = '#f5f5f5';
  for (let i = 0; i < n; i++) {
    const v = levels ? levels[2 + i * 2] / 255 : 0.15 + 0.1 * Math.abs(Math.sin(i * 1.7));
    const h = Math.max(W * 0.01, v * H * 0.16);
    roundRect(ctx, W * 0.1 + i * bw + bw * 0.2, cy - h / 2, bw * 0.6, h, bw * 0.3);
    ctx.fill();
  }
}

// ---------- source framing ----------
// Draws media into the W x H frame with rotation/flip, crop position and zoom.
const small = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: 54, height: 96 }) : null;
function drawMedia(ctx, W, H, media, mw, mh, style, posX) {
  const rot = ((style.rotate || 0) % 360 + 360) % 360;
  const sideways = rot % 180 !== 0;
  const rw = sideways ? mh : mw, rh = sideways ? mw : mh; // displayed (rotated) size
  const place = (dx, dy, dw, dh) => {
    // Draw the media so that its rotated image fills the box (dx, dy, dw, dh).
    ctx.save();
    ctx.translate(dx + dw / 2, dy + dh / 2);
    ctx.rotate((rot * Math.PI) / 180);
    if (style.flip) ctx.scale(-1, 1);
    const w = sideways ? dh : dw, h = sideways ? dw : dh;
    ctx.drawImage(media, -w / 2, -h / 2, w, h);
    ctx.restore();
  };
  const layout = style.layout;
  if (layout === 'blur' || layout === 'fit') {
    if (layout === 'blur') {
      const s = Math.max(small.width / rw, small.height / rh);
      const sctx = small.getContext('2d');
      sctx.save();
      sctx.translate(small.width / 2, small.height / 2);
      sctx.rotate((rot * Math.PI) / 180);
      if (style.flip) sctx.scale(-1, 1);
      sctx.drawImage(media, (-mw * s) / 2, (-mh * s) / 2, mw * s, mh * s);
      sctx.restore();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(small, 0, 0, W, H);
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    }
    const s = Math.min(W / rw, H / rh) * (style.zoom || 1);
    const dw = rw * s, dh = rh * s;
    place((W - dw) / 2, (H - dh) / 2 - (layout === 'blur' && H > W ? H * 0.04 : 0), dw, dh);
    return;
  }
  // crop / auto: cover the frame, positioned by posX / posY
  const s = Math.max(W / rw, H / rh) * (style.zoom || 1);
  const dw = rw * s, dh = rh * s;
  const x = (W - dw) * posX, y = (H - dh) * (style.posY ?? 0.5);
  place(x, y, dw, dh);
}

// Fraction of the source width that the crop shows (used by speaker tracking and the crop guide).
export function cropFraction(style, mw, mh) {
  const { w, h } = outSize(style, mw, mh);
  const sideways = (style.rotate || 0) % 180 !== 0;
  const rw = sideways ? mh : mw, rh = sideways ? mw : mh;
  const s = Math.max(w / rw, h / rh) * (style.zoom || 1);
  return Math.min(1, w / s / rw);
}

// ---------- overlay layer ----------
function drawOverlay(ctx, W, H, ov, el, seqT) {
  if (!ov || !el) return;
  if (seqT < (ov.start || 0) || (ov.end && seqT > ov.end)) return;
  const iw = el.videoWidth || el.naturalWidth || el.width, ih = el.videoHeight || el.naturalHeight || el.height;
  if (!iw || !ih) return;
  const w = W * (ov.w || 0.3), h = (w * ih) / iw;
  ctx.save();
  ctx.globalAlpha = ov.opacity ?? 1;
  ctx.drawImage(el, (W - w) * (ov.x ?? 0.95), (H - h) * (ov.y ?? 0.05), w, h);
  ctx.restore();
}

// ---------- safe-area guides (monitor only, never exported) ----------
function drawGuides(ctx, W, H, style, titleBox) {
  ctx.save();
  ctx.setLineDash([Math.max(4, W * 0.012), Math.max(4, W * 0.012)]);
  ctx.lineWidth = Math.max(1, W * 0.002);
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  // Platform UI covers roughly the top 10 %, bottom 20 % and right 12 % of vertical video.
  ctx.strokeRect(W * 0.06, H * 0.08, W * 0.82, H * 0.72);
  const capTop = H * style.y - H * 0.05, capBottom = H * style.y + H * 0.05;
  if (titleBox && style.captions !== 'none' && titleBox.bottom > capTop && titleBox.top < capBottom) {
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ff6b5e';
    ctx.lineWidth = Math.max(2, W * 0.004);
    ctx.strokeRect(W * 0.04, capTop, W * 0.92, capBottom - capTop);
  }
  ctx.restore();
}

// ---------- the frame ----------
// f = { media, mw, mh, st (source time), seqT (time since the short began), dur (short length),
//       style, title, words, groups, levels, follow (t -> pos | null), overlay, overlayEl, guides }
export function compose(ctx, W, H, f) {
  const style = f.style;
  ctx.save();
  noFx(ctx);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!f.media || !f.mw) drawAudiogram(ctx, W, H, style, f.title, f.levels);
  else drawMedia(ctx, W, H, f.media, f.mw, f.mh, style, style.layout === 'auto' && f.follow ? f.follow(f.st) : style.pos);
  drawOverlay(ctx, W, H, f.overlay, f.overlayEl, f.seqT);
  if (style.captions === 'pop') drawPop(ctx, W, H, style, f.groups || [], f.st);
  else if (style.captions === 'classic') drawClassic(ctx, W, H, style, f.words || [], f.st);
  let titleBox = null;
  if (f.mw && style.title !== 'none') {
    const fade = f.dur ? Math.min(1, Math.max(0, f.dur - f.seqT) * 4) : 1; // never flash the title at the very end
    const alpha = style.title === 'always' ? 1 : Math.max(0, Math.min(1, style.titleDur + 0.5 - f.seqT));
    titleBox = drawTitle(ctx, W, H, style, f.title, Math.min(alpha, style.title === 'always' ? 1 : fade));
  }
  if (f.guides) drawGuides(ctx, W, H, style, titleBox || (style.title !== 'none' && f.title ? { top: H * style.titleY, bottom: H * style.titleY + H * 0.06 } : null));
  ctx.restore();
}
