// Clip picker: a small local LLM (WebLLM, runs on the GPU) reads the transcript
// a few minutes at a time and proposes the best self-contained short in each
// window. Results are then sanity-checked, de-duplicated and ranked.
import * as webllm from 'https://esm.run/@mlc-ai/web-llm';

let engine = null;
let loadedModel = null;

export async function pickModel(preferred) {
  // GPUs without 16-bit shader support need the f32 build of the model.
  const adapter = await navigator.gpu?.requestAdapter();
  const f16 = adapter?.features.has('shader-f16');
  return f16 ? preferred : preferred.replace('q4f16_1', 'q4f32_1');
}

export async function loadLLM(model, onProgress) {
  if (engine && loadedModel === model) return;
  if (engine) await engine.unload();
  engine = await webllm.CreateMLCEngine(model, {
    initProgressCallback: (r) => onProgress(r.progress, r.text),
  });
  loadedModel = model;
}

const fmt = (t) => {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

// Group segments into ~3-minute windows on segment boundaries.
export function makeWindows(segments, len = 180) {
  const windows = [];
  let cur = [];
  for (const s of segments) {
    if (cur.length && s.end - cur[0].start > len) { windows.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length) windows.push(cur);
  return windows.filter((w) => w[w.length - 1].end - w[0].start > 20);
}

// Cheap first pass: score each window from text signals that tend to mark
// good short-form moments, so the slow AI only reads the promising parts.
const HOOK = /\b(nobody (tells|talks)|no one (tells|talks)|the truth|secret|mistake|worst|best|biggest|never|always|here'?s (the|what|something|a)|here is (the|what|something|a)|the (real )?reason|you won'?t|crazy|insane|honestly|i learned|lesson|one thing|tip|trick|myth|wrong|stop|don'?t|should you|the problem|changed my|saved my|almost|died|fired|quit|broke|million|thousand|hate|love|scared|shocked|surpris|turns out|what if|imagine|the key|rule)\b/gi;
const STORY = /\b(years ago|i remember|when i was|the night|the day|i thought|i realized|and then|suddenly|at (\w+ )?(in the morning|am|pm))\b/gi;
const FILLER = /\b(newsletter|housekeeping|sponsor|subscribe|link in|links below|next week|next episode|thanks for (listening|watching)|welcome back|before we start|quick note|patreon|discount code|promo code)\b/gi;

export function heuristicScore(win) {
  const text = win.map((s) => s.text).join(' ');
  const mins = Math.max(0.5, (win[win.length - 1].end - win[0].start) / 60);
  const count = (re) => (text.match(re) || []).length;
  const words = text.split(/\s+/).length;
  let score = 0;
  score += 2.0 * count(HOOK);
  score += 1.5 * count(STORY);
  score += 1.5 * count(/\?/g);
  score += 0.7 * count(/[$£€%]|\b\d{2,}\b/g);
  score += 0.7 * count(/!/g);
  score -= 3.0 * count(FILLER);
  score += Math.min(3, words / mins / 60); // denser speech, more to clip
  return score / mins;
}

// Split Whisper's segments into sentences, estimating each sentence's start
// time from its character position inside the segment.
function sentences(segments) {
  const out = [];
  for (const s of segments) {
    const parts = s.text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const total = s.text.length || 1;
    let pos = 0;
    for (const p of parts) {
      const i = s.text.indexOf(p, pos);
      const a = s.start + ((s.end - s.start) * i) / total;
      const b = s.start + ((s.end - s.start) * (i + p.length)) / total;
      out.push({ start: a, end: b, text: p, complete: /[.!?]$/.test(p) });
      pos = i + p.length;
    }
  }
  // Join fragments that a segment boundary split mid-sentence.
  const merged = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.complete) { prev.text += ' ' + s.text; prev.end = s.end; prev.complete = s.complete; }
    else merged.push({ ...s });
  }
  return merged;
}

const signal = (t) => 2 * (t.match(HOOK) || []).length + 1.5 * (t.match(STORY) || []).length
  + 1.5 * (t.match(/\?/g) || []).length + 0.7 * (t.match(/[$£€%!]|\b\d{2,}\b/g) || []).length
  - 3 * (t.match(FILLER) || []).length;

// Instant mode (no AI): every sentence is a candidate opening line. Score it
// by its own hook signals (weighted most) plus the next few sentences, pick
// the best non-overlapping starts, and run each to a sentence end at 25-55 s.
export function instantClips(segments, n) {
  const ss = sentences(segments);
  const cands = ss.map((s, i) => {
    const body = ss.slice(i + 1, i + 6).map((x) => x.text).join(' ');
    return { i, v: 2 * signal(s.text) + signal(body) };
  }).filter((c) => c.v > 2).sort((a, b) => b.v - a.v);
  const top = cands[0]?.v || 1;
  const clips = [];
  for (const c of cands) {
    let b = c.i;
    while (b < ss.length - 1 && ss[b].end - ss[c.i].start < 25 && ss[b + 1].end - ss[c.i].start <= 55) b++;
    const clip = {
      start: ss[c.i].start, end: ss[b].end,
      title: ss[c.i].text.replace(/[.!?]$/, '').split(/\s+/).slice(0, 8).join(' '),
      hook: 'Instant pick (no AI)',
      score: Math.max(1, Math.min(10, Math.round((10 * c.v) / top))),
      text: ss.slice(c.i, b + 1).map((x) => x.text).join(' '),
    };
    if (clip.end - clip.start < 12) continue;
    if (clips.some((o) => Math.min(o.end, clip.end) - Math.max(o.start, clip.start) > 0)) continue;
    clips.push(clip);
    if (clips.length >= n) break;
  }
  return clips;
}

export function promising(windows, n) {
  return windows
    .map((w, i) => ({ w, i, h: heuristicScore(w) }))
    .sort((a, b) => b.h - a.h)
    .slice(0, n)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.w);
}

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    start_line: { type: 'integer' },
    end_line: { type: 'integer' },
    title: { type: 'string' },
    score: { type: 'integer' },
  },
  required: ['start_line', 'end_line', 'title', 'score'],
});

