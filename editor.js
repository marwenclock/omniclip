// The editor: clip bin, Source/Output monitor, inspector, timeline, transcript,
// export queue and keyboard. Edits go through project.js (undoable, autosaved);
// what the monitor shows is drawn by render.js, the same code the export uses.
import {
  P, onChange, tx, quiet, endGesture, undo, redo, canUndo, canRedo, undoLabel, redoLabel, saveState, saveNow,
  makeClip, effStyle, clipDuration, seqToSource, sourceToSeq, speedOf, rangeLen, uid, sourceById, dbPut, dbGet, projectFile,
} from './project.js';
import { compose, outSize, clipWords, groupWords, PRESETS, CAPTION_KEYS, FONT_LABELS, DEFAULT_STYLE, cropFraction } from './render.js';
import { exportClip, exportMime, exportExt, openVideo, seek as seekVideo } from './export.js';
import { trackSpeaker } from './reframe.js';
import { shortTitle } from './clips.js';
import { Timeline } from './timeline.js';
import { toSRT, zip, findPauses, parseSubtitles } from './tools.js';

const $ = (id) => document.getElementById(id);
const qs = (s, el = document) => el.querySelector(s);
const qsa = (s, el = document) => [...el.querySelectorAll(s)];
export const tc = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };
export const fmt = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
export const mb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(b < 1e7 ? 1 : 0) + ' MB');
export const parseTime = (txt) => {
  const p = String(txt).trim().replace(',', '.').split(':').map(Number);
  if (!p.length || p.some((x) => !Number.isFinite(x) || x < 0)) return NaN;
  return p.reduce((a, x) => a * 60 + x, 0);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MIN_LEN = 0.5; // seconds: the shortest range anywhere
const ICON = {
  down: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10m0 0-4-4m4 4 4-4M4 16h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dup: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  del: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 6h10M8 6V4.5h4V6M6.5 6l.7 9.5h5.6l.7-9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10l8-5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 5h2.5v10H6.5zM11 5h2.5v10H11z" fill="currentColor"/></svg>',
};

// ---------- runtime state (not saved) ----------
export const R = {
  urls: {}, files: {}, peaks: {}, selId: null, ri: 0, playT: 0, playing: false, view: 'output',
  inMark: null, outMark: null, follow: {}, framing: {}, ovEls: {}, thumbs: new Map(), pick: null,
  hooks: {}, jobs: [], fast: localStorage.getItem('omniclip:fast') === '1', singleKeys: localStorage.getItem('omniclip:keys') !== '0',
};
export const setStatus = (t) => { $('status').textContent = t; };
export const announce = (t) => { setStatus(t); const a = $('announce'); a.textContent = ''; setTimeout(() => { a.textContent = t; }, 50); };
const project = () => P.project;
export const selClip = () => project()?.clips.find((c) => c.id === R.selId) || null;
const clipById = (p, id) => p.clips.find((c) => c.id === id);
const mainSrc = () => project()?.sources[0];
const segsOf = (srcId) => project()?.segments[srcId] || [];
export const safeName = (title) => {
  const stem = (title || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 48);
  return stem || 'clip';
};
export function saveFile(name, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
const base = () => safeName(project()?.name || 'video');

// ---------- small dialogs ----------
export function ask(title, body, buttons) {
  return new Promise((res) => {
    const d = $('ask');
    $('askTitle').textContent = title;
    $('askBody').innerHTML = body;
    const acts = $('askActions');
    acts.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button'; el.className = `btn ${b.solid ? 'btn-solid' : 'btn-outline'}`; el.textContent = b.label;
      el.onclick = () => { d.close(); res(b.value ?? b.label); };
      acts.append(el);
    }
    d.onclose = () => res(null);
    d.showModal();
    qs('input', d)?.focus();
  });
}
function notice(html, action, onAction) {
  const n = $('notice');
  qs('p', n).innerHTML = html;
  const b = qs('button', n);
  b.hidden = !action; b.textContent = action || ''; b.onclick = () => { n.hidden = true; onAction?.(); };
  n.hidden = false;
}
export { notice };

// ============================================================ open a project
let wired = false;
export function openEditor() {
  if (!wired) { wire(); wired = true; }
  document.body.classList.add('working');
  $('setup').hidden = true; $('work').hidden = false; $('topFile').hidden = false;
  $('newVideo').hidden = false; qs('.work-only').hidden = false;
  if (!selClip()) R.selId = project().clips[0]?.id || null;
  renderAll({ type: 'load' });
  selectClip(R.selId, { quiet: true });
}

// ============================================================ render
let structSig = '';
onChange((why) => {
  if (!project()) return;
  if (why.type === 'save') { renderSave(); return; }
  renderAll(why);
});
function renderAll(why = {}) {
  if (!project() || $('work').hidden) return;
  if (R.selId && !selClip()) R.selId = project().clips[0]?.id || null;
  renderHeader();
  renderBin();
  renderInspector();
  renderTimeline();
  if (['load', 'undo', 'redo', 'segments', 'import'].includes(why.type) || R.transcriptSrc !== transcriptSrc()) renderTranscript();
  else highlightTranscript();
  renderMedia();
  renderSave();
  layoutCrop();
  renderTransport();
  requestDraw();
}

function renderHeader() {
  const p = project(), s = mainSrc();
  if (document.activeElement !== $('projName')) $('projName').value = p.name;
  $('fileMeta').textContent = s ? `${s.duration ? fmt(s.duration) + ' · ' : ''}${mb(s.size)}${p.sources.length > 1 ? ` · ${p.sources.length} videos` : ''}` : '';
  $('undoBtn').disabled = !canUndo(); $('redoBtn').disabled = !canRedo();
  $('undoBtn').title = canUndo() ? `Undo ${undoLabel()} (Ctrl+Z)` : 'Nothing to undo';
  $('redoBtn').title = canRedo() ? `Redo ${redoLabel()} (Ctrl+Shift+Z)` : 'Nothing to redo';
  document.title = `${p.name} · OMNICLIP`;
}
function renderSave() {
  const el = $('saveState');
  el.classList.toggle('error', saveState.status === 'error');
  el.textContent = { pending: 'Unsaved changes', saving: 'Saving…', saved: 'Saved on this device', error: 'Not saved', idle: '' }[saveState.status] || '';
  el.title = saveState.status === 'error' ? `${saveState.error}. Use Project → Save project file to keep a copy.` : 'Projects are kept in this browser on this device';
}

// ---------- clip bin ----------
function sortedClips() {
  const list = [...project().clips];
  const m = $('sortClips').value;
  if (m === 'score') list.sort((a, b) => (typeof b.score === 'number' ? b.score : -1) - (typeof a.score === 'number' ? a.score : -1));
  if (m === 'time') list.sort((a, b) => (a.ranges[0]?.start ?? 0) - (b.ranges[0]?.start ?? 0));
  return list;
}
function renderBin() {
  const list = sortedClips();
  $('clipCount').textContent = list.length || '';
  $('clipsEmpty').hidden = list.length > 0;
  $('json').disabled = !list.length;
  $('exAll').disabled = !list.length || !exportMime;
  $('exAllLabel').textContent = list.length > 1 ? `Export all ${list.length}` : 'Export all';
  $('clipSwitchText').textContent = selClip() ? `${list.indexOf(selClip()) + 1}/${list.length} · ${selClip().name}` : list.length ? 'Choose a clip' : 'No clips';
  const sig = list.map((c) => `${c.id}|${c.name}|${c.score}|${c.ranges.map((r) => `${r.src}${r.start.toFixed(2)}-${r.end.toFixed(2)}`).join(',')}|${speedOf(c)}|${effStyle(c).aspect}`).join(';') + $('sortClips').value;
  if (sig !== structSig) {
    structSig = sig;
    const ol = $('clips');
    ol.innerHTML = '';
    list.forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'clip'; li.tabIndex = 0; li.dataset.id = c.id;
      li.draggable = $('sortClips').value === 'order';
      const d = clipDuration(c);
      const score = typeof c.score === 'number' ? `<b title="Relative to the other moments in this video">${c.score}/10 here</b> · ` : c.origin === 'auto' ? '' : '<b>Yours</b> · ';
      li.innerHTML = `<div class="thumb"><span class="dur">${Math.round(d)}s</span></div>
        <div class="clip-body"><h3>${esc(c.name)}</h3><div class="meta">${score}${fmt(c.ranges[0]?.start)}${c.ranges.length > 1 ? ` · ${c.ranges.length} parts` : ''}</div></div>
        <div class="clip-state"><button class="icon-btn plain clip-more" data-op="dup" type="button" title="Duplicate" aria-label="Duplicate ${esc(c.name)}">${ICON.dup}</button><button class="icon-btn plain clip-more" data-op="del" type="button" title="Delete" aria-label="Delete ${esc(c.name)}">${ICON.del}</button><span class="xstate"></span></div>`;
      li.setAttribute('aria-label', `Clip ${i + 1}: ${c.name}, ${Math.round(d)} seconds`);
      ol.append(li);
      queueThumb(c, qs('.thumb', li));
    });
  }
  qsa('.clip', $('clips')).forEach((li) => {
    const c = clipById(project(), li.dataset.id);
    li.classList.toggle('selected', li.dataset.id === R.selId);
    li.setAttribute('aria-current', li.dataset.id === R.selId ? 'true' : 'false');
    if (c) renderClipState(c, qs('.xstate', li));
  });
}
function clipSig(c) { return JSON.stringify([c.ranges, c.title, c.overlay, effStyle(c)]); }
function jobFor(c) { return [...R.jobs].reverse().find((j) => j.clipId === c.id); }
function renderClipState(c, box) {
  const j = jobFor(c);
  if (j && (j.state === 'running')) {
    const r = 12, len = 2 * Math.PI * r;
    box.innerHTML = `<svg class="ring" viewBox="0 0 30 30" role="img" aria-label="Exporting ${Math.round(j.progress * 100)}%"><circle class="bg" cx="15" cy="15" r="${r}"/><circle class="fg" cx="15" cy="15" r="${r}" stroke-dasharray="${len}" stroke-dashoffset="${len * (1 - j.progress)}"/></svg>`;
  } else if (j && j.state === 'queued') box.innerHTML = '<span class="queued">Queued</span>';
  else if (j && j.state === 'ready' && j.sig === clipSig(c)) box.innerHTML = `<a class="icon-btn done" href="${j.url}" download="${esc(j.name)}" title="Export ready · download ${esc(j.name)}" aria-label="Download ${esc(j.name)}">${ICON.check}</a>`;
  else box.innerHTML = `<button class="icon-btn" data-op="export" type="button" title="Export this clip" aria-label="Export ${esc(c.name)}" ${exportMime ? '' : 'disabled'}>${ICON.down}</button>`;
}

// Thumbnails: the clip's first frame drawn by the real compositor (no captions or title).
let thumbChain = Promise.resolve();
const thumbVids = {};
function queueThumb(c, el) {
  const r = c.ranges[0];
  if (!r || !R.urls[r.src]) return;
  const st = { ...effStyle(c), captions: 'none', title: 'none', res: 160 };
  const key = `${r.src}|${r.start.toFixed(2)}|${JSON.stringify(st)}`;
  const put = (url) => { el.querySelector('img')?.remove(); if (url) { const img = new Image(); img.alt = ''; img.src = url; el.prepend(img); } };
  if (R.thumbs.has(key)) { put(R.thumbs.get(key)); return; }
  thumbChain = thumbChain.then(async () => {
    try {
      const v = thumbVids[r.src] ||= await openVideo(R.urls[r.src]);
      await seekVideo(v, Math.min((v.duration || r.start + 1) - 0.05, r.start + 0.4));
      const { w, h } = outSize(st, v.videoWidth, v.videoHeight);
      const cv = Object.assign(document.createElement('canvas'), { width: w, height: h });
      compose(cv.getContext('2d'), w, h, { media: v.videoWidth ? v : null, mw: v.videoWidth, mh: v.videoHeight, st: r.start, seqT: 0, style: st, title: '' });
      const url = cv.toDataURL('image/jpeg', 0.75);
      R.thumbs.set(key, url);
      if (el.isConnected) put(url);
    } catch (e) { console.warn('[omniclip] thumbnail failed', e); }
  });
}

