// OMNICLIP app shell: the start screen, the two ways in (Create shorts / Edit a
// video), the on-device pipeline (decode -> transcribe -> pick moments), saved
// projects and relinking, the sample, and the About / Storage dialogs.
import { decodeAudioStream, canStreamDecode } from './decode-stream.js';
import { CONFIG } from './config.js';
import { pickModel, loadLLM, instantClips, rateClip, rank } from './clips.js';
import { exportMime } from './export.js';
import { peaks } from './tools.js';
import {
  P, load, quiet, newProject, makeSource, makeClip, transcriptKey, dbGet, dbPut, dbDel, dbAll, parseProjectFile, projectFile, sourceById,
} from './project.js';
import { R, openEditor, selectClip, appendSegments, showEmpty, announce, setStatus, notice, ask, saveFile, safeName, fmt, mb, showBinTab, showInspTab } from './editor.js';

const $ = (id) => document.getElementById(id);
const qsa = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- settings (named by what they do; the models behind them stay an implementation detail) ----------
const QUALITY = { fast: 'onnx-community/whisper-base', better: 'onnx-community/whisper-small', best: 'onnx-community/whisper-large-v3-turbo' };
const FINDER = {
  smart: { model: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', shortlist: 1.5 },
  deep: { model: 'Phi-3.5-mini-instruct-q4f16_1-MLC', shortlist: 2 },
  instant: null,
};
const FINDER_HELP = {
  smart: 'Smart: an on-device AI rates each moment and writes titles (about 1 GB, downloaded once)',
  deep: 'Deep: a stronger on-device AI for fast graphics cards (about 2.2 GB, downloaded once)',
  instant: 'Instant: picks moments from the transcript alone, with nothing extra to download',
};
const QUALITY_HELP = { fast: 'Fast transcription: 200 MB.', better: 'Better transcription: 600 MB.', best: 'Best transcription: 1.6 GB, for fast graphics cards.' };
const LANGS = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', ar: 'Arabic' };
const finder = () => $('finder').value || 'smart';
const asrModel = () => QUALITY[$('quality').value] || QUALITY.fast;
const OPT_KEY = 'omniclip:options';
let hasGPU = false, gpuChecked = false;
const gpu = { weak: false, name: '' };

function saveOptions() {
  localStorage.setItem(OPT_KEY, JSON.stringify({ finder: finder(), quality: $('quality').value, lang: $('lang').value, count: $('count').value }));
  explainOptions();
}
function loadOptions() {
  try {
    const o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}');
    for (const k of ['finder', 'quality', 'lang', 'count']) if (o[k] && [...$(k).options].some((x) => x.value === String(o[k]))) $(k).value = o[k];
  } catch { /* first visit */ }
  explainOptions();
}
function explainOptions() {
  const n = $('count').value;
  const countHelp = +n >= 8 ? ` ${n} shorts suits videos longer than about ${n * 2} minutes.` : '';
  const eff = gpuChecked && !hasGPU ? 'instant' : finder();
  const deviceNote = gpuChecked && !hasGPU ? ' (this browser can’t use the graphics card, so Smart and Deep aren’t available here)' : '';
  const langNote = $('lang').value !== 'en' ? ' Moment picking is tuned for English, so check the picks or choose lines yourself.' : '';
  $('optHelp').textContent = `${FINDER_HELP[eff]}${deviceNote}. Downloads happen once and stay on this device.${countHelp}${langNote}`;
  const tags = [n === 'auto' ? 'Auto count' : `${n} shorts`, LANGS[$('lang').value], `${eff[0].toUpperCase() + eff.slice(1)} picking`, `${$('quality').value[0].toUpperCase() + $('quality').value.slice(1)} transcription`];
  $('settingsSum').innerHTML = tags.map((t) => `<span class="st-tag">${esc(t)}</span>`).join('');
  let warn = null;
  if (gpu.weak && finder() === 'deep') warn = { text: `Your computer has ${gpu.name}, so Deep picking will be very slow.`, fix: 'Use Smart', apply: () => { $('finder').value = 'smart'; } };
  else if (gpu.weak && $('quality').value === 'best') warn = { text: `Your computer has ${gpu.name}, so Best accuracy will be very slow.`, fix: 'Use Better', apply: () => { $('quality').value = 'better'; } };
  $('optWarn').hidden = !warn;
  if (warn) {
    $('optWarn').querySelector('span').textContent = warn.text;
    const b = $('optWarn').querySelector('button');
    b.textContent = warn.fix; b.onclick = () => { warn.apply(); saveOptions(); };
  }
}
qsa('#options select').forEach((el) => el.addEventListener('change', saveOptions));
// Settings open/close: a real button with a clear state, remembered on this device.
function setSettingsOpen(open) {
  $('settingsPanel').hidden = !open;
  $('settingsToggle').setAttribute('aria-expanded', String(open));
  $('settings').classList.toggle('open', open);
  $('settingsVerb').textContent = open ? 'Done' : 'Change';
  localStorage.setItem('omniclip:settingsOpen', open ? '1' : '0');
}
$('settingsToggle').onclick = () => setSettingsOpen($('settingsPanel').hidden);
setSettingsOpen(localStorage.getItem('omniclip:settingsOpen') === '1');
loadOptions();
const gpuReady = (async () => {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  hasGPU = !!adapter; gpuChecked = true;
  if (adapter) {
    const info = adapter.info || {};
    const id = `${info.vendor || ''} ${info.architecture || ''} ${info.description || ''}`;
    if (/intel/i.test(id)) { gpu.weak = true; gpu.name = 'built-in Intel graphics'; }
    else if (!adapter.features.has('shader-f16')) { gpu.weak = true; gpu.name = 'an older graphics card'; }
  }
  explainOptions();
  if (!hasGPU) { $('gpuNote').textContent = 'Transcription will be slower in this browser. For the full experience, use a recent Chrome or Edge on a computer.'; $('gpuNote').hidden = false; }
})();
if (!exportMime) { $('exportNote').textContent = 'This browser can’t record video, so you can transcribe, edit and download subtitles here but not export shorts. Use Chrome or Edge on a computer to export.'; $('exportNote').hidden = false; }

