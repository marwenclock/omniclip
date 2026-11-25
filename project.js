// The project: sources, transcript, clips (each a sequence of ranges) and styles.
// Saved on this device (IndexedDB) after every change, with undo/redo, and
// exportable as a small JSON file that never contains the media itself.
import { DEFAULT_STYLE } from './render.js';

export const SCHEMA = 2;
export const P = { project: null };
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const emit = (why) => listeners.forEach((fn) => fn(why));

let nextId = 1;
export const uid = (p = 'c') => `${p}${Date.now().toString(36)}${(nextId++).toString(36)}`;

export function newProject(source) {
  return {
    v: SCHEMA, id: uid('p'), name: source.name.replace(/\.[^.]+$/, ''),
    created: Date.now(), updated: Date.now(),
    sources: [source], segments: { [source.id]: [] },
    defaults: { ...DEFAULT_STYLE }, clips: [], assets: {},
  };
}
export function makeSource(file, id = uid('s')) {
  return { id, name: file.name, size: file.size, lastModified: file.lastModified, type: file.type, duration: 0, width: 0, height: 0 };
}
export function makeClip({ src, start, end, title = '', name, score = null, hook = '', origin = 'mine' }) {
  return { id: uid('c'), name: name || title || 'Clip', title, titleEdited: false, score, hook, origin, ranges: [{ id: uid('r'), src, start, end }], style: {}, overlay: null };
}

// ---------- clip helpers ----------
export const effStyle = (c) => ({ ...P.project.defaults, ...(c?.style || {}) });
export const speedOf = (c) => effStyle(c).speed || 1;
export const rangeLen = (r, c) => (r.end - r.start) / speedOf(c);
export const clipDuration = (c) => c.ranges.reduce((s, r) => s + rangeLen(r, c), 0);
export const clipStart = (c) => c.ranges[0]?.start ?? 0;
// Sequence time (output) -> range index and source time.
export function seqToSource(c, t) {
  let acc = 0;
  for (let i = 0; i < c.ranges.length; i++) {
    const r = c.ranges[i], len = rangeLen(r, c);
    if (t < acc + len || i === c.ranges.length - 1) return { i, r, st: Math.min(r.end, r.start + Math.max(0, t - acc) * speedOf(c)) };
    acc += len;
  }
  return { i: 0, r: c.ranges[0], st: c.ranges[0]?.start ?? 0 };
}
export function sourceToSeq(c, i, st) {
  let acc = 0;
  for (let k = 0; k < i; k++) acc += rangeLen(c.ranges[k], c);
  const r = c.ranges[i];
  return acc + (Math.max(r.start, Math.min(r.end, st)) - r.start) / speedOf(c);
}
export const sourceById = (id) => P.project.sources.find((s) => s.id === id);

// ---------- undo / redo (whole-project snapshots, coalesced per gesture) ----------
const undoStack = [], redoStack = [];
let lastKey = null, lastTime = 0;
const snap = () => JSON.stringify(P.project);
export function tx(label, fn, key = null) {
  const now = performance.now();
  const coalesce = key && key === lastKey && now - lastTime < 1200;
  if (!coalesce) { undoStack.push({ label, json: snap() }); if (undoStack.length > 150) undoStack.shift(); redoStack.length = 0; }
  lastKey = key; lastTime = now;
  fn(P.project);
  P.project.updated = Date.now();
  emit({ type: 'edit', label });
  scheduleSave();
}
export const endGesture = () => { lastKey = null; };
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export const undoLabel = () => undoStack[undoStack.length - 1]?.label;
export const redoLabel = () => redoStack[redoStack.length - 1]?.label;
export function undo() {
  const u = undoStack.pop(); if (!u) return null;
  redoStack.push({ label: u.label, json: snap() });
  P.project = JSON.parse(u.json); lastKey = null;
  emit({ type: 'undo', label: u.label }); scheduleSave();
  return u.label;
}
export function redo() {
  const r = redoStack.pop(); if (!r) return null;
  undoStack.push({ label: r.label, json: snap() });
  P.project = JSON.parse(r.json); lastKey = null;
  emit({ type: 'redo', label: r.label }); scheduleSave();
  return r.label;
}
export function resetHistory() { undoStack.length = 0; redoStack.length = 0; lastKey = null; }

