import { decodeAudioStream, canStreamDecode } from './decode-stream.js';
import { exportClip, exportExt, exportMime, clipWords } from './export.js';
import { pickModel, loadLLM, instantClips, rateClip, rank, fmt } from './clips.js';

const $ = (id) => document.getElementById(id);
const state = { segments: [], clips: [], mine: [], sel: null, file: null, url: null, stopAt: null, thumbs: new Map(), pos: 0.5 };
let nextId = 1;

// ---------- settings (named by what they do; the models behind them stay an implementation detail) ----------
const QUALITY = {
  fast: 'onnx-community/whisper-base',
  better: 'onnx-community/whisper-small',
  best: 'onnx-community/whisper-large-v3-turbo',
};
const FINDER = {
  smart: { model: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', shortlist: 1.5 },
  deep: { model: 'Phi-3.5-mini-instruct-q4f16_1-MLC', shortlist: 2 },
  instant: null,
};
const FINDER_HELP = {
  smart: 'Smart: an on-device AI rates each moment and writes titles (about 1 GB, downloaded once).',
  deep: 'Deep: a stronger on-device AI for fast graphics cards (about 2.2 GB, downloaded once).',
  instant: 'Instant: picks moments from the transcript alone, with nothing extra to download.',
};
const QUALITY_HELP = {
  fast: 'Fast transcription: 200 MB.',
  better: 'Better transcription: 600 MB.',
  best: 'Best transcription: 1.6 GB, for fast graphics cards.',
};
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const finder = () => $('finder').value || 'smart';
const asrModel = () => QUALITY[$('quality').value] || QUALITY.fast;

// Remember the visitor's choices on this device.
const OPT_KEY = 'omniclip:options';
const STYLE_KEY = 'omniclip:style';
function saveOptions() {
  localStorage.setItem(OPT_KEY, JSON.stringify({ finder: finder(), quality: $('quality').value, lang: $('lang').value, count: $('count').value }));
  explainOptions();
}
function loadOptions() {
  try {
    const o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}');
    for (const k of ['finder', 'quality', 'lang', 'count']) if (o[k] && [...$(k).options].some((x) => x.value === String(o[k]))) $(k).value = o[k];
    const s = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}');
    for (const k of ['layout', 'caps', 'title', 'size']) if (s[k]) { const r = document.querySelector(`input[name="${k}"][value="${s[k]}"]`); if (r) r.checked = true; }
    if (typeof s.pos === 'number') state.pos = s.pos;
  } catch { /* first visit */ }
  explainOptions();
}
const saveStyle = () => localStorage.setItem(STYLE_KEY, JSON.stringify({ layout: radio('layout'), caps: radio('caps'), title: radio('title'), size: radio('size'), pos: state.pos }));
function explainOptions() {
  $('optHelp').textContent = `${FINDER_HELP[finder()]} ${QUALITY_HELP[$('quality').value]}`;
}
document.querySelectorAll('#options select').forEach((el) => el.addEventListener('change', saveOptions));
loadOptions();

// ---------- capability check (not awaited at top level: the file picker works immediately) ----------
let hasGPU = false;
const gpuReady = (async () => {
  hasGPU = !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
  if (!hasGPU) {
    $('gpuNote').textContent = 'This browser can’t use your graphics card, so transcription will be slow and moments are picked without AI. For the full experience, use a recent Chrome or Edge on a computer.';
    $('gpuNote').hidden = false;
  }
})();

