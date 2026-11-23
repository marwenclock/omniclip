import { decodeAudioStream, canStreamDecode } from './decode-stream.js';
import { exportClip, exportExt, exportMime, clipWords } from './export.js';
import { pickModel, loadLLM, makeWindows, instantClips, rateClip, scoreWindow, rank, fmt } from './clips.js';

const $ = (id) => document.getElementById(id);
const state = { segments: [], clips: [], file: null, stopAt: null };

// ---------- capability check ----------
// Not awaited at the top level, so the file input works the moment the page shows.
let hasGPU = false;
const gpuReady = (async () => {
  hasGPU = !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
  $('gpuNote').textContent = hasGPU
    ? 'Your browser can use the graphics card (WebGPU). The first run downloads the AI models once; after that they load from the browser cache.'
    : 'This browser has no WebGPU. Transcription will be slow and only Instant mode can pick clips. Use a recent Chrome or Edge.';
  if (!hasGPU) $('gpuNote').classList.add('bad');
})();

// ---------- step UI helpers ----------
function step(id, { active, done, value, info } = {}) {
  const li = $(id);
  if (active) li.classList.add('active');
  if (done) { li.classList.add('done'); li.classList.remove('active'); li.querySelector('progress').value = 1; }
  if (value !== undefined) li.querySelector('progress').value = value;
  if (info !== undefined) li.querySelector('.info').textContent = info;
}
const mb = (b) => (b / 1e6).toFixed(0) + ' MB';
const eta = (sec) => sec < 60 ? `${Math.round(sec)}s` : `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;

// ---------- file input ----------
const drop = $('drop');
$('file').addEventListener('change', (e) => e.target.files[0] && start(e.target.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files[0]) start(e.dataTransfer.files[0]);
});

// ---------- pipeline ----------
async function start(file) {
  state.file = file;
  $('setup').hidden = true;
  $('work').hidden = false;
  state.url = URL.createObjectURL(file);
  $('player').src = state.url;
  if (!exportMime) { $('exAll').disabled = true; $('exNote').textContent = 'This browser cannot record video, so export is unavailable. Use Chrome or Edge.'; }
  const t0 = performance.now();
  try {
    await gpuReady;
    // Fetch and load the clip-picker model while transcription runs, so its
    // download (first run) or GPU upload overlaps with Whisper's work.
    const instant = $('llmModel').value === 'instant' || !hasGPU;
    const llmReady = instant ? null : loadPicker();
    llmReady?.catch(() => {}); // surfaced later by pick()
    const cached = await dbGet(transcriptKey()).catch(() => null);
    if (cached?.segments?.length) {
      // Same file opened before: reuse its transcript (with any edits).
      state.segments = cached.segments;
      addTranscript(state.segments);
      step('stDecode', { done: true, info: 'not needed' });
      step('stAsr', { done: true, info: `remembered from last time · ${state.segments.length} lines` });
      $('srt').disabled = false;
    } else {
      const audio = await decode(file);
      await transcribe(audio);
      saveTranscript();
    }
    if (!state.segments.length) throw new Error('No speech was found in this file.');
    if (instant) pickInstant(); else await pick(llmReady);
    console.log(`[omniclip] total ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(err);
    alert('Something went wrong: ' + (err.message || err));
  }
}

// Decode the file's audio track to 16 kHz mono (the browser resamples for us).
async function decode(file) {
  step('stDecode', { active: true, info: mb(file.size) });
  const mp4ish = /mp4|quicktime|m4a|m4v/.test(file.type) || /\.(mp4|mov|m4a|m4v)$/i.test(file.name);
  const streamed = async () => {
    const audio = await decodeAudioStream(file, (p) => step('stDecode', { value: p, info: `${mb(file.size * p)} / ${mb(file.size)}` }));
    step('stDecode', { done: true, info: `${fmt(audio.length / 16000)} of audio (streamed)` });
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
    step('stAsr', { active: true, info: 'loading model…' });
    const worker = new Worker('./asr-worker.js', { type: 'module' });
    const dl = {};
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'download') {
        dl[m.file] = m;
        const loaded = Object.values(dl).reduce((s, d) => s + d.loaded, 0);
        const total = Object.values(dl).reduce((s, d) => s + d.total, 0);
        step('stAsr', { value: loaded / total, info: `downloading ${mb(loaded)} / ${mb(total)}` });
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
    worker.postMessage({
      audio, model: $('asrModel').value, language: $('lang').value,
      device: hasGPU ? 'webgpu' : 'wasm',
    }, [audio.buffer]);
  });
}