// ---------- local storage (IndexedDB) ----------
let dbP = null;
export function db() {
  dbP ??= new Promise((res, rej) => {
    const r = indexedDB.open('omniclip', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('transcripts')) d.createObjectStore('transcripts');
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects');
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbP = null; rej(r.error); };
    r.onblocked = () => rej(new Error('Close other OMNICLIP tabs and reload.'));
  });
  return dbP;
}
// Resolves only once the transaction has committed; rejects on any failure (e.g. quota).
export async function dbPut(store, key, val) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite');
    t.objectStore(store).put(val, key);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error || new Error('Could not save'));
    t.onabort = () => rej(t.error || new Error('Saving was aborted (storage may be full)'));
  });
}
export async function dbGet(store, key) {
  const d = await db();
  return new Promise((res) => { const q = d.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
}
export async function dbDel(store, key) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).delete(key); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
export async function dbAll(store) {
  const d = await db();
  return new Promise((res) => {
    const out = [];
    const q = d.transaction(store).objectStore(store).openCursor();
    q.onsuccess = () => { const c = q.result; if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } else res(out); };
    q.onerror = () => res(out);
  });
}

// ---------- autosave with an honest status ----------
export const saveState = { status: 'idle', error: null, at: 0 };
let saveTimer = null;
function scheduleSave() {
  if (!P.project) return;
  saveState.status = 'pending'; emit({ type: 'save' });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}
export async function saveNow() {
  if (!P.project) return;
  clearTimeout(saveTimer);
  saveState.status = 'saving'; emit({ type: 'save' });
  try {
    await dbPut('projects', P.project.id, JSON.parse(snap()));
    saveState.status = 'saved'; saveState.error = null; saveState.at = Date.now();
  } catch (e) {
    saveState.status = 'error'; saveState.error = e.message || String(e);
  }
  emit({ type: 'save' });
}
export const markDirty = () => scheduleSave();

// ---------- project file (JSON, no media) ----------
export function projectFile() {
  return JSON.stringify({ app: 'OMNICLIP', ...JSON.parse(snap()) }, null, 1);
}
// Validates an imported project and returns a clean copy, or throws a readable error.
export function parseProjectFile(text) {
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('This file is not a valid OMNICLIP project (it is not JSON).'); }
  if (Array.isArray(p)) throw new Error('This is a clip list, not a project file. Open the video and import it as a project instead.');
  if (!p || typeof p !== 'object' || !Array.isArray(p.sources) || !Array.isArray(p.clips)) throw new Error('This file is not an OMNICLIP project.');
  if ((p.v | 0) > SCHEMA) throw new Error('This project was made with a newer OMNICLIP. Reload the page to update.');
  const num = (x) => Number.isFinite(+x) && +x >= 0;
  const srcIds = new Set(p.sources.map((s) => s.id));
  for (const c of p.clips) {
    if (!Array.isArray(c.ranges) || !c.ranges.length) throw new Error(`Clip “${c.name || c.id}” has no ranges.`);
    for (const r of c.ranges) {
      if (!num(r.start) || !num(r.end) || +r.end <= +r.start) throw new Error(`Clip “${c.name || c.id}” has an invalid time range.`);
      if (!srcIds.has(r.src)) throw new Error(`Clip “${c.name || c.id}” refers to a missing source.`);
    }
  }
  return {
    v: SCHEMA, id: p.id || uid('p'), name: String(p.name || 'Project'), created: p.created || Date.now(), updated: Date.now(),
    sources: p.sources.map((s) => ({ id: s.id, name: String(s.name), size: +s.size || 0, lastModified: +s.lastModified || 0, type: s.type || '', duration: +s.duration || 0, width: +s.width || 0, height: +s.height || 0 })),
    segments: p.segments && typeof p.segments === 'object' ? p.segments : {},
    defaults: { ...DEFAULT_STYLE, ...(p.defaults || {}) },
    clips: p.clips.map((c) => ({ ...c, style: c.style || {}, ranges: c.ranges.map((r) => ({ id: r.id || uid('r'), src: r.src, start: +r.start, end: +r.end })) })),
    assets: p.assets || {},
  };
}
// Migrate a v1 draft (transcript only) — v1 had no saved projects, so only transcripts carry over.
export const transcriptKey = (src, model, lang) => `${src.name}|${src.size}|${src.lastModified}|${model}|${lang}`;

// Changes that are not user edits (transcript streaming in, picks arriving): saved, but not undoable.
export function quiet(fn, type = 'data') {
  fn(P.project);
  P.project.updated = Date.now();
  emit({ type });
  scheduleSave();
}
export function load(project) { P.project = project; resetHistory(); emit({ type: 'load' }); }