// ---------- helpers ----------
const setStatus = (t) => { $('status').textContent = t; };
const mb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
const shorts = (n) => `${n} short${n === 1 ? '' : 's'}`;
const eta = (sec) => (sec < 60 ? `${Math.round(sec)}s` : `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`);
const ICON = {
  down: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10m0 0-4-4m4 4 4-4M4 16h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ---------- progress: one floating pill that shows the step that matters now ----------
const STEPS = {
  stDecode: { label: 'Reading the audio', order: 1 },
  stAsr: { label: 'Transcribing', order: 2 },
  stLlm: { label: 'Loading the AI', order: 0 },
  stPick: { label: 'Rating the moments', order: 3 },
};
const progress = {};
function step(id, { active, done, value, info } = {}) {
  const p = (progress[id] ||= { active: false, done: false, value: 0, info: '' });
  if (active) p.active = true;
  if (done) { p.done = true; p.active = false; p.value = 1; }
  if (value !== undefined) p.value = value;
  if (info !== undefined) p.info = info;
  renderProgress();
}
function renderProgress() {
  const live = Object.entries(progress).filter(([, p]) => p.active).sort((a, b) => STEPS[b[0]].order - STEPS[a[0]].order);
  $('progress').hidden = !live.length;
  if (!live.length) return;
  const [id, p] = live[0];
  $('ppText').textContent = STEPS[id].label;
  const extra = live.find(([k]) => k === 'stLlm' && k !== id);
  $('ppStep').textContent = p.info + (extra ? ` · AI ${Math.round(extra[1].value * 100)}%` : '');
  $('ppBar').style.width = `${Math.round(p.value * 100)}%`;
  setStatus(`${STEPS[id].label}${p.info ? ' · ' + p.info : ''}`);
}

// ---------- file input: the drop card or anywhere on the page ----------
$('file').addEventListener('change', (e) => e.target.files[0] && start(e.target.files[0]));
const veil = $('dropVeil');
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (state.file || !e.dataTransfer?.types.includes('Files')) return; dragDepth++; veil.hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; veil.hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; veil.hidden = true;
  const f = e.dataTransfer?.files[0];
  if (f && !state.file) start(f);
});
$('newVideo').onclick = () => {
  if ((exporting || exportQueue.length) && !confirm('An export is still running. Start over anyway?')) return;
  location.href = './';
};

// ---------- side tabs ----------
function showTab(id) {
  document.querySelectorAll('.side-tab').forEach((t) => {
    const on = t.dataset.tab === id;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
    $(t.dataset.tab).hidden = !on;
  });
}
document.querySelectorAll('.side-tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));

// ---------- pipeline ----------
async function start(file) {
  state.file = file;
  document.body.classList.add('working');
  $('setup').hidden = true;
  $('work').hidden = false;
  $('topFile').hidden = false;
  $('newVideo').hidden = false;
  $('fileName').textContent = file.name;
  $('fileMeta').textContent = mb(file.size);
  document.title = `${file.name} · OMNICLIP`;
  state.url = URL.createObjectURL(file);
  $('player').src = state.url;
  $('player').addEventListener('loadedmetadata', () => {
    $('fileMeta').textContent = `${fmt($('player').duration)} · ${mb(file.size)}`;
    const audioOnly = !$('player').videoWidth;
    $('stage').classList.toggle('audio', audioOnly);
    document.querySelector('.dock-group[aria-label="Framing"]').hidden = audioOnly;
    layoutCrop();
  }, { once: true });
  if (!exportMime) $('exNote').textContent = 'This browser can’t record video, so exporting is unavailable here. Use Chrome or Edge on a computer.';
  const t0 = performance.now();
  try {
    await gpuReady;
    const mode = hasGPU ? finder() : 'instant';
    // Load the moment finder while transcription runs, so its download overlaps.
    const llmReady = mode === 'instant' ? null : loadPicker(FINDER[mode].model);
    llmReady?.catch(() => {}); // surfaced below
    const cached = await dbGet(transcriptKey()).catch(() => null);
    if (cached?.segments?.length) {
      state.segments = cached.segments;
      addTranscript(state.segments);
      $('srt').disabled = false;
    } else {
      const audio = await decode(file);
      await transcribe(audio);
      saveTranscript();
    }
    if (!state.segments.length) throw new Error('No speech was found in this file.');
    if (mode === 'instant') pickInstant();
    else { await llmReady; await pickSmart(+$('count').value, FINDER[mode].shortlist); }
    setStatus(`Done in ${eta((performance.now() - t0) / 1000)} · ${shorts(allClips().length)} ready to export${state.aiFailed ? ' · the on-device AI stopped responding, so moments were picked from the transcript' : ''}`);
  } catch (err) {
    console.error(err);
    for (const p of Object.values(progress)) p.active = false;
    renderProgress();
    const msg = 'Something went wrong: ' + (err.message || err);
    setStatus(msg);
    $('resultsSub').textContent = msg;
    $('clipsEmpty').classList.add('failed');
  }
}

async function decode(file) {
  step('stDecode', { active: true, info: mb(file.size) });
  const mp4ish = /mp4|quicktime|m4a|m4v/.test(file.type) || /\.(mp4|mov|m4a|m4v)$/i.test(file.name);
  const streamed = async () => {
    const audio = await decodeAudioStream(file, (p) => step('stDecode', { value: p, info: `${mb(file.size * p)} / ${mb(file.size)}` }));
    step('stDecode', { done: true });
    return audio;
  };
  // Big MP4/MOV files: stream the audio out instead of loading the whole file.
  if (mp4ish && canStreamDecode() && (file.size > 300e6 || window.__forceStreamDecode)) return streamed();
  try {
    return await decodeWhole(file);
  } catch (err) {
    if (mp4ish && canStreamDecode()) { console.warn('[omniclip] whole-file decode failed, streaming instead', err); return streamed(); }
    throw err;
  }
}

async function decodeWhole(file) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  ctx.close();
  let mono = buf.getChannelData(0);
  if (buf.numberOfChannels > 1) {
    const r = buf.getChannelData(1);
    mono = mono.map((v, i) => (v + r[i]) / 2);
  }
  step('stDecode', { done: true });
  return mono;
}

