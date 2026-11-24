import { decodeAudioStream, canStreamDecode } from './decode-stream.js';
import { exportClip, exportExt, exportMime, clipWords } from './export.js';
import { pickModel, loadLLM, instantClips, rateClip, rank, fmt } from './clips.js';

const $ = (id) => document.getElementById(id);
const state = { segments: [], clips: [], file: null, url: null, stopAt: null, thumbs: new Map() };

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
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const finder = () => radio('finder') || 'smart';
const asrModel = () => QUALITY[radio('quality')] || QUALITY.fast;

// Remember the visitor's options on this device.
const OPT_KEY = 'omniclip:options';
function saveOptions() {
  localStorage.setItem(OPT_KEY, JSON.stringify({ finder: finder(), quality: radio('quality'), lang: $('lang').value, count: $('count').value }));
  summarizeOptions();
}
function loadOptions() {
  try {
    const o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}');
    for (const k of ['finder', 'quality']) if (o[k]) { const r = document.querySelector(`input[name="${k}"][value="${o[k]}"]`); if (r) r.checked = true; }
    if (o.lang) $('lang').value = o.lang;
    if (o.count) $('count').value = o.count;
  } catch { /* first visit */ }
  summarizeOptions();
}
function summarizeOptions() {
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  $('optSummary').textContent = `${cap(finder())} · ${cap(radio('quality'))} · ${$('lang').selectedOptions[0].text} · ${$('count').value} shorts`;
}
document.querySelectorAll('#options input, #options select').forEach((el) => el.addEventListener('change', saveOptions));
loadOptions();

// ---------- capability check (not awaited at top level: the file picker works immediately) ----------
let hasGPU = false;
const gpuReady = (async () => {
  hasGPU = !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
  const note = $('gpuNote');
  if (hasGPU) {
    note.textContent = 'Your browser can use the graphics card. The AI is downloaded once, then loads from cache.';
    note.classList.add('ok');
  } else {
    note.textContent = 'This browser can’t use the graphics card, so transcription will be slow and moments are picked without AI. For the full experience use a recent Chrome or Edge on a computer.';
    note.classList.add('bad');
  }
})();

// ---------- small UI helpers ----------
function step(id, { active, done, value, info } = {}) {
  const li = $(id);
  if (active) li.classList.add('active');
  if (done) { li.classList.add('done'); li.classList.remove('active'); li.querySelector('progress').value = 1; }
  if (value !== undefined) li.querySelector('progress').value = value;
  if (info !== undefined) li.querySelector('.info').textContent = info;
  if (active || value !== undefined) setStatus(`${li.querySelector('.name').textContent}${info ? ' · ' + info : ''}`);
}
const setStatus = (t) => { $('status').textContent = t; };
const mb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
const shorts = (n) => `${n} short${n === 1 ? "" : "s"}`;
const eta = (sec) => (sec < 60 ? `${Math.round(sec)}s` : `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`);
const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.45)"/><path d="M9.6 7.8v8.4l6.6-4.2z" fill="#fff"/></svg>';

// ---------- hero sample short: captions light up word by word ----------
(() => {
  const el = $('demoCaption');
  const lines = [['NOBODY', 'TELLS', 'YOU'], ['THE', 'CHEAPEST', 'CLIENT'], ['WANTS', 'THE', 'MOST.'], ['SO', 'I', 'DOUBLED'], ['MY', 'PRICE.']];
  let li = 0, wi = 0;
  const render = () => { el.innerHTML = lines[li].map((w, i) => `<span class="${i === wi ? 'on' : ''}">${w}</span>`).join(' '); };
  render();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  setInterval(() => {
    if (state.file) return;
    wi++;
    if (wi >= lines[li].length) { wi = 0; li = (li + 1) % lines.length; }
    render();
  }, 380);
})();