async function loadPicker() {
  step('stLlm', { active: true, info: 'starting…' });
  const model = await pickModel($('llmModel').value);
  await loadLLM(model, (p, text) => {
    const m = text.match(/(\d+)MB/);
    step('stLlm', { value: p, info: m ? `${m[1]} MB loaded` : Math.round(p * 100) + '%' });
  });
  step('stLlm', { done: true, info: model.split('-MLC')[0] });
}

// Smart: instant picks set the cuts and show at once; the AI then rates and
// titles each one, and the list re-sorts as its verdicts come in.
async function pickSmart(n) {
  const shortlist = instantClips(state.segments, Math.ceil(n * 1.5));
  state.clips = shortlist.slice(0, n);
  showClips();
  step('stPick', { active: true, info: `0/${shortlist.length}` });
  const rated = [];
  const t0 = performance.now();
  for (let i = 0; i < shortlist.length; i++) {
    try { rated.push(await rateClip(shortlist[i])); } catch (e) { console.warn(e); rated.push(shortlist[i]); }
    const el = (performance.now() - t0) / 1000;
    step('stPick', { value: (i + 1) / shortlist.length, info: `${i + 1}/${shortlist.length} · ${eta((el / (i + 1)) * (shortlist.length - i - 1))} left` });
    state.clips = rank([...rated, ...shortlist.slice(i + 1)], n);
    showClips();
  }
  step('stPick', { done: true, info: `${state.clips.length} shorts` });
  $('json').disabled = false;
}

function pickInstant() {
  step('stLlm', { done: true, info: 'not needed (instant mode)' });
  state.clips = instantClips(state.segments, +$('count').value);
  showClips();
  step('stPick', { done: true, info: `${state.clips.length} shorts` });
  $('json').disabled = false;
}

async function pick(llmReady) {
  await llmReady;

  const n = +$('count').value;
  if ($('scan').value !== 'all') return pickSmart(n);
  const windows = makeWindows(state.segments, 120);
  step('stPick', { active: true, info: `0/${windows.length}` });
  const found = [];
  const t0 = performance.now();
  for (let i = 0; i < windows.length; i++) {
    try { found.push(await scoreWindow(windows[i])); } catch (e) { console.warn('window failed', e); }
    const el = (performance.now() - t0) / 1000;
    step('stPick', { value: (i + 1) / windows.length, info: `${i + 1}/${windows.length} · ${eta((el / (i + 1)) * (windows.length - i - 1))} left` });
    state.clips = rank(found, +$('count').value);
    showClips();
  }
  step('stPick', { done: true, info: `${state.clips.length} shorts` });
  $('json').disabled = false;
}