function transcribe(audio) {
  return new Promise((resolve, reject) => {
    step('stAsr', { active: true, value: 0, info: 'starting…' });
    const worker = new Worker('./asr-worker.js', { type: 'module' });
    const dl = {};
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'download') {
        dl[m.file] = m;
        const loaded = Object.values(dl).reduce((s, d) => s + d.loaded, 0);
        const total = Object.values(dl).reduce((s, d) => s + d.total, 0);
        step('stAsr', { value: loaded / total, info: `loading ${mb(loaded)} / ${mb(total)}` });
      } else if (m.type === 'segments') {
        state.segments.push(...m.segments);
        addTranscript(m.segments);
        const left = (m.elapsed / m.done) * (m.total - m.done);
        step('stAsr', { value: m.done / m.total, info: `${fmt(m.done)} / ${fmt(m.total)} · ${eta(left)} left` });
      } else if (m.type === 'finished') {
        step('stAsr', { done: true });
        $('srt').disabled = false;
        worker.terminate();
        resolve();
      } else if (m.type === 'error') {
        worker.terminate();
        reject(new Error(m.text));
      }
    };
    worker.postMessage({ audio, model: asrModel(), language: $('lang').value, device: hasGPU ? 'webgpu' : 'wasm' }, [audio.buffer]);
  });
}

async function loadPicker(preferred) {
  step('stLlm', { active: true, info: 'starting…' });
  const model = await pickModel(preferred);
  await loadLLM(model, (p, text) => {
    const m = text.match(/(\d+)MB/);
    step('stLlm', { value: p, info: m ? `loading ${m[1]} MB` : Math.round(p * 100) + '%' });
  });
  step('stLlm', { done: true });
}

const allClips = () => [...state.mine, ...state.clips];
const tag = (list) => { for (const c of list) c.id ||= nextId++; return list; };

// Smart: transcript signals set the cuts and show at once; the on-device AI then
// rates and titles each one, and the list re-sorts as its verdicts come in.
async function pickSmart(n, factor) {
  const shortlist = tag(instantClips(state.segments, Math.ceil(n * factor)));
  state.clips = shortlist.slice(0, n);
  showClips();
  step('stPick', { active: true, value: 0, info: `0 / ${shortlist.length}` });
  const t0 = performance.now();
  let failures = 0;
  for (let i = 0; i < shortlist.length; i++) {
    const c = shortlist[i];
    try {
      const r = await rateClip({ ...c });
      c.score = r.score;
      if (!c._titleEdited) c.title = r.title;
    } catch (e) {
      console.warn(e);
      // The graphics card gave up (common on weak GPUs): keep the transcript picks instead of failing every clip.
      if (++failures >= 2) { state.aiFailed = true; break; }
    }
    const el = (performance.now() - t0) / 1000;
    step('stPick', { value: (i + 1) / shortlist.length, info: `${i + 1} / ${shortlist.length} · ${eta((el / (i + 1)) * (shortlist.length - i - 1))} left` });
    state.clips = rank(shortlist, n);
    showClips();
  }
  step('stPick', { done: true });
  finishResults();
}

function pickInstant() {
  state.clips = tag(instantClips(state.segments, +$('count').value));
  finishResults();
}

function finishResults() {
  showClips();
  if (!allClips().length) {
    $('resultsSub').textContent = 'No clear moments found. Open the transcript, select some lines and make your own short.';
    $('clipsEmpty').classList.add('failed');
  }
}