// Kept short on purpose: on weak GPUs reading the prompt dominates the time.
const SYSTEM = `You edit viral short videos. From the numbered transcript lines, pick the best 20-60 second moment: strong hook in its first line, makes sense alone, ends on a payoff. JSON: start_line, end_line, title (catchy, max 8 words), score 1-10 (be strict).`;

// Ask for a JSON answer. Structured (grammar-constrained) output is tried
// first; some models trip WebLLM's grammar engine (seen with Phi-3.5:
// "Cannot pass deleted object as a pointer of type GrammarMatcher"), so after
// a failure the model is asked in plain mode for the rest of the session and
// the JSON object is pulled out of its text.
let grammarBroken = false;
async function askJSON(system, user, schema, maxTokens) {
  const base = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.3 };
  let reply;
  if (!grammarBroken) {
    try {
      reply = await engine.chat.completions.create({ ...base, max_tokens: maxTokens, response_format: { type: 'json_object', schema } });
    } catch (e) {
      console.warn('[omniclip] structured output failed, using plain mode', e);
      grammarBroken = true;
      await engine.resetChat().catch(() => {});
    }
  }
  if (!reply) {
    reply = await engine.chat.completions.create({
      ...base,
      messages: [base.messages[0], { role: 'user', content: user + '\n\nAnswer with only the JSON object.' }],
      max_tokens: maxTokens + 40,
    });
  }
  const u = reply.usage;
  console.log('[omniclip] llm', JSON.stringify({ in: u?.prompt_tokens, out: u?.completion_tokens, plain: grammarBroken, ...u?.extra }));
  const text = reply.choices[0].message.content || '';
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*?\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

export async function scoreWindow(win) {
  const lines = win.map((s, i) => `${i}| ${s.text}`).join('\n');
  const j = await askJSON(SYSTEM, lines, SCHEMA, 80);
  return j ? fitClip(win, j) : null;
}

// Smart mode: the cut is already fixed by the instant picker; the AI only
// rates the clip and writes a title (small models do this reliably, while
// choosing line numbers trips them up).
const CLIP_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { title: { type: 'string' }, score: { type: 'integer' } },
  required: ['title', 'score'],
});
const CLIP_SYSTEM = `You judge clips for TikTok/Reels/Shorts. Rate how well this clip works as a standalone viral short (strong opening hook, makes sense alone, payoff). Boring logistics, schedules or housekeeping score 1-3. Reply JSON: title (catchy, max 8 words), score 1-10.`;

export async function rateClip(clip) {
  const j = await askJSON(CLIP_SYSTEM, clip.text, CLIP_SCHEMA, 40);
  if (!j || !(j.score | 0)) return clip;
  const ai = Math.max(1, Math.min(10, j.score | 0));
  return {
    ...clip,
    title: String(j.title || clip.title).replace(/^["']|["']$/g, '').slice(0, 80),
    hook: `Text signals ${clip.score}/10 · AI ${ai}/10`,
    score: Math.round((clip.score + ai) / 2),
  };
}

// Turn the model's line numbers into a clip of a sensible length.
function fitClip(win, j) {
  let a = Math.max(0, Math.min(win.length - 1, j.start_line | 0));
  let b = Math.max(a, Math.min(win.length - 1, j.end_line | 0));
  const dur = () => win[b].end - win[a].start;
  while (dur() < 18 && b < win.length - 1) b++;   // too short: extend forward
  while (dur() < 18 && a > 0) a--;                 // still short: extend back
  while (dur() > 65 && b > a) b--;                 // too long: trim the tail
  if (dur() < 8) return null;
  return {
    start: win[a].start,
    end: win[b].end,
    title: String(j.title || '').slice(0, 80),
    hook: '',
    score: Math.max(1, Math.min(10, j.score | 0)),
    text: win.slice(a, b + 1).map((s) => s.text).join(' '),
  };
}

export function rank(clips, n) {
  const sorted = clips.filter(Boolean).sort((x, y) => y.score - x.score);
  const out = [];
  for (const c of sorted) {
    const overlaps = out.some((o) => Math.min(o.end, c.end) - Math.max(o.start, c.start) > 0.5 * (c.end - c.start));
    if (!overlaps) out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

export { fmt };