// ---------- file input: the drop card, the button, or anywhere on the page ----------
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
  scrollTo(0, 0);
  state.url = URL.createObjectURL(file);
  $('player').src = state.url;
  $('player').addEventListener('loadedmetadata', () => {
    $('fileMeta').textContent = `${fmt($('player').duration)} · ${mb(file.size)}`;
  }, { once: true });
  if (!exportMime) $('exNote').textContent = 'This browser can’t record video, so exporting is unavailable here. Use Chrome or Edge on a computer.';
  const t0 = performance.now();
  try {
    await gpuReady;
    const mode = hasGPU ? finder() : 'instant';
    // Load the moment finder while transcription runs, so its download overlaps.
    const llmReady = mode === 'instant' ? null : loadPicker(FINDER[mode].model);
    llmReady?.catch(() => {}); // surfaced by pickSmart
    const cached = await dbGet(transcriptKey()).catch(() => null);
    if (cached?.segments?.length) {
      state.segments = cached.segments;
      addTranscript(state.segments);
      step('stDecode', { done: true, info: 'skipped' });
      step('stAsr', { done: true, info: `remembered · ${state.segments.length} lines` });
      $('srt').disabled = false;
    } else {
      const audio = await decode(file);
      await transcribe(audio);
      saveTranscript();
    }
    if (!state.segments.length) throw new Error('No speech was found in this file.');
    if (mode === 'instant') pickInstant();
    else { await llmReady; await pickSmart(+$('count').value, FINDER[mode].shortlist); }
    setStatus(`Done in ${eta((performance.now() - t0) / 1000)} · ${shorts(state.clips.length)} ready to export`);
  } catch (err) {
    console.error(err);
    setStatus('Something went wrong: ' + (err.message || err));
    $('resultsSub').textContent = 'Something went wrong: ' + (err.message || err);
    $('clipsEmpty').hidden = true;
  }
}