// ---------- clip list ----------
function showClips() {
  const list = allClips();
  $('clipCount').textContent = list.length || '';
  $('clipsEmpty').hidden = list.length > 0;
  $('json').disabled = !list.length;
  $('exAll').disabled = !list.length || !exportMime;
  $('exAllLabel').textContent = list.length > 1 ? `Export all ${list.length} shorts` : 'Export all';
  $('clips').innerHTML = '';
  list.forEach((c, i) => {
    const el = document.createElement('article');
    el.className = 'clip';
    el.tabIndex = 0;
    el.innerHTML = `
      <div class="thumb"><span class="dur"></span></div>
      <div class="clip-body"><h3></h3><div class="meta"></div></div>
      <div class="clip-state"></div>`;
    el.onclick = (e) => { if (!e.target.closest('.clip-state')) select(c); };
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(c, true); } };
    c._el = el;
    renderClipText(c, i);
    renderExportState(c);
    setThumb(c, el);
    $('clips').append(el);
  });
  if (!state.sel || !list.includes(state.sel)) {
    const keep = state.sel && list.find((c) => c.id === state.sel.id);
    if (keep || list[0]) select(keep || list[0], false, true);
    else $('selected').hidden = true;
  } else {
    state.sel._el.classList.add('selected');
    renderSelected();
  }
}

function renderClipText(c, i = allClips().indexOf(c)) {
  const el = c._el;
  if (!el) return;
  el.querySelector('h3').textContent = c.title;
  const score = typeof c.score === 'number' ? `<b>${c.score}/10</b> · ` : '<b>Your pick</b> · ';
  el.querySelector('.meta').innerHTML = `${score}${fmt(c.start)} · ${Math.round(c.end - c.start)}s`;
  el.querySelector('.dur').textContent = `${Math.round(c.end - c.start)}s`;
  el.setAttribute('aria-label', `Short ${i + 1}: ${c.title}`);
}

// ---------- the selected short ----------
function select(c, play = false, quiet = false) {
  state.sel = c;
  document.querySelectorAll('.clip.selected').forEach((x) => x.classList.remove('selected'));
  c._el?.classList.add('selected');
  $('selected').hidden = false;
  renderSelected();
  const v = $('player');
  if (!quiet || v.paused) {
    if (play) playClip(c);
    else if (!quiet || v.currentTime === 0) { state.stopAt = null; v.pause(); v.currentTime = c.start + 0.05; }
  }
  highlightTranscript(c, !quiet);
}

function renderSelected() {
  const c = state.sel;
  if (!c) return;
  if (document.activeElement !== $('selTitle')) $('selTitle').value = c.title;
  $('selTime').textContent = `${fmt(c.start)} – ${fmt(c.end)} · ${Math.round(c.end - c.start)}s${typeof c.score === 'number' ? ` · scored ${c.score}/10` : ''}`;
  const busy = c._progress != null, queued = exportQueue.includes(c) && !busy;
  const btn = $('selExport');
  btn.disabled = busy || queued || !exportMime;
  btn.innerHTML = busy ? 'Exporting…' : queued ? 'Queued' : c._blobUrl ? `${ICON.check} Saved · export again` : `${ICON.down} Export`;
  $('selProgress').hidden = !busy;
  if (busy) {
    $('selProgress').querySelector('i').style.width = `${Math.round(c._progress * 100)}%`;
    $('selProgress').querySelector('.lbl').textContent = `${c._label || 'Exporting'} ${Math.round(c._progress * 100)}%`;
  }
}

$('selTitle').oninput = () => {
  const c = state.sel;
  if (!c) return;
  c.title = $('selTitle').value;
  c._titleEdited = true;
  c._blobUrl = null;
  renderClipText(c);
  renderExportState(c);
};
$('selTitle').onkeydown = (e) => { if (e.key === 'Enter') $('selTitle').blur(); };
$('selPlay').onclick = () => state.sel && playClip(state.sel);
$('selExport').onclick = () => state.sel && queueExport(state.sel);
document.querySelectorAll('.selected .nudge button').forEach((b) => {
  b.onclick = () => {
    const c = state.sel;
    if (!c) return;
    const d = +b.dataset.d;
    if (b.dataset.k === 'start') c.start = Math.max(0, Math.min(c.end - 5, c.start + d));
    else c.end = Math.max(c.start + 5, Math.min($('player').duration || Infinity, c.end + d));
    c.text = clipWords(state.segments, c.start, c.end).map((w) => w.w).join(' ');
    c._blobUrl = null;
    renderClipText(c);
    renderExportState(c);
    renderSelected();
    highlightTranscript(c, false);
    if (b.dataset.k === 'start') { setThumb(c, c._el); state.stopAt = null; $('player').pause(); $('player').currentTime = c.start + 0.05; }
    else { $('player').pause(); $('player').currentTime = Math.max(c.start, c.end - 2); }
  };
});