// ---------- results ----------
function showClips() {
  $('results').hidden = false;
  $('clips').innerHTML = '';
  state.clips.forEach((c, i) => {
    const el = document.createElement('article');
    el.className = 'clip';
    el.innerHTML = `
      <div class="score" title="Score out of 10">${c.score}</div>
      <div>
        <h3></h3>
        <div class="meta"></div>
        <p class="hook"></p>
        <p class="text"></p>
        <div class="nudge">
          <span>Start</span><button data-k="start" data-d="-1">−1s</button><button data-k="start" data-d="1">+1s</button>
          <span>End</span><button data-k="end" data-d="-1">−1s</button><button data-k="end" data-d="1">+1s</button>
        </div>
      </div>
      <div class="actions">
        <button class="play">▶ Play</button>
        <button class="export">⬇ Export</button>
        <progress value="0" max="1" hidden></progress>
        <a class="dl" hidden>Download again</a>
      </div>`;
    el.querySelector('h3').textContent = `${i + 1}. ${c.title}`;
    const meta = () => { el.querySelector('.meta').textContent = `${fmt(c.start)} – ${fmt(c.end)} · ${Math.round(c.end - c.start)}s`; };
    meta();
    el.querySelector('.hook').textContent = c.hook;
    el.querySelector('.hook').hidden = !c.hook;
    el.querySelector('.text').textContent = '“' + c.text + '”';
    el.querySelector('.play').onclick = () => playClip(c, el);
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
      };
    });
    c._el = el;
    renderExportState(c);
    $('clips').append(el);
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
  const btn = el.querySelector('.export'), bar = el.querySelector('progress'), dl = el.querySelector('.dl');
  bar.hidden = c._progress == null;
  if (c._progress != null) bar.value = c._progress;
  btn.disabled = c._progress != null || exportQueue.includes(c);
  btn.textContent = c._progress != null ? (c._label || 'Exporting…') : exportQueue.includes(c) ? 'Queued…' : '⬇ Export';
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
        onProgress: (p, label) => { c._progress = p; c._label = label; renderExportState(c); },
      });
      const n = state.clips.indexOf(c) + 1 || 1;
      c._fileName = `${base()}-short-${n}-${c.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40)}.${exportExt}`;
      c._blobUrl = URL.createObjectURL(blob);
      c._blob = blob;
      console.log(`[omniclip] exported ${c._fileName} ${(blob.size / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      const a = document.createElement('a');
      a.href = c._blobUrl; a.download = c._fileName; a.click();
    } catch (err) {
      console.error(err);
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
$('exLayout').onchange = () => { $('exPos').disabled = $('exLayout').value === 'blur'; };

function playClip(c, el) {
  document.querySelectorAll('.clip.playing').forEach((x) => x.classList.remove('playing'));
  el.classList.add('playing');
  const v = $('player');
  state.stopAt = c.end;
  v.currentTime = c.start;
  v.play();
  v.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.querySelectorAll('#transcript p').forEach((p) => {
    p.classList.toggle('inclip', +p.dataset.t >= c.start - 0.01 && +p.dataset.t < c.end);
  });
}
$('player').addEventListener('timeupdate', () => {
  const v = $('player');
  if (state.stopAt !== null && v.currentTime >= state.stopAt) { v.pause(); state.stopAt = null; }
});

// Transcript lines: the time jumps the player there; the text is editable
// (fix misheard words; captions and clip text use the edited version).
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
    // Save as you type (debounced); refresh the clip cards when you leave the line.
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

// Make a short from the lines selected in the transcript.
$('fromSel').onclick = () => {
  const sel = window.getSelection();
  const ps = [sel.anchorNode, sel.focusNode]
    .map((n) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest('#transcript p'))
    .filter(Boolean);
  if (!ps.length || sel.isCollapsed) { alert('First select one or more lines in the transcript (click and drag over the text).'); return; }
  const idx = ps.map((p) => +p.dataset.i).sort((a, b) => a - b);
  const a = state.segments[idx[0]], b = state.segments[idx[idx.length - 1]];
  const text = clipWords(state.segments, a.start, b.end).map((w) => w.w).join(' ');
  const clip = {
    start: a.start, end: b.end,
    title: a.text.replace(/[.!?,]$/, '').split(/\s+/).slice(0, 8).join(' '),
    hook: 'Your pick', score: '★', text,
  };
  state.clips.unshift(clip);
  showClips();
  $('results').scrollIntoView({ behavior: 'smooth' });
  sel.removeAllRanges();
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
  return `${f.name}|${f.size}|${f.lastModified}|${$('asrModel').value}|${$('lang').value}`;
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
$('json').onclick = () => save(base() + '.shorts.json', JSON.stringify(state.clips, null, 2), 'application/json');