// ---------- About, support, storage ----------
const HEART = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16.5s-6-3.6-6-8.1A3.4 3.4 0 0 1 10 6.3a3.4 3.4 0 0 1 6 2.1c0 4.5-6 8.1-6 8.1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
$('donateSlot').innerHTML = CONFIG.donateUrl
  ? `<a class="btn btn-solid" href="${encodeURI(CONFIG.donateUrl)}" target="_blank" rel="noopener">${HEART} ${esc(CONFIG.donateLabel)}</a>`
  : `<button class="btn btn-solid" type="button" disabled title="Donations are being set up">${HEART} Donations coming soon</button>`;
$('aboutBtn').onclick = () => $('about').showModal();
qsa('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});
$('singleKeys').checked = R.singleKeys;
$('singleKeys').onchange = () => { R.singleKeys = $('singleKeys').checked; localStorage.setItem('omniclip:keys', R.singleKeys ? '1' : '0'); };
$('storageBtn').onclick = () => { $('about').close(); openStorage(); };

async function openStorage() {
  const list = $('storeList');
  list.innerHTML = '<li><div>Checking…</div></li>';
  $('storage').showModal();
  const est = await navigator.storage?.estimate?.().catch(() => null);
  $('storageTotal').textContent = est ? `OMNICLIP uses about ${mb(est.usage || 0)} on this device${est.quota ? ` (the browser allows up to ${mb(est.quota)})` : ''}.` : '';
  const [projects, transcripts, assets] = await Promise.all([dbAll('projects'), dbAll('transcripts'), dbAll('assets')]);
  const cacheNames = (await caches?.keys?.().catch(() => [])) || [];
  const rows = [];
  for (const { key, value } of projects) rows.push({ label: `Project: ${value.name}`, meta: `${value.clips?.length || 0} clips · edited ${new Date(value.updated).toLocaleString()} · ~${mb(JSON.stringify(value).length)}`, del: () => dbDel('projects', key) });
  if (transcripts.length) rows.push({ label: `Remembered transcripts (${transcripts.length})`, meta: transcripts.map((t) => String(t.key).split('|')[0]).slice(0, 4).join(', ') + (transcripts.length > 4 ? '…' : ''), del: () => Promise.all(transcripts.map((t) => dbDel('transcripts', t.key))) });
  if (assets.length) rows.push({ label: `Overlay images and videos (${assets.length})`, meta: mb(assets.reduce((s, a) => s + (a.value?.size || 0), 0)), del: () => Promise.all(assets.map((a) => dbDel('assets', a.key))) });
  for (const n of cacheNames) rows.push({ label: /transformers/i.test(n) ? 'Speech model (Whisper)' : /webllm|mlc|tvmjs/i.test(n) ? `Moment-picking AI (${n})` : `Downloaded files (${n})`, meta: 'Downloaded once, used offline after that', del: () => caches.delete(n) });
  list.innerHTML = rows.length ? '' : '<li><div>Nothing stored yet.</div></li>';
  rows.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `<div>${esc(r.label)}<span class="meta">${esc(r.meta)}</span></div><button class="btn btn-outline btn-sm" type="button">Delete</button>`;
    li.querySelector('button').onclick = async () => { await r.del(); li.remove(); renderDrafts(); };
    list.append(li);
  });
}