function playClip(c) {
  const v = $('player');
  state.stopAt = c.end;
  v.currentTime = c.start;
  v.play();
  if (innerWidth <= 900) $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('player').addEventListener('timeupdate', () => {
  const v = $('player');
  if (state.stopAt !== null && v.currentTime >= state.stopAt) { v.pause(); state.stopAt = null; }
});
$('player').addEventListener('play', () => $('stage').classList.add('playing'));
$('player').addEventListener('pause', () => $('stage').classList.remove('playing'));

function highlightTranscript(c, scroll) {
  let first = null;
  document.querySelectorAll('#transcript p[data-t]').forEach((p) => {
    const on = +p.dataset.t >= c.start - 0.01 && +p.dataset.t < c.end;
    p.classList.toggle('inclip', on);
    if (on && !first) first = p;
  });
  if (scroll && !$('transcriptPane').hidden) first?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- 9:16 crop preview on the player (drag to choose the framing) ----------
function layoutCrop() {
  const v = $('player'), box = $('crop'), layout = radio('layout');
  if (!v.videoWidth || layout === 'blur' || v.videoWidth / v.videoHeight <= 9 / 16 + 0.01) { box.hidden = true; return; }
  const W = v.clientWidth, H = v.clientHeight, s = Math.min(W / v.videoWidth, H / v.videoHeight);
  const cw = v.videoWidth * s, ch = v.videoHeight * s, cx = (W - cw) / 2, cy = (H - ch) / 2;
  const bw = (ch * 9) / 16;
  Object.assign(box.style, { left: `${cx + (cw - bw) * state.pos}px`, top: `${cy}px`, width: `${bw}px`, height: `${ch}px` });
  box.hidden = false;
  box.classList.toggle('auto', layout === 'auto');
  $('cropLabel').textContent = layout === 'auto' ? 'Follows the speaker' : 'Drag to frame';
  box._range = cw - bw;
}
new ResizeObserver(layoutCrop).observe($('stage'));
(() => {
  const h = $('cropHandle');
  let x0 = 0, p0 = 0, dragging = false;
  h.addEventListener('pointerdown', (e) => {
    if (radio('layout') !== 'crop') return;
    dragging = true; x0 = e.clientX; p0 = state.pos; h.setPointerCapture(e.pointerId);
  });
  h.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const range = $('crop')._range || 1;
    state.pos = Math.max(0, Math.min(1, p0 + (e.clientX - x0) / range));
    layoutCrop();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    saveStyle();
    refreshThumbs();
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
  h.addEventListener('keydown', (e) => {
    if (radio('layout') !== 'crop' || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    state.pos = Math.max(0, Math.min(1, state.pos + (e.key === 'ArrowLeft' ? -0.05 : 0.05)));
    layoutCrop(); saveStyle(); refreshThumbs();
  });
})();
function refreshThumbs() {
  state.thumbs.clear();
  allClips().forEach((c) => c._el && setThumb(c, c._el));
  allClips().forEach((c) => { c._blobUrl = null; renderExportState(c); });
  renderSelected();
}

// Export style changes: the crop preview follows, and earlier exports no longer match.
document.querySelectorAll('.dock input').forEach((r) => r.addEventListener('change', () => {
  saveStyle();
  layoutCrop();
  allClips().forEach((c) => { c._blobUrl = null; renderExportState(c); });
  renderSelected();
}));

// 9:16 preview frame for each clip, grabbed from the source (sequentially, cached).
let thumbVideo = null;
let thumbChain = Promise.resolve();
function setThumb(c, el) {
  const key = c.start.toFixed(2);
  const thumb = el.querySelector('.thumb');
  const put = (src) => {
    const target = c._el?.querySelector('.thumb') || thumb;
    target.querySelector('img, .wave')?.remove();
    if (src === 'audio') {
      const w = document.createElement('span');
      w.className = 'wave';
      let seed = Math.floor(c.start * 97) || 7;
      for (let k = 0; k < 7; k++) { seed = (seed * 9301 + 49297) % 233280; const i = document.createElement('i'); i.style.height = `${14 + (seed / 233280) * 40}%`; w.append(i); }
      target.prepend(w);
    } else {
      const img = document.createElement('img');
      img.alt = ''; img.src = src;
      target.prepend(img);
    }
  };
  if (state.thumbs.has(key)) { put(state.thumbs.get(key)); return; }
  thumbChain = thumbChain.then(async () => {
    if (state.thumbs.has(key)) { put(state.thumbs.get(key)); return; }
    try {
      if (!thumbVideo) {
        thumbVideo = document.createElement('video');
        thumbVideo.muted = true; thumbVideo.preload = 'auto'; thumbVideo.src = state.url;
        await new Promise((r, j) => { thumbVideo.onloadeddata = r; thumbVideo.onerror = j; setTimeout(r, 8000); });
      }
      const v = thumbVideo;
      if (!v.videoWidth) { state.thumbs.set(key, 'audio'); put('audio'); return; }
      v.currentTime = Math.min((v.duration || c.start + 1) - 0.05, c.start + 0.6);
      await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); });
      const cv = document.createElement('canvas');
      cv.width = 180; cv.height = 320;
      const scale = Math.max(180 / v.videoWidth, 320 / v.videoHeight);
      const sw = 180 / scale, sh = 320 / scale;
      cv.getContext('2d').drawImage(v, (v.videoWidth - sw) * state.pos, (v.videoHeight - sh) / 2, sw, sh, 0, 0, 180, 320);
      const url = cv.toDataURL('image/jpeg', 0.78);
      state.thumbs.set(key, url);
      put(url);
    } catch (e) { console.warn('[omniclip] thumbnail failed', e); }
  });
}

