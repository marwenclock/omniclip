// Small helpers: subtitles (SRT/VTT), a ZIP writer, audio peaks and pause detection.

// ---------- subtitles ----------
export function srtTime(t, sep = ',') {
  const total = Math.max(0, Math.round(t * 1000)); // round once, then split: 59.9996 s -> 00:01:00,000
  const h = Math.floor(total / 3600000), m = Math.floor(total / 60000) % 60, s = Math.floor(total / 1000) % 60, ms = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms).padStart(3, '0')}`;
}
export const toSRT = (cues) => cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');

// Parses SRT or WebVTT. Returns [{start, end, text}] or throws a readable error.
export function parseSubtitles(text) {
  const src = text.replace(/^﻿/, '').replace(/\r/g, '');
  const ts = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  const sec = (m) => (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000;
  const cues = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const ma = a.match(ts), mb = b?.match(ts);
    if (!ma || !mb) continue;
    const textLines = lines.slice(i + 1).map((l) => l.replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim()).filter(Boolean);
    const start = sec(ma), end = sec(mb);
    if (!textLines.length || !(end > start)) continue;
    cues.push({ start, end, text: textLines.join(' ') });
  }
  if (!cues.length) throw new Error('No subtitles were found in this file. OMNICLIP reads .srt and .vtt files.');
  return cues.sort((x, y) => x.start - y.start);
}

// ---------- ZIP (stored, no compression: video is already compressed) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export async function zip(files) { // files: [{ name, blob }]
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); // UTF-8 names
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, b) => s + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---------- audio peaks and pauses ----------
// audio: Float32Array mono at `rate` Hz. Returns peak per 1/100 s (0..1).
export function peaks(audio, rate = 16000, perSec = 100) {
  const step = Math.max(1, Math.floor(rate / perSec));
  const out = new Float32Array(Math.ceil(audio.length / step));
  for (let i = 0; i < out.length; i++) {
    let m = 0;
    const a = i * step, b = Math.min(audio.length, a + step);
    for (let j = a; j < b; j += 2) { const v = Math.abs(audio[j]); if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}
// Quiet stretches longer than minLen inside [start, end], keeping `pad` seconds of air at each side.
export function findPauses(pk, start, end, { threshold = 0.02, minLen = 0.7, pad = 0.15, perSec = 100 } = {}) {
  const out = [];
  let q = -1;
  const a = Math.floor(start * perSec), b = Math.min(pk.length, Math.ceil(end * perSec));
  for (let i = a; i <= b; i++) {
    const quiet = i < b && pk[i] < threshold;
    if (quiet && q < 0) q = i;
    if (!quiet && q >= 0) {
      const s = q / perSec + pad, e = i / perSec - pad;
      if (e - s >= minLen - 2 * pad && s > start + 0.05 && e < end - 0.05) out.push({ start: s, end: e });
      q = -1;
    }
  }
  return out;
}