async function decode(file) {
  step('stDecode', { active: true, info: mb(file.size) });
  const mp4ish = /mp4|quicktime|m4a|m4v/.test(file.type) || /\.(mp4|mov|m4a|m4v)$/i.test(file.name);
  const streamed = async () => {
    const audio = await decodeAudioStream(file, (p) => step('stDecode', { value: p, info: `${mb(file.size * p)} / ${mb(file.size)}` }));
    step('stDecode', { done: true, info: `${fmt(audio.length / 16000)} of audio` });
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
  step('stDecode', { done: true, info: `${fmt(buf.duration)} of audio` });
  return mono;
}

function transcribe(audio) {
  return new Promise((resolve, reject) => {
    step('stAsr', { active: true, info: 'starting…' });
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
        step('stAsr', { done: true, info: `${state.segments.length} lines` });
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
  step('stLlm', { done: true, info: 'ready' });
}

// Smart: transcript signals set the cuts and show at once; the on-device AI then
// rates and titles each one, and the list re-sorts as its verdicts come in.
async function pickSmart(n, factor) {
  const shortlist = instantClips(state.segments, Math.ceil(n * factor));
  state.clips = shortlist.slice(0, n);
  showClips('Rating the best moments…');
  step('stPick', { active: true, info: `0/${shortlist.length}` });
  const rated = [];
  const t0 = performance.now();
  for (let i = 0; i < shortlist.length; i++) {
    try { rated.push(await rateClip(shortlist[i])); } catch (e) { console.warn(e); rated.push(shortlist[i]); }
    const el = (performance.now() - t0) / 1000;
    step('stPick', { value: (i + 1) / shortlist.length, info: `${i + 1}/${shortlist.length} · ${eta((el / (i + 1)) * (shortlist.length - i - 1))} left` });
    state.clips = rank([...rated, ...shortlist.slice(i + 1)], n);
    showClips('Rating the best moments…');
  }
  step('stPick', { done: true, info: shorts(state.clips.length) });
  finishResults('Best first · rated by the on-device AI');
}

function pickInstant() {
  step('stLlm', { done: true, info: 'not needed' });
  state.clips = instantClips(state.segments, +$('count').value);
  step('stPick', { done: true, info: shorts(state.clips.length) });
  finishResults('Best first · picked from the transcript');
}

function finishResults(sub) {
  showClips(state.clips.length ? sub : 'No clear moments found. Select lines in the transcript to make your own.');
  $('json').disabled = !state.clips.length;
  $('exAll').disabled = !state.clips.length || !exportMime;
}

// ---------- clip cards ----------
function showClips(sub) {
  if (sub) $('resultsSub').textContent = `${shorts(state.clips.length)} · ${sub}`;
  $('clipsEmpty').hidden = state.clips.length > 0;
  $('clips').innerHTML = '';
  state.clips.forEach((c, i) => {
    const el = document.createElement('article');
    el.className = 'clip';
    el.style.animationDelay = `${Math.min(i, 8) * 30}ms`;
    el.innerHTML = `
      <button class="thumb" type="button" aria-label="Play this moment"><span class="play">${playIcon}</span><span class="dur"></span></button>
      <div class="clip-body">
        <div class="clip-top"><h3></h3><span class="score"></span></div>
        <div class="meta"></div>
        <p class="hook"></p>
        <p class="text"></p>
        <div class="clip-foot">
          <div class="nudge" title="Move the start"><span>In</span><button data-k="start" data-d="-1" aria-label="Start 1 second earlier">−1s</button><button data-k="start" data-d="1" aria-label="Start 1 second later">+1s</button></div>
          <div class="nudge" title="Move the end"><span>Out</span><button data-k="end" data-d="-1" aria-label="End 1 second earlier">−1s</button><button data-k="end" data-d="1" aria-label="End 1 second later">+1s</button></div>
          <button class="btn btn-sm export" type="button"></button>
          <div class="export-state" hidden><progress value="0" max="1"></progress><span class="lbl"></span></div>
          <a class="dl" hidden>Download again</a>
        </div>
      </div>`;
    el.querySelector('h3').textContent = c.title;
    const score = el.querySelector('.score');
    score.textContent = c.score;
    score.title = typeof c.score === 'number' ? 'Score out of 10' : 'Your own pick';
    score.classList.toggle('mine', typeof c.score !== 'number');
    el.querySelector('.hook').textContent = c.hook || '';
    el.querySelector('.hook').hidden = !c.hook;
    const meta = () => {
      el.querySelector('.meta').textContent = `#${i + 1} · ${fmt(c.start)} → ${fmt(c.end)}`;
      el.querySelector('.dur').textContent = `${Math.round(c.end - c.start)}s`;
    };
    meta();
    el.querySelector('.text').textContent = '“' + c.text + '”';
    el.querySelector('.thumb').onclick = () => playClip(c, el);
    el.querySelector('.export').onclick = () => queueExport(c);
    el.querySelectorAll('.nudge button').forEach((b) => {
      b.onclick = () => {
        const d = +b.dataset.d;
        if (b.dataset.k === 'start') c.start = Math.max(0, Math.min(c.end - 5, c.start + d));
        else c.end = Math.max(c.start + 5, Math.min($('player').duration || Infinity, c.end + d));
        c.text = clipWords(state.segments, c.start, c.end).map((w) => w.w).join(' ');
        el.querySelector('.text').textContent = '“' + c.text + '”';
        meta();
        c._blobUrl = null;
        renderExportState(c);
        if (b.dataset.k === 'start') setThumb(c, el);
      };
    });
    c._el = el;
    renderExportState(c);
    setThumb(c, el);
    $('clips').append(el);
  });
}

// 9:16 preview frame for each clip, grabbed from the source (sequentially, cached).
let thumbVideo = null;
let thumbChain = Promise.resolve();
function setThumb(c, el) {
  const key = c.start.toFixed(2);
  const thumb = el.querySelector('.thumb');
  const put = (src) => {
    thumb.querySelector('img, .wave')?.remove();
    if (src === 'audio') {
      const w = document.createElement('span');
      w.className = 'wave';
      let seed = Math.floor(c.start * 97) || 7;
      for (let k = 0; k < 9; k++) { seed = (seed * 9301 + 49297) % 233280; const i = document.createElement('i'); i.style.height = `${14 + (seed / 233280) * 46}%`; w.append(i); }
      thumb.prepend(w);
    } else {
      const img = document.createElement('img');
      img.alt = ''; img.src = src;
      thumb.prepend(img);
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
      cv.getContext('2d').drawImage(v, (v.videoWidth - sw) * (+$('exPos').value / 100), (v.videoHeight - sh) / 2, sw, sh, 0, 0, 180, 320);
      const url = cv.toDataURL('image/jpeg', 0.78);
      state.thumbs.set(key, url);
      if (el.isConnected) put(url);
      else state.clips.find((x) => x.start.toFixed(2) === key && x._el?.isConnected) && put(url);
    } catch (e) { console.warn('[omniclip] thumbnail failed', e); }
  });
}

// ---------- export ----------
const exportQueue = [];
let exporting = false;

function exportOpts() {
  const w = +$('exSize').value;
  return {
    width: w, height: Math.round((w * 16) / 9),
    layout: $('exLayout').value,
    pos: +$('exPos').value / 100,
    captions: $('exCaps').value,
    title: $('exTitle').value,
  };
}

function renderExportState(c) {
  const el = c._el;
  if (!el) return;
  const btn = el.querySelector('.export'), box = el.querySelector('.export-state'), dl = el.querySelector('.dl');
  const busy = c._progress != null, queued = exportQueue.includes(c) && !busy;
  box.hidden = !busy && !queued;
  box.querySelector('progress').value = busy ? c._progress : 0;
  box.querySelector('.lbl').textContent = busy ? `${c._label || 'Exporting…'} ${Math.round(c._progress * 100)}%` : queued ? 'Waiting in line…' : '';
  btn.disabled = busy || queued || !exportMime;
  btn.textContent = busy ? 'Exporting…' : queued ? 'Queued' : c._blobUrl ? 'Export again' : 'Export';
  btn.classList.toggle('btn-primary', !c._blobUrl && !busy && !queued);
  dl.hidden = !c._blobUrl;
  if (c._blobUrl) { dl.href = c._blobUrl; dl.download = c._fileName; }
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
      const n = state.clips.indexOf(c) + 1 || 1;
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

$('exAll').onclick = () => state.clips.forEach(queueExport);
$('exPos').oninput = () => {
  const v = +$('exPos').value;
  $('exPosVal').textContent = v < 40 ? 'left' : v > 60 ? 'right' : 'center';
};
$('exPos').onchange = () => { state.thumbs.clear(); state.clips.forEach((c) => c._el && setThumb(c, c._el)); };
const syncLayout = () => { $('exPos').disabled = $('exLayout').value === 'blur'; };
$('exLayout').onchange = syncLayout;
syncLayout();

function playClip(c, el) {
  document.querySelectorAll('.clip.playing').forEach((x) => x.classList.remove('playing'));
  el.classList.add('playing');
  const v = $('player');
  state.stopAt = c.end;
  v.currentTime = c.start;
  v.play();
  if (innerWidth <= 980) v.scrollIntoView({ behavior: 'smooth', block: 'center' });
  let first = null;
  document.querySelectorAll('#transcript p').forEach((p) => {
    const on = +p.dataset.t >= c.start - 0.01 && +p.dataset.t < c.end;
    p.classList.toggle('inclip', on);
    if (on && !first) first = p;
  });
  first?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('player').addEventListener('timeupdate', () => {
  const v = $('player');
  if (state.stopAt !== null && v.currentTime >= state.stopAt) { v.pause(); state.stopAt = null; }
});

// ---------- transcript: times jump the player; text is editable (captions use the fix) ----------
function addTranscript(segs) {
  $('transcriptBox').hidden = false;
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
      state.clips.forEach((c) => { if (c.end > s.start && c.start < s.end) c.text = clipWords(state.segments, c.start, c.end).map((w) => w.w).join(' '); });
      showClips();
    };
    text.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); text.blur(); } };
    p.append(time, text);
    $('transcript').append(p);
  }
}