// ---------- the two ways in ----------
let mode = 'shorts';
$('pickShorts').onclick = () => { mode = 'shorts'; $('file').value = ''; $('file').click(); };
$('pickEdit').onclick = () => { mode = 'edit'; $('file').value = ''; $('file').click(); };
$('file').addEventListener('change', (e) => e.target.files[0] && startFile(e.target.files[0], mode));
const veil = $('dropVeil');
let dragDepth = 0;
const overZone = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest('.dz');
addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files') || document.querySelector('dialog[open]')) return;
  dragDepth++; veil.hidden = false;
  veil.classList.toggle('single', !!P.project && !$('work').hidden);
  veil.querySelector('[data-mode="shorts"]').innerHTML = P.project && !$('work').hidden ? 'Drop to <b>add this video to the project</b>' : 'Drop here to <b>create shorts</b>';
});
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; veil.hidden = true; } });
addEventListener('dragover', (e) => { e.preventDefault(); qsa('.dz').forEach((z) => z.classList.toggle('over', z === overZone(e))); });
addEventListener('drop', (e) => {
  if (e.defaultPrevented && !e.dataTransfer?.files.length) return;
  e.preventDefault();
  const zone = veil.hidden ? null : overZone(e)?.dataset.mode; // read before hiding the veil
  dragDepth = 0; veil.hidden = true;
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /^(video|audio)\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name));
  if (!files.length) { if (e.dataTransfer?.files.length) announce('That file isn’t a video or audio file.'); return; }
  if (P.project && !$('work').hidden) { files.forEach(addMedia); return; }
  const m = zone || 'shorts';
  startFile(files[0], m);
  if (files.length > 1) setTimeout(() => { files.slice(1).forEach(addMedia); announce(`Opened ${files[0].name} and added ${files.length - 1} more video${files.length > 2 ? 's' : ''} to the project (Media tab).`); }, 500);
});
$('newVideo').onclick = async () => {
  if (R.jobs.some((j) => ['queued', 'running'].includes(j.state)) && await ask('Leave this project?', '<p>An export is still running. Your project is saved on this device, but the export will stop.</p>', [{ label: 'Stay', value: false, solid: true }, { label: 'Leave', value: true }]) !== true) return;
  location.href = './';
};

// ---------- media metadata ----------
function readMeta(url) {
  return new Promise((res) => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.src = url;
    const done = () => { res({ duration: Number.isFinite(v.duration) ? v.duration : 0, width: v.videoWidth, height: v.videoHeight }); v.removeAttribute('src'); v.load(); };
    v.onloadedmetadata = done; v.onerror = () => res(null); setTimeout(() => res(null), 15000);
  });
}
function linkFile(src, file) {
  if (R.urls[src.id]) URL.revokeObjectURL(R.urls[src.id]);
  R.urls[src.id] = URL.createObjectURL(file);
  R.files[src.id] = file;
}

