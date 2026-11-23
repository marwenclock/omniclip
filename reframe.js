// Auto-reframe: find where the speaker is so a 9:16 crop can follow them.
// Before export, the clip is sampled a few times per second with MediaPipe's
// face detector (small free model, runs on the device), the biggest face's
// horizontal centre is recorded, and the path is smoothed so the crop glides
// instead of jittering. With no faces found, the crop stays where it was set.
const VER = '0.10.14';
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

let detectorP = null;
function detector() {
  detectorP ??= (async () => {
    const { FilesetResolver, FaceDetector } = await import(`${BASE}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    const make = (delegate) => FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
    });
    try { return await make('GPU'); } catch { return await make('CPU'); }
  })();
  return detectorP;
}

// Returns a function t -> crop position 0..1 (0 = left edge, 1 = right edge),
// or null when no face was found in the clip.
export async function trackSpeaker(url, clip, cropFrac, onProgress) {
  const det = await detector();
  const v = document.createElement('video');
  v.src = url; v.muted = true; v.preload = 'auto';
  await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('Could not open the source.')); });
  if (!v.videoWidth) return null;
  // The short-range model squeezes its input to 128x128, so a whole wide frame
  // makes faces too small to find. Detect on overlapping square tiles instead
  // (side = the frame's short edge), each downscaled to 256 px.
  const vw = v.videoWidth, vh = v.videoHeight, side = Math.min(vw, vh);
  const nTiles = Math.max(1, Math.ceil(Math.max(vw, vh) / side) + (vw === vh ? 0 : 1));
  const tiles = Array.from({ length: nTiles }, (_, i) => (nTiles === 1 ? 0 : i / (nTiles - 1)));
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const detectFrame = () => {
    const found = [];
    for (const f of tiles) {
      const sx = vw > vh ? (vw - side) * f : 0, sy = vh > vw ? (vh - side) * f : 0;
      ctx.drawImage(v, sx, sy, side, side, 0, 0, 256, 256);
      for (const d of det.detect(c).detections) {
        const b = d.boundingBox, k = side / 256;
        found.push({ x: (sx + (b.originX + b.width / 2) * k) / vw, size: b.width * k });
      }
    }
    return found.sort((a, b) => b.size - a.size)[0];
  };
  const step = 0.5;
  const pts = [];
  const n = Math.ceil((clip.end - clip.start) / step) + 1;
  for (let i = 0; i < n; i++) {
    const t = Math.min(clip.end, clip.start + i * step);
    v.currentTime = t;
    await new Promise((r) => { v.onseeked = r; });
    const best = detectFrame();
    if (best) pts.push({ t, x: best.x });
    onProgress?.((i + 1) / n);
  }
  v.removeAttribute('src'); v.load();
  if (pts.length < Math.max(2, n * 0.2)) return null; // too few faces to trust

  // Fill gaps by holding the last seen position, then smooth.
  const xs = [];
  let k = 0, last = pts[0].x;
  for (let i = 0; i < n; i++) {
    const t = clip.start + i * step;
    while (k < pts.length && pts[k].t <= t + 1e-6) { last = pts[k].x; k++; }
    xs.push(last);
  }
  const R = 3; // moving average over ~3 s
  const smooth = xs.map((_, i) => {
    const a = Math.max(0, i - R), b = Math.min(xs.length - 1, i + R);
    let s = 0; for (let j = a; j <= b; j++) s += xs[j];
    return s / (b - a + 1);
  });
  // Face centre x (0..1 of the frame) -> crop position so the face is centred.
  const toPos = (fx) => Math.max(0, Math.min(1, (fx - cropFrac / 2) / (1 - cropFrac)));
  return (t) => {
    const f = Math.max(0, Math.min(smooth.length - 1, (t - clip.start) / step));
    const i = Math.floor(f), j = Math.min(smooth.length - 1, i + 1);
    return toPos(smooth[i] + (smooth[j] - smooth[i]) * (f - i));
  };
}