$('fromSel').onclick = () => {
  const sel = window.getSelection();
  const ps = [sel.anchorNode, sel.focusNode]
    .map((n) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest('#transcript p'))
    .filter(Boolean);
  if (!ps.length || sel.isCollapsed) { setStatus('Select one or more lines in the transcript first (click and drag over the text).'); return; }
  const idx = ps.map((p) => +p.dataset.i).sort((a, b) => a - b);
  const a = state.segments[idx[0]], b = state.segments[idx[idx.length - 1]];
  const clip = {
    start: a.start, end: b.end,
    title: a.text.replace(/[.!?,]$/, '').split(/\s+/).slice(0, 8).join(' '),
    hook: 'Your own pick', score: '★',
    text: clipWords(state.segments, a.start, b.end).map((w) => w.w).join(' '),
  };
  state.clips.unshift(clip);
  showClips(null);
  $('resultsSub').textContent = shorts(state.clips.length);
  $('json').disabled = false;
  $('exAll').disabled = !exportMime;
  $('clips').scrollIntoView({ behavior: 'smooth', block: 'start' });
  sel.removeAllRanges();
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
$('json').onclick = () => save(base() + '.shorts.json', JSON.stringify(state.clips.map(({ _el, _blobUrl, _progress, _label, _fileName, ...c }) => c), null, 2), 'application/json');