// ---------- start a new project from a file ----------
async function startFile(file, how, opts = {}) {
  const src = makeSource(file);
  const p = newProject(src);
  if (how === 'edit') p.defaults.captions = 'none';
  linkFile(src, file);
  load(p);
  openEditor();
  setStatus(`Opening ${file.name}…`);
  const meta = await readMeta(R.urls[src.id]);
  if (!meta) {
    announce('This file couldn’t be opened. It may be damaged or in a format this browser can’t play. Try an MP4.');
    showEmpty('This file couldn’t be played in this browser. Try converting it to MP4, or choose another file.');
    return;
  }
  quiet((pp) => { Object.assign(pp.sources[0], meta); });
  if (meta.height > meta.width * 1.2) quiet((pp) => { pp.defaults.layout = 'crop'; });
  if (how === 'edit') {
    // Edit a video: the whole file is one clip, ready to trim. Nothing to download.
    const c = makeClip({ src: src.id, start: 0, end: meta.duration || 1, name: p.name, title: '' });
    quiet((pp) => { pp.clips.push(c); });
    selectClip(c.id, { quiet: true });
    showInspTab('itTrim');
    announce(`${file.name} is open. Trim it with the timeline or the Trim panel, then export. Captions need a transcript: Captions → Transcribe it.`);
    readPeaks(src.id);
    return;
  }
  await runShorts(src.id, opts);
}
async function addMedia(file) {
  if (!P.project) return startFile(file, 'edit');
  const src = makeSource(file);
  linkFile(src, file);
  const meta = await readMeta(R.urls[src.id]);
  if (!meta) { announce(`${file.name} couldn’t be opened in this browser.`); return; }
  Object.assign(src, meta);
  quiet((p) => { p.sources.push(src); p.segments[src.id] = []; }, 'clips');
  showBinTab('tabMedia');
  announce(`Added ${file.name}. Make a clip from it, or add it to the selected clip, in the Media tab.`);
  readPeaks(src.id);
}
$('mediaFile').onchange = () => { const f = $('mediaFile').files[0]; if (f) addMedia(f); };