// ---------- export ----------
const exportQueue = [];
let exporting = false;

function exportOpts() {
  const w = +radio('size');
  return {
    width: w, height: Math.round((w * 16) / 9),
    layout: radio('layout'),
    pos: state.pos,
    captions: radio('caps'),
    title: radio('title'),
  };
}

function renderExportState(c) {
  const el = c._el;
  if (el) {
    const box = el.querySelector('.clip-state');
    const busy = c._progress != null, queued = exportQueue.includes(c) && !busy;
    if (busy) {
      const r = 13, len = 2 * Math.PI * r;
      box.innerHTML = `<svg class="ring" viewBox="0 0 32 32" role="img" aria-label="Exporting ${Math.round(c._progress * 100)}%"><circle class="bg" cx="16" cy="16" r="${r}"/><circle class="fg" cx="16" cy="16" r="${r}" stroke-dasharray="${len}" stroke-dashoffset="${len * (1 - c._progress)}"/></svg>`;
    } else if (queued) {
      box.innerHTML = '<span class="queued">Queued</span>';
    } else if (c._blobUrl) {
      box.innerHTML = `<a class="icon-btn done" title="Saved · download again">${ICON.check}</a>`;
      const a = box.querySelector('a');
      a.href = c._blobUrl; a.download = c._fileName;
    } else {
      box.innerHTML = `<button class="icon-btn" type="button" title="Export this short">${ICON.down}</button>`;
      const b = box.querySelector('button');
      b.disabled = !exportMime;
      b.onclick = () => queueExport(c);
    }
  }
  if (c === state.sel) renderSelected();
}

function queueExport(c) {
  if (exportQueue.includes(c) || c._progress != null) return;
  exportQueue.push(c);
  renderExportState(c);
  runQueue();
}