// ---------- selection ----------
export function selectClip(id, { play = false, quiet: q = false } = {}) {
  pause();
  R.selId = id; R.ri = 0; R.playT = 0; closeEl();
  document.body.classList.remove('bin-open');
  renderAll({ type: 'select' });
  const c = selClip();
  if (c) { goTo(0, play); highlightTranscript(true); }
  if (!q && c) setStatus(`${c.name} · ${tc(clipDuration(c))}`);
}

// ============================================================ click-to-edit on the Output monitor
// compose() reports where it drew each element; clicking one opens a floating dock
// above it with quick settings and opens (and glows) its section in the inspector.
// Captions, the title and overlays can be dragged to move them.
const EL = {
  caption: { name: 'Captions', tab: 'itCaptions', glow: () => qs('input[name="st-captions"]')?.closest('.field') },
  title: { name: 'Title', tab: 'itTrim', glow: () => $('clipTitle').closest('.field') },
  overlay: { name: 'Overlay', tab: 'itFrame', glow: () => $('ovAdd').closest('.field') || $('ovAdd').parentElement },
  audio: { name: 'Audio', tab: 'itAudio', glow: () => qs('[data-style="gain"]').closest('.field') },
  frame: { name: 'Frame', tab: 'itFrame', glow: () => qs('input[name="st-layout"]')?.closest('.field') },
};
const SV = (d) => `<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const EI = {
  minus: SV('<path d="M5 10h10"/>'), plus: SV('<path d="M10 5v10M5 10h10"/>'),
  style: SV('<path d="M4 16 10 4l6 12M6.5 11.5h7"/>'), words: SV('<path d="M3 7h5M10 7h7M3 13h8M13 13h4"/>'),
  case: SV('<path d="M2.5 15 6 5l3.5 10M3.6 12h4.8M13 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM15.5 9v6"/>'),
  hide: SV('<path d="M3 3l14 14M8.6 5.2A7.8 7.8 0 0 1 10 5c4.5 0 7.5 5 7.5 5a13 13 0 0 1-2.4 2.9M5.6 6.6C3.6 8 2.5 10 2.5 10s3 5 7.5 5c1.2 0 2.3-.3 3.3-.8M8.2 8.3a2.5 2.5 0 0 0 3.5 3.5"/>'),
  more: SV('<path d="M3.5 5h13M3.5 10h13M3.5 15h8"/>'), close: SV('<path d="M5 5l10 10M15 5 5 15"/>'),
  edit: SV('<path d="M4 16h3l8.5-8.5a2.1 2.1 0 0 0-3-3L4 13z"/>'), clock: SV('<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/>'),
  opacity: SV('<circle cx="10" cy="10" r="7"/><path d="M10 3v14" /><path d="M10 6h4M10 10h7M10 14h4"/>'),
  trash: SV('<path d="M4 6h12M8 6V4h4v2M5.8 6l.9 10.5h6.6L14.2 6"/>'), mute: SV('<path d="M3.5 8h3l4-3.5v11l-4-3.5h-3zM14 8l4 4M18 8l-4 4"/>'),
  vol: SV('<path d="M3.5 8h3l4-3.5v11l-4-3.5h-3zM14 7.5a3.5 3.5 0 0 1 0 5"/>'), fade: SV('<path d="M3 15c5 0 9-10 14-10"/>'),
  layout: SV('<rect x="5" y="2.5" width="10" height="15" rx="2"/><path d="M2.5 7v6M17.5 7v6"/>'), flip: SV('<path d="M10 2.5v15M7 5 3 14h4zM13 5l4 9h-4z"/>'),
  rotate: SV('<path d="M15.5 8A6 6 0 1 0 16 12M16 4v4h-4"/>'), color: SV('<circle cx="10" cy="10" r="7"/>'),
};
const LAYOUTS = [['auto', 'Follow'], ['crop', 'Fixed'], ['blur', 'Blur'], ['fit', 'Fit']];
const tool = (q, icon, label, extra = '') => `<button class="tool" type="button" data-q="${q}" ${extra}>${icon}<span>${label}</span></button>`;
const itool = (q, icon, label) => `<button class="tool icon" type="button" data-q="${q}" aria-label="${label}" title="${label}">${icon}</button>`;
const sep = '<span class="dock-sep"></span>';
function elDockHTML(kind, c) {
  const s = effStyle(c), pct = (v) => `${Math.round(v * 100)}%`;
  const head = `<b class="el-name">${EL[kind].name}</b>`;
  const tail = `${sep}${itool('more', EI.more, 'All settings')}${itool('close', EI.close, 'Close')}`;
  if (kind === 'caption') return `${head}${sep}${itool('size-', EI.minus, 'Smaller')}<span class="el-val">${pct(s.size)}</span>${itool('size+', EI.plus, 'Bigger')}${sep}`
    + tool('preset', EI.style, PRESETS[Object.keys(PRESETS).find((k) => PRESETS[k].hi === s.hi && PRESETS[k].font === s.font && PRESETS[k].captions === s.captions)]?.label || 'Style')
    + tool('words', EI.words, `${s.words} words`) + tool('case', EI.case, s.case === 'upper' ? 'CAPS' : 'Aa')
    + `<label class="tool" title="Highlight colour"><input type="color" data-q="hi" value="${s.hi}" class="el-color">${EI.color}<span>Colour</span></label>`
    + itool('hide', EI.hide, 'Turn captions off') + tail;
  if (kind === 'title') return `${head}${sep}${tool('edit', EI.edit, 'Edit text')}${tool('tmode', EI.clock, s.title === 'always' ? 'Always' : 'Intro only')}${itool('hide', EI.hide, 'Hide the title')}${tail}`;
  if (kind === 'overlay') return `${head}${sep}${itool('ow-', EI.minus, 'Smaller')}<span class="el-val">${pct(c.overlay.w)}</span>${itool('ow+', EI.plus, 'Bigger')}${sep}${tool('oop', EI.opacity, `${pct(c.overlay.opacity ?? 1)} opacity`)}${itool('orm', EI.trash, 'Remove overlay')}${tail}`;
  if (kind === 'audio') return `${head}${sep}${itool('gain-', EI.minus, 'Quieter')}<span class="el-val">${s.mute ? 'Muted' : `${s.gain > 0 ? '+' : ''}${s.gain} dB`}</span>${itool('gain+', EI.plus, 'Louder')}${sep}${tool('mute', s.mute ? EI.vol : EI.mute, s.mute ? 'Unmute' : 'Mute')}${tool('fade', EI.fade, s.fadeIn ? `Fades ${s.fadeIn}s` : 'Add fades')}${tail}`;
  return `${head}${sep}${tool('layout', EI.layout, (LAYOUTS.find((l) => l[0] === s.layout) || LAYOUTS[0])[1])}${itool('zoom-', EI.minus, 'Zoom out')}<span class="el-val">${s.zoom.toFixed(2)}×</span>${itool('zoom+', EI.plus, 'Zoom in')}${sep}${tool('flip', EI.flip, 'Flip')}${tool('rotate', EI.rotate, 'Rotate')}${tail}`;
}
const toCss = (b) => {
  const cv = $('out'), [W, H] = R.hitWH || [1, 1];
  const k = Math.min(cv.clientWidth / W, cv.clientHeight / H), ox = (cv.clientWidth - W * k) / 2, oy = (cv.clientHeight - H * k) / 2;
  return { x: ox + b.x * k, y: oy + b.y * k, w: b.w * k, h: b.h * k, k, ox, oy };
};
function hitAt(e) {
  if (!R.hits?.length) return null;
  const cv = $('out'), r = cv.getBoundingClientRect(), [W, H] = R.hitWH;
  const k = Math.min(r.width / W, r.height / H), x = (e.clientX - r.left - (r.width - W * k) / 2) / k, y = (e.clientY - r.top - (r.height - H * k) / 2) / k;
  if (x < 0 || y < 0 || x > W || y > H) return null;
  for (let i = R.hits.length - 1; i >= 0; i--) { const h = R.hits[i]; if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return { ...h, px: x, py: y }; }
  return null;
}
const boxOf = (kind) => R.hits?.findLast?.((h) => h.kind === kind) || null;
function setBox(el, b) {
  if (!b) { el.hidden = true; return; }
  const c = toCss(b);
  Object.assign(el.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
  el.hidden = false;
}
function placeElUI() {
  const kind = R.elSel;
  if (!kind) return;
  const b = boxOf(kind) || R.elLast;
  if (!b) return;
  R.elLast = b;
  setBox($('elSel'), kind === 'frame' ? null : b);
  const dock = $('elDock'), stage = $('stage'), c = toCss(b);
  const dw = dock.offsetWidth, dh = dock.offsetHeight;
  let top = kind === 'frame' ? c.oy + 12 : c.y - dh - 10;
  if (top < 8) top = Math.min(stage.clientHeight - dh - 8, c.y + c.h + 10);
  const left = Math.max(8, Math.min(stage.clientWidth - dw - 8, c.x + c.w / 2 - dw / 2));
  dock.style.left = `${left}px`; dock.style.top = `${Math.max(8, top)}px`;
}
function renderElDock() {
  const c = selClip(); if (!c || !R.elSel) return;
  if (R.elSel === 'overlay' && !c.overlay) { closeEl(); return; }
  const dock = $('elDock');
  if (document.activeElement?.classList.contains('el-color')) { placeElUI(); return; } // keep the colour picker open
  const focused = dock.contains(document.activeElement) ? document.activeElement.dataset.q : null;
  dock.innerHTML = elDockHTML(R.elSel, c);
  dock.hidden = false;
  if (focused) dock.querySelector(`[data-q="${focused}"]`)?.focus();
  placeElUI();
}
function closeEl() { R.elSel = null; R.elLast = null; ['elDock', 'elSel', 'elHover'].forEach((id) => { if ($(id)) $(id).hidden = true; }); }
function glowInspector(kind) {
  showInspTab(EL[kind].tab);
  const target = EL[kind].glow?.();
  const insp = $('inspector');
  insp.classList.remove('glow'); void insp.offsetWidth; insp.classList.add('glow');
  if (target) {
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    target.classList.remove('glow-field'); void target.offsetWidth; target.classList.add('glow-field');
  }
}
function openEl(kind) {
  R.elSel = kind; R.elLast = boxOf(kind);
  renderElDock();
  glowInspector(kind);
  $('elHover').hidden = true;
}
function elAction(q, val) {
  const c = selClip(); if (!c) return;
  const s = effStyle(c), clamp = (v, a, b) => Math.max(a, Math.min(b, v)), r2 = (v) => Math.round(v * 100) / 100;
  const ov = (k, v) => tx('adjust overlay', (p) => { clipById(p, c.id).overlay[k] = v; }, `ov:${k}:${c.id}`);
  switch (q) {
    case 'size-': case 'size+': setStyle('size', r2(clamp(s.size + (q === 'size+' ? 0.1 : -0.1), 0.5, 1.8)), 'caption size'); break;
    case 'preset': {
      const keys = Object.keys(PRESETS), cur = keys.findIndex((k) => PRESETS[k].hi === s.hi && PRESETS[k].font === s.font && PRESETS[k].captions === s.captions);
      const p = PRESETS[keys[(cur + 1) % keys.length]];
      tx(`apply preset ${p.label}`, (pp) => { const cc = clipById(pp, c.id); for (const k of CAPTION_KEYS) if (k in p && k !== 'y') cc.style[k] = p[k]; });
      announce(`Caption style: ${p.label}`); break;
    }
    case 'words': { const opts = [1, 2, 3, 4, 6, 8]; setStyle('words', opts[(opts.indexOf(s.words) + 1) % opts.length] || 3, 'words per caption', false); break; }
    case 'case': setStyle('case', s.case === 'upper' ? 'none' : 'upper', 'caption case', false); break;
    case 'hi': setStyle('hi', val, 'highlight colour'); break;
    case 'hide': setStyle(R.elSel === 'title' ? 'title' : 'captions', 'none', R.elSel === 'title' ? 'hide title' : 'captions off', false);
      announce(R.elSel === 'title' ? 'Title hidden. Turn it back on in Trim.' : 'Captions off. Turn them back on in Captions.'); glowInspector(R.elSel); closeEl(); break;
    case 'edit': glowInspector('title'); $('clipTitle').focus(); $('clipTitle').select(); break;
    case 'tmode': setStyle('title', s.title === 'always' ? 'intro' : 'always', 'title card', false); break;
    case 'ow-': case 'ow+': ov('w', r2(clamp((c.overlay.w || 0.3) + (q === 'ow+' ? 0.05 : -0.05), 0.05, 1))); break;
    case 'oop': { const o = [1, 0.75, 0.5, 0.25], i = o.indexOf(c.overlay.opacity ?? 1); ov('opacity', o[(i + 1) % o.length]); break; }
    case 'orm': tx('remove overlay', (p) => { clipById(p, c.id).overlay = null; }); closeEl(); break;
    case 'gain-': case 'gain+': setStyle('gain', clamp(s.gain + (q === 'gain+' ? 1.5 : -1.5), -18, 12), 'volume'); break;
    case 'mute': setStyle('mute', !s.mute, s.mute ? 'unmute' : 'mute', false); break;
    case 'fade': { const f = s.fadeIn ? (s.fadeIn >= 1 ? 0 : 1) : 0.5; tx('fades', (p) => { const cc = clipById(p, c.id); cc.style.fadeIn = f; cc.style.fadeOut = f; }); break; }
    case 'layout': { const i = LAYOUTS.findIndex((l) => l[0] === s.layout); setStyle('layout', LAYOUTS[(i + 1) % LAYOUTS.length][0], 'layout', false); break; }
    case 'zoom-': case 'zoom+': setStyle('zoom', r2(clamp(s.zoom + (q === 'zoom+' ? 0.1 : -0.1), 1, 3)), 'zoom'); break;
    case 'flip': setStyle('flip', !s.flip, 'flip', false); break;
    case 'rotate': setStyle('rotate', ((s.rotate || 0) + 90) % 360, 'rotate', false); break;
    case 'more': glowInspector(R.elSel); break;
    case 'close': closeEl(); break;
  }
}
function wireElements() {
  const cv = $('out'), dock = $('elDock');
  let press = null;
  cv.addEventListener('pointerdown', (e) => {
    if (R.view !== 'output' || e.button !== 0) return;
    const h = hitAt(e); if (!h) return;
    const c = selClip(); if (!c) return;
    const s = effStyle(c);
    press = { kind: h.kind, x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, s, ov: c.overlay && { ...c.overlay }, k: toCss(h).k, H: R.hitWH[1], W: R.hitWH[0], box: h };
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!press) {
      if (R.view !== 'output' || e.pointerType === 'touch') return;
      const h = hitAt(e);
      cv.style.cursor = h && ['caption', 'title', 'overlay'].includes(h.kind) ? 'move' : h ? 'pointer' : '';
      setBox($('elHover'), h && h.kind !== 'frame' && h.kind !== R.elSel ? h : null);
      return;
    }
    const dx = (e.clientX - press.x) / press.k, dy = (e.clientY - press.y) / press.k;
    if (!press.moved && Math.hypot(dx, dy) * press.k < 5) return;
    press.moved = true;
    const c = selClip(); if (!c) return;
    if (press.kind === 'caption') setStyle('y', Math.round(Math.max(0.15, Math.min(0.92, press.s.y + dy / press.H)) * 1000) / 1000, 'move captions');
    else if (press.kind === 'title') setStyle('titleY', Math.round(Math.max(0.02, Math.min(0.8, press.s.titleY + dy / press.H)) * 1000) / 1000, 'move title');
    else if (press.kind === 'overlay' && press.ov) {
      const w = press.box.w, h = press.box.h;
      const nx = press.W - w > 0 ? Math.max(0, Math.min(1, press.ov.x + dx / (press.W - w))) : press.ov.x;
      const ny = press.H - h > 0 ? Math.max(0, Math.min(1, press.ov.y + dy / (press.H - h))) : press.ov.y;
      tx('move overlay', (p) => { const o = clipById(p, c.id).overlay; o.x = Math.round(nx * 1000) / 1000; o.y = Math.round(ny * 1000) / 1000; }, `ovmove:${c.id}`);
    }
  });
  const end = (e) => {
    if (!press) return;
    const p = press; press = null;
    if (p.moved) { endGesture(); if (R.elSel !== p.kind) openEl(p.kind); else renderElDock(); return; }
    if (e.type === 'pointercancel') return;
    if (R.elSel === p.kind) { if (p.kind === 'frame') closeEl(); return; } // a second click on the picture closes it
    openEl(p.kind);
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => { if (!press) $('elHover').hidden = true; });
  dock.addEventListener('click', (e) => { const b = e.target.closest('button[data-q]'); if (b) elAction(b.dataset.q); });
  dock.addEventListener('input', (e) => { if (e.target.dataset.q === 'hi') elAction('hi', e.target.value); });
  dock.addEventListener('change', () => endGesture());
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && R.elSel && !document.querySelector('dialog[open]')) closeEl(); });
  onChange(() => { if (R.elSel) renderElDock(); });
  new ResizeObserver(() => placeElUI()).observe($('stage'));
}

// ============================================================ monitor and playback
const player = () => $('player');
async function ensureSrc(srcId) {
  const v = player(), url = R.urls[srcId];
  if (!url) return false;
  if (v.dataset.src !== srcId) {
    v.dataset.src = srcId; v.src = url;
    await new Promise((res) => { if (v.readyState >= 1) res(); else { v.addEventListener('loadedmetadata', res, { once: true }); v.addEventListener('error', res, { once: true }); setTimeout(res, 8000); } });
    $('stage').classList.toggle('audio', !v.videoWidth);
    layoutCrop();
  }
  return true;
}
function applyVolume() {
  const c = selClip(), v = player();
  if (!c || R.view === 'source') { v.volume = 1; v.muted = false; return; }
  const s = effStyle(c), d = clipDuration(c);
  let g = s.mute ? 0 : Math.min(1, Math.pow(10, (s.gain || 0) / 20));
  if (s.fadeIn) g *= Math.min(1, R.playT / s.fadeIn);
  if (s.fadeOut) g *= Math.min(1, Math.max(0, d - R.playT) / s.fadeOut);
  v.volume = Math.max(0, Math.min(1, g));
}
export async function goTo(t, play = false) {
  const c = selClip();
  if (!c || R.view === 'source') return;
  const d = clipDuration(c);
  t = Math.max(0, Math.min(d, t));
  const { i, r, st } = seqToSource(c, t);
  R.ri = i; R.playT = t;
  if (!await ensureSrc(r.src)) { requestDraw(); return; }
  const v = player();
  v.playbackRate = speedOf(c); v.preservesPitch = true;
  if (Math.abs(v.currentTime - st) > 0.04) v.currentTime = st;
  applyVolume();
  if (play) { R.playing = true; v.play().catch(() => { R.playing = false; renderTransport(); }); loop(); }
  renderTransport(); requestDraw();
}
export function pause() { R.playing = false; player().pause(); renderTransport(); }
export function togglePlay() {
  if (R.view === 'source') { const v = player(); if (v.paused) v.play(); else v.pause(); return; }
  const c = selClip(); if (!c) return;
  if (R.playing) pause();
  else goTo(R.playT >= clipDuration(c) - 0.05 ? 0 : R.playT, true);
}
let looping = false;
function loop() {
  if (looping) return;
  looping = true;
  const step = () => {
    const c = selClip(), v = player();
    if (!R.playing || !c || R.view === 'source') { looping = false; requestDraw(); return; }
    const r = c.ranges[R.ri];
    if (!r) { pause(); looping = false; return; }
    const st = v.currentTime;
    if (st >= r.end - 0.02 || v.ended) {
      if (R.ri < c.ranges.length - 1) { goTo(sourceToSeq(c, R.ri + 1, c.ranges[R.ri + 1].start) + 0.001, true); }
      else if ($('loop').checked) goTo(0, true);
      else { pause(); R.playT = clipDuration(c); }
    } else if (v.dataset.src === r.src) R.playT = sourceToSeq(c, R.ri, st);
    applyVolume();
    draw(); renderTransport();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function renderTransport() {
  const c = selClip(), v = player();
  const playing = R.view === 'source' ? !v.paused : R.playing;
  // Only swap the icon when the state changes: rewriting it every frame ate clicks
  // that landed between mousedown and mouseup.
  const pb = $('playBtn');
  if (pb.dataset.state !== (playing ? 'pause' : 'play')) {
    pb.dataset.state = playing ? 'pause' : 'play';
    pb.innerHTML = playing ? ICON.pause : ICON.play;
    pb.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  if (R.view === 'source') { $('tcNow').textContent = tc(v.currentTime); $('tcDur').textContent = `/ ${tc(v.duration || 0)}`; }
  else { $('tcNow').textContent = tc(R.playT); $('tcDur').textContent = `/ ${tc(c ? clipDuration(c) : 0)}`; }
  tl?.setTime(R.view === 'source' ? sourceTimeToSeq(v.currentTime) : R.playT);
}
function sourceTimeToSeq(st) {
  const c = selClip(); if (!c) return 0;
  const i = c.ranges.findIndex((r) => r.src === player().dataset.src && st >= r.start && st <= r.end);
  return i < 0 ? R.playT : sourceToSeq(c, i, st);
}

// ---------- Output canvas: drawn by the export compositor ----------
let drawQueued = false;
export function requestDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; draw(); }); }
const wordCache = new Map();
function wordsFor(c, i) {
  const r = c.ranges[i];
  const segs = segsOf(r.src);
  const s = effStyle(c);
  const key = `${r.src}|${r.start}|${r.end}|${s.words}|${segs.length}|${R.segRev || 0}`;
  let w = wordCache.get(key);
  if (!w) { const words = clipWords(segs, r.start, r.end); w = { words, groups: groupWords(words, s.words || 3) }; wordCache.set(key, w); if (wordCache.size > 200) wordCache.clear(); }
  return w;
}
function followKey(c, r) { const s = effStyle(c); return `${c.id}:${r.id}:${r.start}:${r.end}:${s.aspect}:${s.zoom}:${s.rotate}`; }
function draw() {
  if (R.view !== 'output') return;
  const cv = $('out'), c = selClip(), v = player();
  const stage = $('stage');
  const style = c ? effStyle(c) : DEFAULT_STYLE;
  const { w, h } = outSize(style, v.videoWidth, v.videoHeight);
  const scale = Math.min((stage.clientHeight * (devicePixelRatio || 1)) / h, (stage.clientWidth * (devicePixelRatio || 1)) / w, 1);
  const W = Math.max(2, Math.round(w * scale)), H = Math.max(2, Math.round(h * scale));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  if (!c) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
  const r = c.ranges[R.ri] || c.ranges[0];
  const ready = v.dataset.src === r.src && v.readyState >= 2;
  const st = ready ? Math.max(r.start, Math.min(r.end, v.currentTime)) : r.start;
  const { words, groups } = wordsFor(c, R.ri);
  const ovEl = c.overlay ? overlayEl(c.overlay) : null;
  compose(ctx, W, H, {
    media: ready && v.videoWidth ? v : null, mw: v.videoWidth, mh: v.videoHeight, st, seqT: R.playT, dur: clipDuration(c),
    style, title: c.title, words, groups, levels: null, follow: R.follow[followKey(c, r)] || null,
    overlay: c.overlay, overlayEl: ovEl, guides: $('guides').checked, hits: (R.hits = []),
  });
  R.hitWH = [W, H];
  placeElUI();
}
function overlayEl(ov) {
  const id = ov.asset;
  if (R.ovEls[id] !== undefined) return R.ovEls[id]?.ready ? R.ovEls[id].el : null;
  R.ovEls[id] = null;
  dbGet('assets', id).then((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const el = ov.kind === 'video' ? Object.assign(document.createElement('video'), { muted: true, loop: true, playsInline: true }) : new Image();
    R.ovEls[id] = { el, url, ready: false };
    const ok = () => { R.ovEls[id].ready = true; if (el.play) el.play().catch(() => {}); requestDraw(); };
    if (ov.kind === 'video') el.addEventListener('loadeddata', ok, { once: true }); else el.onload = ok;
    el.src = url;
  });
  return null;
}

// ---------- Source view: crop guide over the source, In/Out marks ----------
function setView(view) {
  R.view = view;
  qsa('input[name="view"]').forEach((r) => { r.checked = r.value === view; });
  const stage = $('stage');
  stage.classList.toggle('view-output', view === 'output');
  stage.classList.toggle('view-source', view === 'source');
  player().controls = view === 'source';
  qs('.src-only').hidden = view !== 'source';
  if (view !== 'output') closeEl();
  pause();
  if (view === 'output') goTo(R.playT); else { player().volume = 1; layoutCrop(); }
  renderTransport(); requestDraw();
}
function layoutCrop() {
  const v = player(), box = $('crop'), c = selClip();
  const s = c ? effStyle(c) : DEFAULT_STYLE;
  if (R.view !== 'source' || !v.videoWidth || !['auto', 'crop'].includes(s.layout) || s.rotate) { box.hidden = true; return; }
  const frac = cropFraction(s, v.videoWidth, v.videoHeight);
  if (frac >= 0.99) { box.hidden = true; return; }
  const W = v.clientWidth, H = v.clientHeight, k = Math.min(W / v.videoWidth, H / v.videoHeight);
  const cw = v.videoWidth * k, ch = v.videoHeight * k, cx = (W - cw) / 2, cy = (H - ch) / 2;
  const bw = cw * frac;
  Object.assign(box.style, { left: `${cx + (cw - bw) * s.pos}px`, top: `${cy}px`, width: `${bw}px`, height: `${ch}px` });
  box.hidden = false;
  box.classList.toggle('auto', s.layout === 'auto');
  const tracked = c && c.ranges.some((r) => R.follow[followKey(c, r)]);
  $('cropLabel').textContent = s.layout === 'auto' ? (tracked ? 'Follows the speaker' : 'Follows the speaker if a face is found') : 'Drag to frame';
  box._range = cw - bw;
}

// ============================================================ timeline
let tl = null;
function renderTimeline() {
  const c = selClip();
  if (!c) { tl.set(null); return; }
  const s = effStyle(c);
  const blocks = c.ranges.map((r, i) => ({ len: rangeLen(r, c), label: `${tc(r.start)}–${tc(r.end)}${project().sources.length > 1 ? ' · ' + (sourceById(r.src)?.name || '') : ''}`, src: r.src, start: r.start, end: r.end, speed: s.speed, active: i === R.ri }));
  const captions = [];
  if (s.captions !== 'none') {
    c.ranges.forEach((r, i) => {
      for (const g of wordsFor(c, i).groups) captions.push({ t0: sourceToSeq(c, i, g.t0), t1: sourceToSeq(c, i, g.t1) });
    });
  }
  tl.set({ blocks, captions, duration: clipDuration(c), peaks: R.peaks });
}

// ============================================================ inspector
const NUMERIC = new Set(Object.keys(DEFAULT_STYLE).filter((k) => typeof DEFAULT_STYLE[k] === 'number'));
const parseVal = (k, v) => (k === 'flip' || k === 'mute' ? !!v : NUMERIC.has(k) ? +v : v);
const OUT_FMT = { size: (v) => `${Math.round(v * 100)}%`, y: (v) => `${Math.round(v * 100)}%`, pos: (v) => `${Math.round(v * 100)}%`, posY: (v) => `${Math.round(v * 100)}%`, zoom: (v) => `${v.toFixed(2)}×`, gain: (v) => `${v > 0 ? '+' : ''}${v} dB`, fadeIn: (v) => `${v.toFixed(1)} s`, fadeOut: (v) => `${v.toFixed(1)} s`, titleDur: (v) => `${v} s`, words: (v) => `${v}` };
const PANEL_KEYS = {
  itTrim: ['title', 'titleDur', 'speed'], itCaptions: CAPTION_KEYS, itFrame: ['aspect', 'layout', 'pos', 'posY', 'zoom', 'rotate', 'flip'],
  itAudio: ['gain', 'mute', 'fadeIn', 'fadeOut'], itExport: ['res'],
};
function setStyle(key, val, label, gesture = true) {
  const c = selClip(); if (!c) return;
  tx(label || `change ${key}`, (p) => { clipById(p, c.id).style[key] = val; }, gesture ? `st:${key}:${c.id}` : null);
}
function renderInspector() {
  const c = selClip();
  $('noClip').hidden = !!c;
  qsa('.ipane').forEach((p) => { p.classList.toggle('disabled', !c); p.inert = !c; });
  if (!c) return;
  const s = effStyle(c);
  qsa('[data-style]').forEach((el) => {
    const k = el.dataset.style;
    if (el === document.activeElement && el.type !== 'checkbox') return;
    if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
  });
  qsa('input[type="radio"][name^="st-"]').forEach((el) => { el.checked = String(s[el.name.slice(3)]) === el.value; });
  qsa('[data-out]').forEach((o) => { const k = o.dataset.out; o.textContent = (OUT_FMT[k] || String)(s[k]); });
  for (const [tab, keys] of Object.entries(PANEL_KEYS)) $(tab).classList.toggle('custom', keys.some((k) => k in c.style));
  if (document.activeElement !== $('clipName')) $('clipName').value = c.name;
  if (document.activeElement !== $('clipTitle')) $('clipTitle').value = c.title;
  renderRanges(c);
  renderPresets(s);
  // captions without a transcript
  const hasText = c.ranges.some((r) => segsOf(r.src).length);
  $('capNoText').hidden = hasText;
  // framing
  const layout = s.layout, tracked = c.ranges.some((r) => R.follow[followKey(c, r)] !== undefined);
  const found = c.ranges.some((r) => R.follow[followKey(c, r)]);
  $('trackBtn').hidden = layout !== 'auto' || !player().videoWidth || !!s.rotate;
  $('framingNote').textContent = layout !== 'auto' ? '' : s.rotate ? 'Follow speaker is off for rotated video; the Left / right position is used.'
    : tracked ? (found ? 'Speaker found: the Output preview and the export follow them.' : 'No clear face was found, so the crop stays at the Left / right position.')
      : R.framing[c.id] ? (R.framing[c.id] === 'followed' ? 'The last export followed the speaker.' : 'No face was found in the last export, so the fixed position was used.')
        : 'Faces are found when you export, or now with the button below. Until then the preview uses the Left / right position.';
  // overlay
  $('ovRemove').hidden = !c.overlay; $('ovControls').hidden = !c.overlay;
  if (c.overlay) {
    qsa('[data-ov]').forEach((el) => { if (el !== document.activeElement) el.value = c.overlay[el.dataset.ov] ?? ''; });
    qsa('[data-ovout]').forEach((o) => { const v = c.overlay[o.dataset.ovout]; o.textContent = `${Math.round(v * 100)}%`; });
  }
  // export summary
  const v = player();
  const { w, h } = outSize(s, v.videoWidth, v.videoHeight);
  const d = clipDuration(c);
  const br = (w * h >= 1920 * 1080 * 0.9 ? 8 : 5) + 0.16;
  $('exSummary').innerHTML = `${esc(s.aspect === 'original' ? 'Original shape' : s.aspect)} · ${w}×${h} · 30 fps<br>${exportMime ? `${exportExt.toUpperCase()} · ${exportExt === 'mp4' ? 'H.264 + AAC' : 'VP9/VP8 + Opus'}` : 'Export not supported in this browser'}<br>${tc(d)} · about ${mb((br * 1e6 * d) / 8)}`;
  const j = jobFor(c);
  const fresh = j && j.state === 'ready' && j.sig === clipSig(c);
  $('dlOne').hidden = !fresh;
  if (fresh) { $('dlOne').href = j.url; $('dlOne').download = j.name; $('dlOne').textContent = `Download (${j.size})`; }
  $('exportOne').disabled = !exportMime || (j && ['queued', 'running'].includes(j.state));
  $('exportOne').textContent = j?.state === 'running' ? `Exporting ${Math.round(j.progress * 100)}%…` : j?.state === 'queued' ? 'Queued' : fresh ? 'Export again' : 'Export this clip';
  $('fastExport').checked = R.fast;
}
function renderRanges(c) {
  const ol = $('ranges');
  const active = document.activeElement;
  if (ol.contains(active) && active.tagName === 'INPUT') return; // don't rebuild under the cursor
  ol.innerHTML = '';
  c.ranges.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'range' + (i === R.ri ? ' cur' : '');
    li.innerHTML = `<div class="times">
      <button class="nb" data-r="${i}" data-k="start" data-d="-0.1" type="button" aria-label="Range ${i + 1} start 0.1 s earlier">−</button><input class="tc" data-r="${i}" data-k="start" value="${tc(r.start)}" aria-label="Range ${i + 1} start" title="Type a time like 1:23.4 · ↑/↓ 0.1 s, Shift 1 s"><button class="nb" data-r="${i}" data-k="start" data-d="0.1" type="button" aria-label="Range ${i + 1} start 0.1 s later">+</button>
      <span aria-hidden="true">→</span>
      <button class="nb" data-r="${i}" data-k="end" data-d="-0.1" type="button" aria-label="Range ${i + 1} end 0.1 s earlier">−</button><input class="tc" data-r="${i}" data-k="end" value="${tc(r.end)}" aria-label="Range ${i + 1} end" title="Type a time like 1:23.4 · ↑/↓ 0.1 s, Shift 1 s"><button class="nb" data-r="${i}" data-k="end" data-d="0.1" type="button" aria-label="Range ${i + 1} end 0.1 s later">+</button></div>
      <div class="ops"><button class="nb" data-op="up" data-r="${i}" type="button" aria-label="Move range ${i + 1} earlier" ${i ? '' : 'disabled'}>↑</button><button class="nb" data-op="down" data-r="${i}" type="button" aria-label="Move range ${i + 1} later" ${i < c.ranges.length - 1 ? '' : 'disabled'}>↓</button><button class="nb" data-op="rm" data-r="${i}" type="button" aria-label="Delete range ${i + 1}" ${c.ranges.length > 1 ? '' : 'disabled'}>✕</button></div>
      <span class="src">${esc(sourceById(r.src)?.name || 'Missing video')} · ${tc(r.end - r.start)}</span>`;
    ol.append(li);
  });
}
function setRangeTime(i, k, t, gesture = true) {
  const c = selClip(); if (!c) return;
  const src = sourceById(c.ranges[i].src);
  const dur = src?.duration || Infinity;
  tx('trim', (p) => {
    const r = clipById(p, c.id).ranges[i];
    if (k === 'start') r.start = Math.max(0, Math.min(r.end - MIN_LEN, t));
    else r.end = Math.max(r.start + MIN_LEN, Math.min(dur, t));
  }, gesture ? `trim:${c.id}:${i}:${k}` : null);
  const r = selClip().ranges[i];
  R.ri = i;
  const v = player();
  if (R.view === 'output') goTo(sourceToSeq(selClip(), i, k === 'start' ? r.start : Math.max(r.start, r.end - 1.5)));
  else if (v.dataset.src === r.src) v.currentTime = k === 'start' ? r.start : r.end;
}
function renderPresets(s) {
  const box = $('presets');
  const custom = JSON.parse(localStorage.getItem('omniclip:presets') || '{}');
  const all = { ...PRESETS, ...Object.fromEntries(Object.entries(custom).map(([k, v]) => [`u:${k}`, { ...v, label: k, custom: true }])) };
  const sig = Object.keys(all).join('|');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = Object.entries(all).map(([id, p]) => `<button class="preset" type="button" data-preset="${esc(id)}">${esc(p.label)}${p.custom ? ' <span class="x" data-delpreset="' + esc(id.slice(2)) + '" title="Delete preset" aria-label="Delete preset ' + esc(p.label) + '">✕</span>' : ''}</button>`).join('');
  }
  qsa('.preset', box).forEach((b) => {
    const p = all[b.dataset.preset];
    b.classList.toggle('on', !!p && CAPTION_KEYS.filter((k) => k in p && k !== 'y' && k !== 'dir').every((k) => String(p[k]) === String(s[k])));
  });
  return all;
}

// ============================================================ transcript
const transcriptSrc = () => { const c = selClip(); return c?.ranges[R.ri]?.src || c?.ranges[0]?.src || mainSrc()?.id; };
function renderTranscript() {
  const srcId = transcriptSrc();
  R.transcriptSrc = srcId;
  const segs = segsOf(srcId);
  const box = $('transcript');
  box.className = qs('input[name="tmode"]:checked').value;
  box.innerHTML = '';
  $('transcriptEmpty').hidden = segs.length > 0;
  $('transcribeNow').hidden = !!R.transcribing || !R.urls[srcId];
  $('srt').disabled = !segs.length;
  const frag = document.createDocumentFragment();
  const edit = box.className === 'edit';
  segs.forEach((s, i) => {
    const p = document.createElement('p');
    p.className = 'line'; p.dataset.i = i;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ts'; b.textContent = fmt(s.start); b.dataset.t = s.start;
    b.setAttribute('aria-label', `Play from ${fmt(s.start)}`);
    const t = document.createElement('span');
    t.className = 't'; t.textContent = s.text;
    if (edit) { t.contentEditable = 'plaintext-only'; t.spellcheck = false; t.setAttribute('aria-label', `Text at ${fmt(s.start)}`); t.tabIndex = 0; }
    p.append(b, t);
    frag.append(p);
  });
  box.append(frag);
  R.pick = null;
  updatePick();
  highlightTranscript();
  runSearch(false);
}
export function appendSegments(srcId, segs) {
  // streaming transcription: append lines without rebuilding the whole list
  if (srcId !== transcriptSrc() || $('transcript').className === 'edit') { renderTranscript(); return; }
  const box = $('transcript');
  const all = segsOf(srcId);
  $('transcriptEmpty').hidden = all.length > 0;
  $('srt').disabled = !all.length;
  for (const s of segs) {
    const i = all.indexOf(s);
    const p = document.createElement('p');
    p.className = 'line'; p.dataset.i = i;
    p.innerHTML = `<button type="button" class="ts" data-t="${s.start}" aria-label="Play from ${fmt(s.start)}">${fmt(s.start)}</button><span class="t"></span>`;
    qs('.t', p).textContent = s.text;
    box.append(p);
  }
}
function highlightTranscript(scroll = false) {
  const c = selClip(), srcId = R.transcriptSrc;
  const segs = segsOf(srcId);
  let first = null;
  qsa('#transcript .line').forEach((p) => {
    const s = segs[+p.dataset.i];
    const on = !!(c && s && c.ranges.some((r) => r.src === srcId && s.end > r.start + 0.05 && s.start < r.end - 0.05));
    p.classList.toggle('inclip', on);
    if (on && !first) first = p;
  });
  if (scroll && !$('transcriptPane').hidden) first?.scrollIntoView({ block: 'nearest' });
}
function updatePick() {
  const pk = R.pick;
  qsa('#transcript .line').forEach((p) => {
    const i = +p.dataset.i;
    p.classList.toggle('picked', !!pk && i >= Math.min(pk.a, pk.b) && i <= Math.max(pk.a, pk.b));
  });
  $('fromSel').disabled = !pk;
  $('fromSel').textContent = pk ? `Make a short from ${Math.abs(pk.b - pk.a) + 1} line${pk.a === pk.b ? '' : 's'}` : 'Make a short from selected lines';
}
let hits = [], hitIdx = -1;
function runSearch(jump = true) {
  const q = $('tSearch').value.trim().toLocaleLowerCase();
  qsa('#transcript .line').forEach((p) => p.classList.remove('hit', 'hit-cur'));
  hits = q ? qsa('#transcript .line').filter((p) => qs('.t', p).textContent.toLocaleLowerCase().includes(q)) : [];
  hits.forEach((p) => p.classList.add('hit'));
  if (!hits.length) { hitIdx = -1; $('tCount').textContent = q ? '0' : ''; return; }
  if (hitIdx >= hits.length || hitIdx < 0) hitIdx = 0;
  $('tCount').textContent = `${hitIdx + 1}/${hits.length}`;
  hits[hitIdx].classList.add('hit-cur');
  if (jump) hits[hitIdx].scrollIntoView({ block: 'center' });
}

// ============================================================ media list
function renderMedia() {
  const ul = $('mediaList');
  ul.innerHTML = project().sources.map((s) => `<li class="media-item ${R.urls[s.id] ? '' : 'missing'}"><b title="${esc(s.name)}">${esc(s.name)}</b>
    <span class="meta">${s.duration ? fmt(s.duration) + ' · ' : ''}${mb(s.size)}${s.width ? ` · ${s.width}×${s.height}` : ' · audio'}${segsOf(s.id).length ? ' · transcript' : ''}${R.urls[s.id] ? '' : ' · not found'}</span>
    <span class="row">${R.urls[s.id] ? `<button class="btn btn-outline btn-sm" data-mop="new" data-src="${s.id}" type="button">New clip from it</button><button class="btn btn-outline btn-sm" data-mop="append" data-src="${s.id}" type="button" ${selClip() ? '' : 'disabled'}>Add to selected clip</button>${segsOf(s.id).length ? '' : `<button class="btn btn-outline btn-sm" data-mop="asr" data-src="${s.id}" type="button">Transcribe</button>`}` : `<button class="btn btn-outline btn-sm" data-mop="relink" data-src="${s.id}" type="button">Find file…</button>`}</span></li>`).join('');
}

// ============================================================ clip operations
export function addClip(clip, label = 'add clip') {
  tx(label, (p) => { p.clips.unshift(clip); });
  selectClip(clip.id);
  return clip;
}
function duplicateClip(c, extra = {}) {
  const copy = JSON.parse(JSON.stringify(c));
  copy.id = uid('c'); copy.name = `${c.name} (copy)`; copy.ranges.forEach((r) => { r.id = uid('r'); });
  Object.assign(copy.style, extra.style || {}); if (extra.name) copy.name = extra.name;
  tx('duplicate clip', (p) => { const i = p.clips.findIndex((x) => x.id === c.id); p.clips.splice(i + 1, 0, copy); });
  selectClip(copy.id);
}
function deleteClip(c) {
  const name = c.name;
  const i = project().clips.findIndex((x) => x.id === c.id);
  tx('delete clip', (p) => { p.clips.splice(p.clips.findIndex((x) => x.id === c.id), 1); });
  const next = sortedClips()[Math.min(i, project().clips.length - 1)];
  selectClip(next?.id || null, { quiet: true });
  notice(`Deleted <b>${esc(name)}</b>.`, 'Undo', () => { undo(); announce('Restored the clip'); });
  if (!project().clips.length) showEmpty();
}
export function showEmpty(text) {
  $('resultsSub').textContent = text || 'No clips yet. Use the whole video, make one at the playhead, or pick transcript lines.';
  $('clipsEmpty').classList.add('failed');
  $('emptyActions').hidden = false;
  $('emptyFromText').hidden = !segsOf(mainSrc()?.id).length;
}
function moveClip(c, dir) {
  if ($('sortClips').value !== 'order') { $('sortClips').value = 'order'; structSig = ''; }
  tx('reorder clips', (p) => {
    const i = p.clips.findIndex((x) => x.id === c.id), j = i + dir;
    if (j < 0 || j >= p.clips.length) return;
    [p.clips[i], p.clips[j]] = [p.clips[j], p.clips[i]];
  });
  qs(`.clip[data-id="${c.id}"]`)?.focus();
}
function curSourceTime() {
  const v = player();
  if (R.view === 'source') return { src: v.dataset.src, t: v.currentTime };
  const c = selClip(); if (!c) return { src: mainSrc()?.id, t: 0 };
  const { r, st } = seqToSource(c, R.playT);
  return { src: r.src, t: st };
}
function splitAtPlayhead() {
  const c = selClip(); if (!c) return;
  const { src, t } = curSourceTime();
  const i = c.ranges.findIndex((r) => r.src === src && t > r.start + MIN_LEN && t < r.end - MIN_LEN);
  if (i < 0) { announce('Move the playhead inside a range (not at its edge) to split it.'); return; }
  tx('split', (p) => {
    const cc = clipById(p, c.id), r = cc.ranges[i];
    cc.ranges.splice(i, 1, { ...r, end: t }, { id: uid('r'), src: r.src, start: t, end: r.end });
  });
  announce(`Split at ${tc(t)}. Delete either part, or trim it on the timeline.`);
}
function deleteRangeAt() {
  const c = selClip(); if (!c) return;
  if (c.ranges.length < 2) { announce('A clip needs at least one range. Delete the clip from the list instead.'); return; }
  const i = R.ri;
  tx('delete range', (p) => { clipById(p, c.id).ranges.splice(i, 1); });
  R.ri = Math.min(i, selClip().ranges.length - 1);
  goTo(sourceToSeq(selClip(), R.ri, selClip().ranges[R.ri].start));
  announce('Deleted the range. Ctrl+Z brings it back.');
}

// ---------- pause removal ----------
let pausePlan = null;
function planPauses() {
  const c = selClip(); if (!c) return;
  const min = +$('pauseMin').value, thr = +$('pauseThr').value;
  $('pauseMinOut').textContent = `${min.toFixed(1)} s`; $('pauseThrOut').textContent = `${Math.round(thr * 1000) / 10}%`;
  const missing = c.ranges.filter((r) => !R.peaks[r.src]);
  if (missing.length) { $('pauseInfo').textContent = R.hooks.peaksPending?.() ? 'Still reading the audio… try again in a moment.' : 'The audio of this video could not be read, so pauses can’t be found.'; $('pauseApply').disabled = true; pausePlan = null; return; }
  pausePlan = c.ranges.map((r) => findPauses(R.peaks[r.src], r.start, r.end, { threshold: thr, minLen: min }));
  const n = pausePlan.flat().length, secs = pausePlan.flat().reduce((s, p) => s + p.end - p.start, 0);
  $('pauseInfo').textContent = n ? `Found ${n} pause${n === 1 ? '' : 's'} (${secs.toFixed(1)} s). Cutting them keeps 0.15 s of air on each side.` : 'No pauses that long. Try a shorter length or a higher quiet level.';
  $('pauseApply').disabled = !n;
}
function applyPauses() {
  const c = selClip(); if (!c || !pausePlan) return;
  const plan = pausePlan;
  tx('remove pauses', (p) => {
    const cc = clipById(p, c.id);
    const out = [];
    cc.ranges.forEach((r, i) => {
      let cur = r.start;
      for (const q of plan[i]) { if (q.start - cur >= MIN_LEN / 2) out.push({ id: uid('r'), src: r.src, start: cur, end: q.start }); cur = q.end; }
      if (r.end - cur >= 0.1) out.push({ id: uid('r'), src: r.src, start: cur, end: r.end });
    });
    if (out.length) cc.ranges = out;
  });
  $('pausesBox').hidden = true;
  announce(`Removed pauses: the clip is now ${tc(clipDuration(selClip()))}. Ctrl+Z undoes it.`);
}

// ============================================================ export queue and tray
function snapshot(c) {
  const style = effStyle(c);
  const segments = {};
  for (const r of c.ranges) segments[r.src] = segsOf(r.src).map((s) => ({ start: s.start, end: s.end, text: s.text }));
  const urls = Object.fromEntries(c.ranges.map((r) => [r.src, R.urls[r.src]]));
  const follows = c.ranges.map((r) => R.follow[followKey(c, r)]);
  const ov = c.overlay ? R.ovEls[c.overlay.asset] : null;
  return {
    clip: JSON.parse(JSON.stringify({ ranges: c.ranges, title: c.title, overlay: c.overlay })),
    style, segments, urls, follows: follows.every((f) => f !== undefined) ? follows : null,
    overlayUrl: ov?.url || null, overlayKind: c.overlay?.kind,
  };
}
const usedNames = new Set();
export function enqueue(c) {
  if (!exportMime) { announce('This browser can’t export video. Use Chrome or Edge on a computer.'); return; }
  const live = jobFor(c);
  if (live && ['queued', 'running'].includes(live.state)) return;
  const missing = c.ranges.find((r) => !R.urls[r.src]);
  if (missing) { announce(`“${c.name}” uses a video that isn’t linked. Find it in the Media tab first.`); return; }
  const stem = safeName(c.name) === base() ? base() : `${base()}-${safeName(c.name)}`;
  let name = stem, k = 2;
  while (usedNames.has(name)) name = `${stem}-${k++}`;
  usedNames.add(name);
  const job = { id: uid('j'), clipId: c.id, title: c.name, name: `${name}.${exportExt}`, sig: clipSig(c), snap: snapshot(c), state: 'queued', progress: 0, label: '', fast: R.fast };
  R.jobs.push(job);
  renderTray(); renderBin(); renderInspector();
  runQueue();
}
let running = false;
async function runQueue() {
  if (running) return;
  running = true;
  for (let job; (job = R.jobs.find((j) => j.state === 'queued'));) {
    job.state = 'running'; job.ctrl = new AbortController(); job.t0 = performance.now();
    renderTray();
    try {
      const engine = job.fast && R.hooks.fastExport ? R.hooks.fastExport : exportClip;
      const res = await engine(job.snap, {
        signal: job.ctrl.signal,
        onProgress: (p, label) => {
          job.progress = p; job.label = label;
          const left = label === 'Recording' && p > 0.05 ? ((performance.now() - (job.recT0 ||= performance.now())) / p) * (1 - p) / 1000 : null;
          job.eta = left;
          throttleTray();
          setStatus(`Exporting “${job.title}” · ${label} ${Math.round(p * 100)}%${left ? ` · ${Math.ceil(left)} s left` : ''}`);
        },
      });
      job.blob = res.blob; job.url = URL.createObjectURL(res.blob); job.size = mb(res.blob.size); job.state = 'ready';
      if (res.framing && res.framing !== 'none') R.framing[job.clipId] = res.framing;
      const a = document.createElement('a'); a.href = job.url; a.download = job.name; a.click();
      announce(`Export ready: ${job.name} (${job.size}). If it didn’t download, use Download in the exports list.`);
    } catch (e) {
      if (e.name === 'AbortError') { job.state = 'cancelled'; announce(`Cancelled “${job.title}”.`); }
      else { job.state = 'failed'; job.error = e.message || String(e); announce(`Export of “${job.title}” failed: ${job.error}`); console.error(e); }
    }
    job.ctrl = null;
    renderTray(); renderBin(); renderInspector();
  }
  running = false;
  updateHiddenTitle();
}
let trayTimer = null;
function throttleTray() { if (trayTimer) return; trayTimer = setTimeout(() => { trayTimer = null; renderTray(); renderBin(); if (selClip()) renderInspector(); }, 250); }
function renderTray() {
  const jobs = R.jobs;
  if (jobs.length && $('tray').hidden && innerWidth <= 760) { $('tray').classList.add('collapsed'); $('trayToggle').textContent = '▴'; $('trayToggle').setAttribute('aria-expanded', 'false'); }
  $('tray').hidden = !jobs.length;
  $('trayCount').textContent = jobs.length ? `${jobs.filter((j) => j.state === 'ready').length}/${jobs.length}` : '';
  $('trayZip').disabled = jobs.filter((j) => j.state === 'ready').length < 2;
  $('trayNote').hidden = !jobs.some((j) => ['queued', 'running'].includes(j.state) && !j.fast);
  $('trayList').innerHTML = jobs.map((j) => {
    const state = { queued: 'Waiting', running: `${j.label || 'Starting'} ${Math.round(j.progress * 100)}%${j.eta ? ` · ${Math.ceil(j.eta)} s left` : ''}`, ready: `Ready · ${j.size}`, failed: `Failed: ${esc(j.error)}`, cancelled: 'Cancelled' }[j.state];
    const acts = [];
    if (['queued', 'running'].includes(j.state)) acts.push(`<button class="btn btn-outline btn-sm" data-job="${j.id}" data-jop="cancel" type="button">Cancel</button>`);
    if (j.state === 'ready') acts.push(`<a class="icon-btn" href="${j.url}" download="${esc(j.name)}" aria-label="Download ${esc(j.name)}" title="Download">${ICON.down}</a>`);
    if (['failed', 'cancelled'].includes(j.state)) acts.push(`<button class="btn btn-outline btn-sm" data-job="${j.id}" data-jop="retry" type="button">Retry</button>`);
    if (!['queued', 'running'].includes(j.state)) acts.push(`<button class="icon-btn plain" data-job="${j.id}" data-jop="remove" type="button" aria-label="Remove from list" title="Remove">✕</button>`);
    return `<li class="job ${j.state}"><span class="job-name" title="${esc(j.name)}">${esc(j.name)}</span><span class="job-acts">${acts.join('')}</span><span class="job-state">${state}</span>${j.state === 'running' ? `<span class="pp-bar"><i style="width:${Math.round(j.progress * 100)}%"></i></span>` : ''}</li>`;
  }).join('');
}
function updateHiddenTitle() {
  const realTime = R.jobs.some((j) => j.state === 'running' && !j.fast);
  document.title = document.hidden && realTime ? '⏸ Export paused · come back to OMNICLIP' : `${project()?.name || 'OMNICLIP'} · OMNICLIP`;
}

// ---------- subtitles for one clip (rebased to the clip's own timeline) ----------
function clipCues(c) {
  const cues = [];
  c.ranges.forEach((r, i) => {
    for (const s of segsOf(r.src)) {
      if (s.end <= r.start || s.start >= r.end) continue;
      const a = sourceToSeq(c, i, Math.max(s.start, r.start)), b = sourceToSeq(c, i, Math.min(s.end, r.end));
      if (b - a > 0.05) cues.push({ start: a, end: b, text: s.text });
    }
  });
  return cues;
}

// ============================================================ wiring
function wire() {
  tl = new Timeline($('timeline'), {
    seek: (t) => { if (R.view === 'source') setView('output'); pause(); goTo(t); },
    trim: (i, side, t) => setRangeTime(i, side, t),
    trimEnd: () => endGesture(),
  });
  $('tlIn').onclick = () => tl.zoom(1.5); $('tlOut').onclick = () => tl.zoom(1 / 1.5); $('tlFit').onclick = () => { tl.fitAll(); tl.draw(); };
  $('tlSplit').onclick = splitAtPlayhead; $('splitBtn').onclick = splitAtPlayhead; $('tlDelete').onclick = deleteRangeAt;
  $('timeline').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); pause(); goTo(R.playT + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 0.1)); }
  });
  new ResizeObserver(() => { layoutCrop(); requestDraw(); }).observe($('stage'));

  // header
  $('projName').oninput = () => tx('rename project', (p) => { p.name = $('projName').value.trim() || 'Project'; }, 'projname');
  $('projName').onkeydown = (e) => { if (e.key === 'Enter') $('projName').blur(); };
  $('undoBtn').onclick = () => { const l = undo(); if (l) announce(`Undid ${l}`); };
  $('redoBtn').onclick = () => { const l = redo(); if (l) announce(`Redid ${l}`); };
  $('saveState').onclick = () => { if (saveState.status === 'error') saveFile(`${base()}.omniclip.json`, projectFile(), 'application/json'); };

  // bin
  qsa('#bin .tab').forEach((t) => (t.onclick = () => showBinTab(t.id)));
  wireTabs('#bin .tabs', showBinTab);
  $('sortClips').onchange = () => { structSig = ''; renderBin(); };
  $('clips').addEventListener('click', (e) => {
    const li = e.target.closest('.clip'); if (!li) return;
    const c = clipById(project(), li.dataset.id);
    const op = e.target.closest('[data-op]')?.dataset.op;
    if (op === 'dup') duplicateClip(c);
    else if (op === 'del') deleteClip(c);
    else if (op === 'export') enqueue(c);
    else if (!e.target.closest('a')) selectClip(c.id);
  });
  $('clips').addEventListener('keydown', (e) => {
    const li = e.target.closest('.clip'); if (!li || e.target !== li) return;
    const c = clipById(project(), li.dataset.id);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); selectClip(c.id, { play: e.key === ' ' }); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); e.stopPropagation(); moveClip(c, e.key === 'ArrowUp' ? -1 : 1); announce(`Moved to position ${project().clips.findIndex((x) => x.id === c.id) + 1}`); }
    else if (e.key === 'Delete') { e.preventDefault(); deleteClip(c); }
  });
  let dragId = null;
  $('clips').addEventListener('dragstart', (e) => { const li = e.target.closest('.clip'); if (!li) return; dragId = li.dataset.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
  $('clips').addEventListener('dragover', (e) => { if (!dragId) return; e.preventDefault(); e.stopPropagation(); qsa('.clip').forEach((x) => x.classList.remove('drop-before')); e.target.closest('.clip')?.classList.add('drop-before'); });
  $('clips').addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault(); e.stopPropagation();
    const target = e.target.closest('.clip')?.dataset.id;
    const id = dragId; dragId = null;
    if (target && target !== id) tx('reorder clips', (p) => { const from = p.clips.findIndex((x) => x.id === id); const [c] = p.clips.splice(from, 1); p.clips.splice(p.clips.findIndex((x) => x.id === target), 0, c); });
  });
  $('clips').addEventListener('dragend', () => { dragId = null; qsa('.clip').forEach((x) => x.classList.remove('dragging', 'drop-before')); });
  $('newClip').onclick = () => {
    const { src, t } = curSourceTime();
    const s = sourceById(src) || mainSrc(); if (!s) return;
    const start = Math.min(t, Math.max(0, (s.duration || 10) - 10)), end = Math.min(s.duration || start + 10, start + 10);
    addClip(makeClip({ src: s.id, start, end, name: `Clip at ${fmt(start)}`, title: '' }), 'new clip');
    showInspTab('itTrim');
  };
  $('emptyWhole').onclick = () => {
    const s = mainSrc(); if (!s?.duration) { announce('The video is still loading, try again in a moment.'); return; }
    addClip(makeClip({ src: s.id, start: 0, end: s.duration, name: project().name, title: '' }), 'use whole video');
    $('clipsEmpty').classList.remove('failed');
    showInspTab('itTrim');
  };
  $('emptyFromText').onclick = () => showBinTab('tabTranscript');
  $('exAll').onclick = () => { for (const c of sortedClips()) { const j = jobFor(c); if (!(j && j.state === 'ready' && j.sig === clipSig(c))) enqueue(c); } };
  $('json').onclick = () => saveFile(`${base()}.clips.json`, JSON.stringify(project().clips.map((c) => ({ name: c.name, title: c.title, ranges: c.ranges.map((r) => ({ video: sourceById(r.src)?.name, start: +r.start.toFixed(3), end: +r.end.toFixed(3) })), duration: +clipDuration(c).toFixed(3), score: c.score ?? undefined })), null, 2), 'application/json');
  $('clipSwitch').onclick = () => document.body.classList.toggle('bin-open');

  // transcript
  qsa('input[name="tmode"]').forEach((r) => (r.onchange = () => { renderTranscript(); $('tHint').textContent = r.value === 'edit' ? 'Click any word to fix it. Captions and subtitles use your fix. Enter finishes a line.' : 'Click the first line, then Shift-click (or tap) the last line of your short. The time button plays from that line.'; }));
  $('transcript').addEventListener('click', (e) => {
    const ts = e.target.closest('.ts');
    if (ts) {
      const t = +ts.dataset.t, src = R.transcriptSrc;
      const c = selClip(), i = c ? c.ranges.findIndex((r) => r.src === src && t >= r.start && t < r.end) : -1;
      if (i >= 0) { if (R.view !== 'output') setView('output'); goTo(sourceToSeq(c, i, t), true); }
      else { setView('source'); ensureSrc(src).then(() => { player().currentTime = t; player().play(); }); }
      return;
    }
    const line = e.target.closest('.line');
    if (!line || $('transcript').className !== 'select') return;
    const i = +line.dataset.i;
    if (R.pick && (e.shiftKey || R.pick.a === R.pick.b) && i !== R.pick.a && !R.pick.done) { R.pick.b = i; R.pick.done = true; }
    else R.pick = { a: i, b: i, done: false };
    updatePick();
  });
  $('transcript').addEventListener('input', (e) => {
    const t = e.target.closest('.t'); if (!t) return;
    const i = +t.parentElement.dataset.i, src = R.transcriptSrc;
    const text = t.textContent.replace(/\s+/g, ' ').trim();
    R.editingSeg = true;
    tx('fix transcript', (p) => { p.segments[src][i].text = text; }, `seg:${src}:${i}`);
    R.editingSeg = false;
    R.segRev = (R.segRev || 0) + 1;
  });
  $('transcript').addEventListener('keydown', (e) => { if (e.target.closest('.t') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); endGesture(); } });
  $('transcript').addEventListener('focusout', () => endGesture());
  $('fromSel').onclick = () => {
    const pk = R.pick; if (!pk) return;
    const src = R.transcriptSrc, segs = segsOf(src);
    const a = segs[Math.min(pk.a, pk.b)], b = segs[Math.max(pk.a, pk.b)];
    const title = shortTitle(a.text);
    addClip(makeClip({ src, start: a.start, end: Math.max(b.end, a.start + 1), title, name: title }), 'clip from transcript');
    R.pick = null; updatePick();
    $('clipsEmpty').classList.remove('failed');
    showBinTab('tabClips');
    announce('Added your short. Trim it in the Trim panel or on the timeline.');
  };
  $('tSearch').oninput = () => { hitIdx = 0; runSearch(); };
  $('tSearch').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); hitIdx = (hitIdx + (e.shiftKey ? -1 : 1) + hits.length) % Math.max(1, hits.length); runSearch(); } };
  $('tNext').onclick = () => { hitIdx = (hitIdx + 1) % Math.max(1, hits.length); runSearch(); };
  $('tPrev').onclick = () => { hitIdx = (hitIdx - 1 + hits.length) % Math.max(1, hits.length); runSearch(); };
  $('srt').onclick = () => saveFile(`${safeName(sourceById(R.transcriptSrc)?.name.replace(/\.[^.]+$/, '') || base())}.srt`, toSRT(segsOf(R.transcriptSrc)), 'text/plain');
  const importSubs = () => { $('subFile').value = ''; $('subFile').click(); };
  $('importSub').onclick = importSubs; $('capImport').onclick = importSubs;
  $('subFile').onchange = async () => {
    const f = $('subFile').files[0]; if (!f) return;
    try {
      const cues = parseSubtitles(await f.text());
      const src = transcriptSrc();
      const had = segsOf(src).length;
      if (had && await ask('Replace the transcript?', `<p>This video already has ${had} transcript lines. Importing <b>${esc(f.name)}</b> replaces them (Undo brings them back).</p>`, [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, solid: true }]) !== true) return;
      tx('import subtitles', (p) => { p.segments[src] = cues; });
      R.segRev = (R.segRev || 0) + 1;
      renderTranscript();
      announce(`Imported ${cues.length} subtitles from ${f.name}.`);
    } catch (e) { announce(e.message); }
  };
  $('transcribeNow').onclick = () => R.hooks.transcribe?.(transcriptSrc());
  $('capTranscribe').onclick = () => R.hooks.transcribe?.(selClip()?.ranges[0].src);

  // media
  $('mediaList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mop]'); if (!b) return;
    const s = sourceById(b.dataset.src);
    if (b.dataset.mop === 'new') addClip(makeClip({ src: s.id, start: 0, end: s.duration || 10, name: s.name.replace(/\.[^.]+$/, '') }), 'new clip');
    else if (b.dataset.mop === 'append') { const c = selClip(); tx('add range', (p) => { clipById(p, c.id).ranges.push({ id: uid('r'), src: s.id, start: 0, end: Math.min(s.duration || 10, 10) }); }); announce(`Added 10 s of ${s.name} at the end. Trim it in the Trim panel.`); }
    else if (b.dataset.mop === 'asr') R.hooks.transcribe?.(s.id);
    else if (b.dataset.mop === 'relink') R.hooks.relinkOne?.(s.id);
  });
  $('addMedia').onclick = () => { $('mediaFile').value = ''; $('mediaFile').click(); };

  // monitor
  qsa('input[name="view"]').forEach((r) => (r.onchange = () => setView(r.value)));
  $('playBtn').onclick = togglePlay;
  wireElements();
  $('guides').onchange = requestDraw;
  const v = player();
  v.addEventListener('timeupdate', () => { if (R.view === 'source') renderTransport(); });
  v.addEventListener('play', () => { if (R.view === 'source') renderTransport(); });
  v.addEventListener('pause', () => { if (R.view === 'source') renderTransport(); });
  v.addEventListener('seeked', requestDraw);
  v.addEventListener('loadeddata', requestDraw);
  $('markIn').onclick = () => { R.inMark = { src: v.dataset.src, t: v.currentTime }; renderMarks(); };
  $('markOut').onclick = () => { R.outMark = { src: v.dataset.src, t: v.currentTime }; renderMarks(); };
  $('addRange').onclick = () => {
    const c = selClip(), io = marks(); if (!c || !io) return;
    tx('add range', (p) => { clipById(p, c.id).ranges.push({ id: uid('r'), ...io }); });
    announce(`Added ${tc(io.end - io.start)} to “${c.name}”.`);
  };
  $('newFromIO').onclick = () => { const io = marks(); if (!io) return; addClip(makeClip({ ...io, name: `Clip at ${fmt(io.start)}` }), 'new clip'); setView('output'); };

  // crop handle drag (Source view, Fixed framing)
  (() => {
    const h = $('cropHandle');
    let x0 = 0, p0 = 0, dragging = false;
    h.addEventListener('pointerdown', (e) => { const c = selClip(); if (!c || effStyle(c).layout !== 'crop') return; dragging = true; x0 = e.clientX; p0 = effStyle(c).pos; h.setPointerCapture(e.pointerId); });
    h.addEventListener('pointermove', (e) => { if (!dragging) return; setStyle('pos', Math.max(0, Math.min(1, p0 + (e.clientX - x0) / ($('crop')._range || 1))), 'move crop'); });
    const end = () => { dragging = false; endGesture(); };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
    h.addEventListener('keydown', (e) => {
      const c = selClip(); if (!c || effStyle(c).layout !== 'crop' || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      setStyle('pos', Math.max(0, Math.min(1, effStyle(c).pos + (e.key === 'ArrowLeft' ? -0.05 : 0.05))), 'move crop');
    });
  })();

  // inspector
  qsa('#inspector .tab').forEach((t) => (t.onclick = () => showInspTab(t.id)));
  wireTabs('#inspector .tabs', showInspTab);
  qsa('[data-style]').forEach((el) => {
    const k = el.dataset.style;
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'color' ? 'change' : 'input', () => setStyle(k, parseVal(k, el.type === 'checkbox' ? el.checked : el.value)));
    el.addEventListener('change', () => endGesture());
  });
  qsa('input[type="radio"][name^="st-"]').forEach((el) => (el.onchange = () => { const k = el.name.slice(3); setStyle(k, parseVal(k, el.value), `change ${k}`, false); if (k === 'aspect' || k === 'layout') layoutCrop(); }));
  qs('select[data-style="font"]').innerHTML = Object.entries(FONT_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('clipName').oninput = () => { const c = selClip(); tx('rename clip', (p) => { clipById(p, c.id).name = $('clipName').value; }, `name:${c.id}`); };
  $('clipTitle').oninput = () => { const c = selClip(); tx('edit title', (p) => { const cc = clipById(p, c.id); cc.title = $('clipTitle').value; cc.titleEdited = true; }, `title:${c.id}`); };
  [$('clipName'), $('clipTitle')].forEach((el) => { el.onblur = () => endGesture(); el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); }; });
  $('ranges').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const c = selClip(), i = +b.dataset.r;
    if (b.dataset.d) { const r = c.ranges[i]; setRangeTime(i, b.dataset.k, r[b.dataset.k] + (+b.dataset.d) * (e.shiftKey ? 10 : 1), false); return; }
    const op = b.dataset.op;
    if (op === 'rm') { tx('delete range', (p) => { clipById(p, c.id).ranges.splice(i, 1); }); R.ri = 0; goTo(0); }
    if (op === 'up' || op === 'down') { const j = i + (op === 'up' ? -1 : 1); tx('reorder ranges', (p) => { const rs = clipById(p, c.id).ranges; [rs[i], rs[j]] = [rs[j], rs[i]]; }); }
  });
  $('ranges').addEventListener('change', (e) => {
    const el = e.target.closest('input.tc'); if (!el) return;
    const t = parseTime(el.value);
    if (Number.isFinite(t)) setRangeTime(+el.dataset.r, el.dataset.k, t, false);
    el.blur(); renderInspector();
  });
  $('ranges').addEventListener('keydown', (e) => {
    const el = e.target.closest('input.tc'); if (!el) return;
    if (e.key === 'Enter') { e.preventDefault(); el.dispatchEvent(new Event('change', { bubbles: true })); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      const c = selClip(), i = +el.dataset.r, k = el.dataset.k;
      setRangeTime(i, k, c.ranges[i][k] + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 1 : 0.1));
      el.value = tc(selClip().ranges[i][k]);
    }
  });
  $('pausesBtn').onclick = () => { $('pausesBox').hidden = !$('pausesBox').hidden; if (!$('pausesBox').hidden) planPauses(); };
  $('pauseMin').oninput = planPauses; $('pauseThr').oninput = planPauses;
  $('pauseApply').onclick = applyPauses; $('pauseCancel').onclick = () => { $('pausesBox').hidden = true; };
  $('rotL').onclick = () => { const c = selClip(); setStyle('rotate', ((effStyle(c).rotate || 0) + 270) % 360, 'rotate', false); };
  $('rotR').onclick = () => { const c = selClip(); setStyle('rotate', ((effStyle(c).rotate || 0) + 90) % 360, 'rotate', false); };
  $('presets').addEventListener('click', (e) => {
    const del = e.target.closest('[data-delpreset]');
    if (del) { e.stopPropagation(); const all = JSON.parse(localStorage.getItem('omniclip:presets') || '{}'); delete all[del.dataset.delpreset]; localStorage.setItem('omniclip:presets', JSON.stringify(all)); renderInspector(); return; }
    const b = e.target.closest('[data-preset]'); if (!b) return;
    const all = renderPresets(effStyle(selClip())), p = all[b.dataset.preset];
    const c = selClip();
    tx(`apply preset ${p.label}`, (pp) => { const cc = clipById(pp, c.id); for (const k of CAPTION_KEYS) if (k in p && k !== 'y') cc.style[k] = p[k]; });
  });
  qsa('.panel-actions').forEach((box) => box.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    const keys = box.dataset.keys.split(','), c = selClip(); if (!c) return;
    const s = effStyle(c);
    if (act === 'applyAll') {
      tx('apply to all clips', (p) => { for (const k of keys) { p.defaults[k] = s[k]; for (const cc of p.clips) delete cc.style[k]; } });
      announce('Applied to every clip, and to new clips. Ctrl+Z undoes it.');
    } else if (act === 'reset') {
      tx('reset style', (p) => { const cc = clipById(p, c.id); for (const k of keys) delete cc.style[k]; });
    } else if (act === 'savePreset') {
      const name = await ask('Save caption preset', '<label class="field"><span>Preset name</span><input id="presetName" maxlength="24" placeholder="My series"></label>', [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', solid: true }]);
      const n = name === 'ok' ? document.getElementById('presetName').value.trim() : '';
      if (!n) return;
      const all = JSON.parse(localStorage.getItem('omniclip:presets') || '{}');
      all[n] = Object.fromEntries(CAPTION_KEYS.filter((k) => k !== 'y').map((k) => [k, s[k]]));
      localStorage.setItem('omniclip:presets', JSON.stringify(all));
      renderInspector();
      announce(`Saved the preset “${n}” on this device.`);
    }
  }));
  $('trackBtn').onclick = async () => {
    const c = selClip(); if (!c) return;
    const s = effStyle(c);
    $('trackBtn').disabled = true;
    try {
      for (let i = 0; i < c.ranges.length; i++) {
        const r = c.ranges[i];
        const vv = thumbVids[r.src] ||= await openVideo(R.urls[r.src]);
        $('trackBtn').textContent = `Finding the speaker… ${i + 1}/${c.ranges.length}`;
        R.follow[followKey(c, r)] = await trackSpeaker(R.urls[r.src], r, cropFraction(s, vv.videoWidth, vv.videoHeight), (p) => { $('trackBtn').textContent = `Finding the speaker… ${Math.round(((i + p) / c.ranges.length) * 100)}%`; });
      }
      announce(c.ranges.some((r) => R.follow[followKey(c, r)]) ? 'Speaker found. The Output preview now follows them.' : 'No clear face was found; the crop stays where you put it.');
    } catch (e) { announce(`Couldn’t look for faces: ${e.message}`); }
    $('trackBtn').disabled = false; $('trackBtn').textContent = 'Find the speaker now';
    renderInspector(); requestDraw();
  };
  $('ovAdd').onclick = () => { $('ovFile').value = ''; $('ovFile').click(); };
  $('ovFile').onchange = async () => {
    const f = $('ovFile').files[0], c = selClip(); if (!f || !c) return;
    if (f.size > 200e6) { announce('That overlay is over 200 MB. Use a smaller image or a short video.'); return; }
    const id = uid('a');
    try { await dbPut('assets', id, f); } catch (e) { announce(`Couldn’t store the overlay on this device: ${e.message}`); return; }
    tx('add overlay', (p) => {
      p.assets[id] = { name: f.name, type: f.type, size: f.size };
      clipById(p, c.id).overlay = { asset: id, kind: f.type.startsWith('video') ? 'video' : 'image', x: 0.92, y: 0.06, w: 0.24, opacity: 1, start: 0, end: null };
    });
  };
  $('ovRemove').onclick = () => { const c = selClip(); tx('remove overlay', (p) => { clipById(p, c.id).overlay = null; }); };
  qsa('[data-ov]').forEach((el) => el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
    const c = selClip(), k = el.dataset.ov;
    const v = el.value.trim() === '' ? null : parseTime(el.value) >= 0 && k !== 'w' && k !== 'x' && k !== 'y' && k !== 'opacity' ? parseTime(el.value) : +el.value;
    tx('adjust overlay', (p) => { clipById(p, c.id).overlay[k] = v; }, `ov:${k}:${c.id}`);
  }));
  $('exportOne').onclick = () => { const c = selClip(); if (c) enqueue(c); };
  $('fastExport').onchange = () => { R.fast = $('fastExport').checked; localStorage.setItem('omniclip:fast', R.fast ? '1' : '0'); };
  $('clipSrt').onclick = () => { const c = selClip(); const cues = c && clipCues(c); if (!cues?.length) { announce('This clip has no transcript lines to export.'); return; } saveFile(`${base()}-${safeName(c.name)}.srt`, toSRT(cues), 'text/plain'); };
  $('dupAspect').onclick = async () => {
    const c = selClip(); if (!c) return;
    const a = await ask('Duplicate in another shape', '<p>Makes a copy with the same cuts and captions in a new shape. Adjust its framing afterwards.</p>', [{ label: '9:16', value: '9:16' }, { label: '4:5', value: '4:5' }, { label: '1:1', value: '1:1' }, { label: '16:9', value: '16:9', solid: true }]);
    if (a) duplicateClip(c, { style: { aspect: a }, name: `${c.name} (${a})` });
  };

  // tray
  $('trayList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-jop]'); if (!b) return;
    const j = R.jobs.find((x) => x.id === b.dataset.job); if (!j) return;
    if (b.dataset.jop === 'cancel') { if (j.state === 'queued') { j.state = 'cancelled'; renderTray(); renderBin(); } else j.ctrl?.abort(); }
    if (b.dataset.jop === 'retry') { j.state = 'queued'; j.progress = 0; j.error = null; j.recT0 = null; renderTray(); runQueue(); }
    if (b.dataset.jop === 'remove') { if (j.url) URL.revokeObjectURL(j.url); R.jobs.splice(R.jobs.indexOf(j), 1); renderTray(); renderBin(); renderInspector(); }
  });
  $('trayClear').onclick = () => { R.jobs = R.jobs.filter((j) => { const keep = ['queued', 'running'].includes(j.state); if (!keep && j.url) URL.revokeObjectURL(j.url); return keep; }); renderTray(); renderBin(); renderInspector(); };
  $('trayToggle').onclick = () => { const col = $('tray').classList.toggle('collapsed'); $('trayToggle').textContent = col ? '▴' : '▾'; $('trayToggle').setAttribute('aria-expanded', String(!col)); };
  $('trayZip').onclick = async () => {
    const ready = R.jobs.filter((j) => j.state === 'ready');
    $('trayZip').disabled = true; $('trayZip').textContent = 'Packing…';
    try { saveFile(`${base()}-shorts.zip`, await zip(ready.map((j) => ({ name: j.name, blob: j.blob })))); } catch (e) { announce(`Couldn’t make the ZIP: ${e.message}`); }
    $('trayZip').textContent = 'Download all (.zip)'; renderTray();
  };
  document.addEventListener('visibilitychange', updateHiddenTitle);

  // keyboard
  addEventListener('keydown', onKey);
}
function marks() {
  const a = R.inMark, b = R.outMark;
  if (!a || !b || a.src !== b.src || b.t - a.t < MIN_LEN) return null;
  return { src: a.src, start: a.t, end: b.t };
}
function renderMarks() {
  $('inVal').textContent = R.inMark ? tc(R.inMark.t) : '–';
  $('outVal').textContent = R.outMark ? tc(R.outMark.t) : '–';
  const io = marks();
  $('addRange').disabled = !io || !selClip(); $('newFromIO').disabled = !io;
}
function wireTabs(sel, show) {
  const tabs = qsa(`${sel} [role="tab"]`);
  tabs.forEach((t, i) => (t.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    show(tabs[j].id); tabs[j].focus();
  }));
}
function showTabIn(sel, id) {
  qsa(`${sel} [role="tab"]`).forEach((t) => {
    const on = t.id === id;
    t.classList.toggle('active', on); t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  });
}
export function showBinTab(id) { showTabIn('#bin .tabs', id); if (id === 'tabTranscript') highlightTranscript(true); }
export function showInspTab(id) { showTabIn('#inspector .tabs', id); }

function onKey(e) {
  if (!project() || $('work').hidden) return;
  const t = e.target;
  const typing = t.closest?.('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea, [contenteditable="plaintext-only"], [contenteditable="true"]');
  if (document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
    if (typing) return; // native text undo inside fields
    e.preventDefault();
    const l = (e.key === 'y' || e.shiftKey) ? redo() : undo();
    if (l) announce(`${e.key === 'y' || e.shiftKey ? 'Redid' : 'Undid'} ${l}`);
    return;
  }
  if (mod && e.key === 's') { e.preventDefault(); saveNow(); announce('Saved on this device.'); return; }
  if (typing || mod || e.altKey || !R.singleKeys) return;
  if (t.closest?.('[role="tablist"], .seg, input[type="range"], .crop-handle, video, #timeline')) return;
  const k = e.key;
  if (k === ' ' && !t.closest?.('button, a, .clip')) { e.preventDefault(); togglePlay(); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    const d = (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 0.1);
    if (R.view === 'source') player().currentTime = Math.max(0, player().currentTime + d); else { pause(); goTo(R.playT + d); }
  } else if ((k === 'ArrowDown' || k === 'ArrowUp') && !t.closest?.('.clip')) {
    const list = sortedClips(); if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(selClip());
    selectClip(list[Math.max(0, Math.min(list.length - 1, i + (k === 'ArrowDown' ? 1 : -1)))].id);
  } else if (k === 's' || k === 'S') { e.preventDefault(); splitAtPlayhead(); }
  else if ((k === 'i' || k === 'I') && R.view === 'source') { e.preventDefault(); $('markIn').click(); }
  else if ((k === 'o' || k === 'O') && R.view === 'source') { e.preventDefault(); $('markOut').click(); }
  else if ((k === 'e' || k === 'E') && selClip()) { e.preventDefault(); enqueue(selClip()); }
}