// ---------- progress pill ----------
const STEPS = { stDecode: { label: 'Reading the audio', order: 1 }, stAsr: { label: 'Transcribing', order: 2 }, stLlm: { label: 'Loading the AI', order: 0 }, stPick: { label: 'Rating the moments', order: 3 } };
let progress = {};
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
const endProgress = () => { for (const p of Object.values(progress)) p.active = false; renderProgress(); };
let run = null; // { cancelled, worker }
$('cancelRun').onclick = () => {
  if (!run) return;
  run.cancelled = true; run.worker?.terminate(); run.reject?.(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  endProgress();
  announce('Stopped. Everything transcribed so far is kept; you can cut the video by hand.');
};

// ---------- decode, peaks, transcribe ----------
const audioCache = {};
async function decode(srcId, quietly = false) {
  if (audioCache[srcId]) return audioCache[srcId];
  const file = R.files[srcId];
  const mp4ish = /mp4|quicktime|m4a|m4v/.test(file.type) || /\.(mp4|mov|m4a|m4v)$/i.test(file.name);
  const prog = (p) => !quietly && step('stDecode', { value: p, info: `${mb(file.size * p)} / ${mb(file.size)}` });
  if (!quietly) step('stDecode', { active: true, info: mb(file.size) });
  let audio;
  if (mp4ish && canStreamDecode() && file.size > 300e6) audio = await decodeAudioStream(file, prog);
  else {
    if (!mp4ish && file.size > 1.2e9) throw new Error('This file is too large to read in the browser. Convert it to MP4 or MOV, or split it.');
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      ctx.close();
      audio = buf.getChannelData(0);
      if (buf.numberOfChannels > 1) { const r = buf.getChannelData(1); audio = audio.map((v, i) => (v + r[i]) / 2); }
    } catch (err) {
      if (mp4ish && canStreamDecode()) audio = await decodeAudioStream(file, prog);
      else if (/decod|EncodingError/i.test(err.name + err.message)) throw new Error('This file has no audio track the browser can read.');
      else throw err;
    }
  }
  if (!quietly) step('stDecode', { done: true });
  R.peaks[srcId] = peaks(audio, 16000);
  if (file.size < 400e6) audioCache[srcId] = audio; // small files: keep for a later transcription
  return audio;
}
const peakJobs = new Set();
R.hooks.peaksPending = () => peakJobs.size > 0;
async function readPeaks(srcId) {
  if (R.peaks[srcId] || peakJobs.has(srcId)) return;
  peakJobs.add(srcId);
  try { await decode(srcId, true); quiet(() => {}, 'peaks'); } catch (e) { console.warn('[omniclip] no waveform', e); }
  peakJobs.delete(srcId);
}
function transcribe(srcId, audio) {
  return new Promise((resolve, reject) => {
    step('stAsr', { active: true, value: 0, info: 'starting…' });
    const worker = new Worker('./asr-worker.js', { type: 'module' });
    run.worker = worker; run.reject = reject;
    const dl = {};
    const fail = (text) => { worker.terminate(); reject(new Error(text)); };
    worker.onerror = (e) => { e.preventDefault?.(); fail('The speech engine could not load. Check your connection and try again.'); };
    worker.onmessageerror = () => fail('The speech engine sent an unreadable message.');
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'download') {
        dl[m.file] = m;
        const loaded = Object.values(dl).reduce((s, d) => s + d.loaded, 0), total = Object.values(dl).reduce((s, d) => s + d.total, 0);
        step('stAsr', { value: loaded / total, info: `loading ${mb(loaded)} / ${mb(total)}` });
      } else if (m.type === 'segments') {
        quiet((p) => { (p.segments[srcId] ||= []).push(...m.segments); }, 'stream');
        const all = P.project.segments[srcId];
        appendSegments(srcId, all.slice(all.length - m.segments.length));
        const left = (m.elapsed / m.done) * (m.total - m.done);
        step('stAsr', { value: m.done / m.total, info: `${fmt(m.done)} / ${fmt(m.total)} · ${eta(left)} left` });
      } else if (m.type === 'finished') { step('stAsr', { done: true }); worker.terminate(); resolve(); }
      else if (m.type === 'error') fail(m.text);
    };
    delete audioCache[srcId]; // the worker takes the samples; peaks are already computed
    worker.postMessage({ audio, model: asrModel(), language: $('lang').value, device: hasGPU ? 'webgpu' : 'wasm' }, [audio.buffer]);
  });
}
const eta = (sec) => (sec < 60 ? `${Math.round(sec)}s` : `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`);

// Transcribe (and remember) one source; used by Create shorts and by "Transcribe it" in the editor.
async function getTranscript(srcId) {
  const src = sourceById(srcId);
  const key = transcriptKey(src, asrModel(), $('lang').value);
  const cached = await dbGet('transcripts', key).catch(() => null);
  if (cached?.segments?.length) { quiet((p) => { p.segments[srcId] = cached.segments; }, 'segments'); readPeaks(srcId); return; }
  quiet((p) => { p.segments[srcId] = []; }, 'segments');
  const audio = await decode(srcId);
  await transcribe(srcId, audio);
  dbPut('transcripts', key, { segments: P.project.segments[srcId], saved: Date.now() }).catch(() => {});
}
R.hooks.transcribe = async (srcId) => {
  if (!srcId || run) return;
  run = { cancelled: false };
  R.transcribing = true;
  const t0 = performance.now();
  try {
    await gpuReady;
    await getTranscript(srcId);
    endProgress();
    quiet((p) => { if (p.defaults.captions === 'none') p.defaults.captions = 'pop'; }, 'segments');
    announce(`Transcribed in ${eta((performance.now() - t0) / 1000)}. Captions are on; style them in the Captions panel.`);
  } catch (e) {
    endProgress();
    if (e.name !== 'AbortError') announce(`Transcription failed: ${e.message}`);
  }
  R.transcribing = false; run = null;
  quiet(() => {}, 'segments');
};