async function runQueue() {
  if (exporting) return;
  exporting = true;
  while (exportQueue.length) {
    const c = exportQueue[0];
    c._progress = 0;
    renderExportState(c);
    try {
      const t0 = performance.now();
      const blob = await exportClip({
        url: state.url, clip: c, segments: state.segments, opts: exportOpts(),
        onProgress: (p, label) => {
          c._progress = p; c._label = label; renderExportState(c);
          setStatus(`Exporting “${c.title}” · ${Math.round(p * 100)}%${exportQueue.length > 1 ? ` · ${exportQueue.length - 1} more in line` : ''}`);
        },
      });
      const n = allClips().indexOf(c) + 1 || 1;
      c._fileName = `${base()}-short-${n}-${c.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40)}.${exportExt}`;
      c._blobUrl = URL.createObjectURL(blob);
      console.log(`[omniclip] exported ${c._fileName} ${(blob.size / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      const a = document.createElement('a');
      a.href = c._blobUrl; a.download = c._fileName; a.click();
      setStatus(`Saved ${c._fileName}`);
    } catch (err) {
      console.error(err);
      setStatus('Export failed: ' + (err.message || err));
      alert('Export failed: ' + (err.message || err));
    }
    c._progress = null;
    exportQueue.shift();
    renderExportState(c);
  }
  exporting = false;
}

$('exAll').onclick = () => allClips().forEach((c) => { if (!c._blobUrl) queueExport(c); });

// ---------- transcript: times jump the player; text is editable (captions use the fix) ----------
function addTranscript(segs) {
  $('transcriptEmpty')?.remove();
  for (const s of segs) {
    const i = state.segments.indexOf(s);
    const p = document.createElement('p');
    p.dataset.t = s.start;
    p.dataset.i = i;
    const time = document.createElement('time');
    time.textContent = fmt(s.start);
    time.title = 'Play from here';
    time.onclick = () => { state.stopAt = null; $('player').currentTime = s.start; $('player').play(); };
    const text = document.createElement('span');
    text.className = 't';
    text.contentEditable = 'plaintext-only';
    text.spellcheck = false;
    text.textContent = s.text;
    text.oninput = () => {
      s.text = text.textContent.replace(/\s+/g, ' ').trim();
      s._edited = true;
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(saveTranscript, 400);
    };
    text.onblur = () => {
      if (!s._edited) return;
      s._edited = false;
      allClips().forEach((c) => {
        if (c.end > s.start && c.start < s.end) { c.text = clipWords(state.segments, c.start, c.end).map((w) => w.w).join(' '); c._blobUrl = null; renderExportState(c); }
      });
    };
    text.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); text.blur(); } };
    p.append(time, text);
    $('transcript').append(p);
  }
}

$('fromSel').onclick = () => {
  const sel = window.getSelection();
  const ps = [sel.anchorNode, sel.focusNode]
    .map((n) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest('#transcript p[data-i]'))
    .filter(Boolean);
  if (!ps.length || sel.isCollapsed) { setStatus('Select some lines in the transcript first: click and drag over the text.'); alert('Select some lines in the transcript first: click and drag over the text, then press this button.'); return; }
  const idx = ps.map((p) => +p.dataset.i).sort((a, b) => a - b);
  const a = state.segments[idx[0]], b = state.segments[idx[idx.length - 1]];
  const clip = {
    id: nextId++,
    start: a.start, end: b.end,
    title: a.text.replace(/[.!?,]$/, '').split(/\s+/).slice(0, 8).join(' '),
    hook: 'Your own pick', score: '★',
    text: clipWords(state.segments, a.start, b.end).map((w) => w.w).join(' '),
  };
  state.mine.unshift(clip);
  $('clipsEmpty').classList.remove('failed');
  showClips();
  sel.removeAllRanges();
  showTab('clipsPane');
  select(clip);
  setStatus('Added your own short');
};

// ---------- remembered transcripts (IndexedDB, on this device only) ----------
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('omniclip', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('transcripts');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbGet(key) {
  const d = await db();
  return new Promise((res) => { const q = d.transaction('transcripts').objectStore('transcripts').get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
}
async function dbSet(key, val) {
  const d = await db();
  return new Promise((res) => { const tx = d.transaction('transcripts', 'readwrite'); tx.objectStore('transcripts').put(val, key); tx.oncomplete = res; tx.onerror = res; });
}
const transcriptKey = () => {
  const f = state.file;
  return `${f.name}|${f.size}|${f.lastModified}|${asrModel()}|${$('lang').value}`;
};
function saveTranscript() {
  if (state.file && state.segments.length) dbSet(transcriptKey(), { segments: state.segments, saved: Date.now() }).catch(() => {});
}

// ---------- downloads ----------
function save(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
}
const base = () => (state.file?.name || 'video').replace(/\.[^.]+$/, '');
const srtTime = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};
$('srt').onclick = () => save(base() + '.srt',
  state.segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n'),
  'text/plain');
$('json').onclick = () => save(base() + '.shorts.json', JSON.stringify(allClips().map(({ _el, _blobUrl, _progress, _label, _fileName, _titleEdited, id, ...c }) => c), null, 2), 'application/json');