// ---------- Create shorts: transcribe, then pick moments ----------
const recommendCount = (sec) => Math.max(1, Math.min(12, Math.ceil(sec / 120)));
async function runShorts(srcId, { segments } = {}) {
  run = { cancelled: false };
  progress = {};
  const t0 = performance.now();
  const src = sourceById(srcId);
  const asked = $('count').value, rec = recommendCount(src.duration || 0);
  let target = asked === 'auto' ? rec : +asked;
  if (asked !== 'auto' && +asked > Math.max(rec * 1.5, rec + 2)) {
    target = rec;
    notice(`This video is <b>${fmt(src.duration)}</b> long. You asked for ${asked} shorts; that many would be weak and overlapping, so OMNICLIP will make the best <b>${rec}</b>.`, `Make ${asked} anyway`, () => repick(srcId, +asked));
  }
  try {
    await gpuReady;
    const mode = hasGPU ? finder() : 'instant';
    const llmReady = mode === 'instant' ? null : loadPicker(FINDER[mode].model);
    llmReady?.catch(() => {}); // handled below
    if (segments) { quiet((p) => { p.segments[srcId] = segments; }, 'segments'); readPeaks(srcId); }
    else await getTranscript(srcId);
    if (run.cancelled) return;
    if (!P.project.segments[srcId]?.length) {
      endProgress();
      showEmpty('No speech was found, so there is nothing to pick from. Use the whole video, or make a clip at the playhead.');
      announce('No speech found · cut this video by hand');
      return;
    }
    let useAI = mode !== 'instant', aiFailed = false;
    if (useAI) { try { await llmReady; } catch (e) { console.warn('[omniclip] AI picker unavailable', e); step('stLlm', { done: true }); useAI = false; aiFailed = true; } }
    if (run.cancelled) return;
    const n = useAI ? await pickSmart(srcId, target, FINDER[mode].shortlist) : pickInstant(srcId, target);
    endProgress();
    const made = P.project.clips.length;
    if (!made) showEmpty('No clear moments stood out. Use the whole video, or pick transcript lines to make your own short.');
    else if (n < target) notice(`You asked for ${asked === 'auto' ? `about ${target}` : target}; only <b>${n}</b> strong ${n === 1 ? 'moment stands' : 'moments stand'} out. Pick transcript lines to make more.`, 'Open transcript', () => showBinTab('tabTranscript'));
    announce(`Done in ${eta((performance.now() - t0) / 1000)} · ${made} short${made === 1 ? '' : 's'} ready${aiFailed ? ' · the on-device AI couldn’t run, so moments were picked from the transcript' : ''}`);
  } catch (err) {
    endProgress();
    if (err.name === 'AbortError') return;
    console.error(err);
    announce('Something went wrong: ' + (err.message || err));
    showEmpty(`Something went wrong: ${err.message || err}. Whatever was transcribed is kept in the Transcript tab, and you can still cut the video by hand.`);
  } finally { run = null; }
}
async function loadPicker(preferred) {
  step('stLlm', { active: true, info: 'starting…' });
  const model = await pickModel(preferred);
  await loadLLM(model, (p, text) => { const m = text.match(/(\d+)MB/); step('stLlm', { value: p, info: m ? `loading ${m[1]} MB` : Math.round(p * 100) + '%' }); });
  step('stLlm', { done: true });
}
const toClip = (srcId) => (c) => makeClip({ src: srcId, start: c.start, end: c.end, title: c.title, name: c.title, score: c.score, hook: c.hook, origin: 'auto' });
function setAutoClips(srcId, list) {
  quiet((p) => {
    // keep clips the creator made or changed; replace untouched automatic picks
    const keep = p.clips.filter((c) => c.origin !== 'auto' || c.titleEdited || Object.keys(c.style).length);
    p.clips = [...keep, ...list.map(toClip(srcId))];
  }, 'clips');
}
function pickInstant(srcId, n) {
  const list = instantClips(P.project.segments[srcId], n);
  setAutoClips(srcId, list);
  selectClip(P.project.clips[0]?.id || null, { quiet: true });
  return list.length;
}
const rated = new Map();
async function pickSmart(srcId, n, factor) {
  const shortlist = instantClips(P.project.segments[srcId], Math.ceil(n * factor));
  setAutoClips(srcId, shortlist.slice(0, n));
  selectClip(P.project.clips[0]?.id || null, { quiet: true });
  step('stPick', { active: true, value: 0, info: `0 / ${shortlist.length}` });
  const t0 = performance.now();
  let failures = 0;
  for (let i = 0; i < shortlist.length && !run?.cancelled; i++) {
    const c = shortlist[i], key = `${c.start.toFixed(2)}-${c.end.toFixed(2)}`;
    try {
      const r = rated.get(key) || await rateClip({ ...c });
      if (r) { rated.set(key, r); c.score = r.score; c.title = r.title; c.hook = r.hook; }
    } catch (e) { console.warn(e); if (++failures >= 2) break; }
    const el = (performance.now() - t0) / 1000;
    step('stPick', { value: (i + 1) / shortlist.length, info: `${i + 1} / ${shortlist.length} · ${eta((el / (i + 1)) * (shortlist.length - i - 1))} left` });
  }
  step('stPick', { done: true });
  const best = rank(shortlist, n);
  const sel = R.selId;
  setAutoClips(srcId, best);
  selectClip(P.project.clips.find((c) => c.id === sel)?.id || P.project.clips[0]?.id || null, { quiet: true });
  return best.length;
}
function repick(srcId, n) {
  setAutoClips(srcId, instantClips(P.project.segments[srcId], n));
  selectClip(P.project.clips[0]?.id || null, { quiet: true });
}

// ---------- sample ----------
$('trySample').onclick = async () => {
  $('trySample').disabled = true; $('trySample').querySelector('span').textContent = 'Loading the sample…';
  try {
    const [audio, segs] = await Promise.all([fetch('sample/podcast.m4a').then((r) => { if (!r.ok) throw new Error('sample missing'); return r.blob(); }), fetch('sample/podcast.json').then((r) => r.json())]);
    const file = new File([audio], 'Sample podcast.m4a', { type: 'audio/mp4', lastModified: 1764000000000 });
    $('finder').value = 'instant';
    await startFile(file, 'shorts', { segments: segs });
    loadOptions();
  } catch (e) { announce(`The sample couldn’t load: ${e.message}`); $('trySample').disabled = false; $('trySample').querySelector('span').textContent = 'Try a sample podcast'; }
};

// ---------- saved projects: drafts, project files, relinking ----------
async function renderDrafts() {
  const all = (await dbAll('projects').catch(() => [])).map((x) => x.value).filter((p) => p?.sources).sort((a, b) => b.updated - a.updated).slice(0, 8);
  $('drafts').hidden = !all.length;
  $('draftList').innerHTML = '';
  for (const p of all) {
    const li = document.createElement('li');
    li.className = 'draft';
    li.innerHTML = `<div class="draft-main"><div class="draft-name">${esc(p.name)}</div><div class="draft-meta">${p.clips.length} clip${p.clips.length === 1 ? '' : 's'} · ${esc(p.sources.map((s) => s.name).join(', '))} · ${new Date(p.updated).toLocaleDateString()}</div></div>
      <button class="btn btn-outline btn-sm" type="button" data-a="open">Open</button><button class="btn btn-outline btn-sm" type="button" data-a="rm" aria-label="Remove project ${esc(p.name)}">Remove</button>`;
    li.querySelector('[data-a="open"]').onclick = () => relink(p);
    li.querySelector('[data-a="rm"]').onclick = async () => {
      if (await ask('Remove this project?', `<p>“${esc(p.name)}” and its clips will be removed from this device. Your video files are not touched.</p>`, [{ label: 'Cancel', value: false }, { label: 'Remove', value: true, solid: true }]) !== true) return;
      await dbDel('projects', p.id); renderDrafts();
    };
    $('draftList').append(li);
  }
}
renderDrafts();
const openProjectFile = () => { $('projFile').value = ''; $('projFile').click(); };
$('openProj').onclick = openProjectFile;
$('projFile').onchange = async () => {
  const f = $('projFile').files[0]; if (!f) return;
  try { relink(parseProjectFile(await f.text())); } catch (e) { announce(e.message); await ask('Couldn’t open the project', `<p>${esc(e.message)}</p>`, [{ label: 'OK', solid: true }]); }
};
// Ask for each source file again; check size and duration so the edit lands on the right video.
function relink(proj) {
  const d = $('relink'), list = $('relinkList');
  const chosen = {};
  const render = () => {
    list.innerHTML = '';
    proj.sources.forEach((s) => {
      const f = chosen[s.id];
      const li = document.createElement('li');
      const ok = f && f.size === s.size;
      li.innerHTML = `<div>${esc(s.name)}<span class="meta">${s.duration ? fmt(s.duration) + ' · ' : ''}${mb(s.size)}${f ? ` → <span class="${ok ? 'ok' : 'bad'}">${esc(f.name)} (${mb(f.size)})${ok ? ' ✓' : ' · different size'}</span>` : ''}</span></div><button class="btn btn-outline btn-sm" type="button">${f ? 'Change' : 'Choose file'}</button>`;
      li.querySelector('button').onclick = () => {
        const inp = Object.assign(document.createElement('input'), { type: 'file', accept: 'video/*,audio/*' });
        inp.onchange = () => { if (inp.files[0]) { chosen[s.id] = inp.files[0]; render(); } };
        inp.click();
      };
      list.append(li);
    });
    const main = chosen[proj.sources[0].id];
    $('relinkGo').disabled = !main;
    const bad = Object.entries(chosen).filter(([id, f]) => f.size !== proj.sources.find((s) => s.id === id).size);
    $('relinkMsg').textContent = bad.length ? 'A chosen file has a different size than the original. If it is a different video, clip times may not match.' : !main ? 'Choose at least the first video.' : '';
  };
  render();
  $('relinkGo').onclick = async () => {
    d.close();
    for (const s of proj.sources) if (chosen[s.id]) linkFile(s, chosen[s.id]);
    load(proj);
    openEditor();
    for (const s of proj.sources) if (chosen[s.id]) {
      if (!s.duration) { const meta = await readMeta(R.urls[s.id]); if (meta) quiet((p) => Object.assign(p.sources.find((x) => x.id === s.id), meta)); }
      readPeaks(s.id);
    }
    selectClip(proj.clips[0]?.id || null, { quiet: true });
    announce(`Opened “${proj.name}” with ${proj.clips.length} clip${proj.clips.length === 1 ? '' : 's'}.`);
  };
  d.showModal();
}
R.hooks.relinkOne = (srcId) => {
  const inp = Object.assign(document.createElement('input'), { type: 'file', accept: 'video/*,audio/*' });
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    const s = sourceById(srcId);
    if (f.size !== s.size && await ask('Different file?', `<p>${esc(f.name)} is ${mb(f.size)}; the original was ${mb(s.size)}. Use it anyway?</p>`, [{ label: 'Cancel', value: false }, { label: 'Use it', value: true, solid: true }]) !== true) return;
    linkFile(s, f); quiet(() => {}, 'clips'); readPeaks(srcId);
  };
  inp.click();
};

// ---------- project menu ----------
const menu = $('projectMenu');
$('projectBtn').onclick = (e) => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; $('projectBtn').setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('button').focus(); };
addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.menu-wrap')) { menu.hidden = true; $('projectBtn').setAttribute('aria-expanded', 'false'); } });
menu.addEventListener('keydown', (e) => {
  const items = qsa('button', menu), i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { menu.hidden = true; $('projectBtn').focus(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
});
menu.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  menu.hidden = true;
  if (act === 'saveFile') { saveFile(`${safeName(P.project.name)}.omniclip.json`, projectFile(), 'application/json'); announce('Saved the project file. It holds your edits, not the video.'); }
  if (act === 'openFile') openProjectFile();
  if (act === 'addMedia') { $('mediaFile').value = ''; $('mediaFile').click(); }
  if (act === 'storage') openStorage();
});

// ---------- background-safe export (beta), loaded only when used ----------
R.hooks.fastExport = async (job, opts) => {
  const mod = await import('./fastexport.js');
  if (!mod.fastSupported()) throw new Error('Background-safe export needs WebCodecs (recent Chrome or Edge). Turn it off to use the normal export.');
  return mod.fastExportClip(job, opts);
};
