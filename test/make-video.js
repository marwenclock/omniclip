// Test helper: renders a landscape 1280x720 video in the browser from a WAV
// (an animated "presenter" that drifts left and right plus an on-screen clock),
// so export layouts can be checked without real footage. Runs in real time.
export async function makeTestVideo(wavUrl, from, seconds) {
  const W = 1280, H = 720;
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  const ac = new AudioContext();
  const buf = await ac.decodeAudioData(await (await fetch(wavUrl)).arrayBuffer());
  const srcNode = ac.createBufferSource();
  srcNode.buffer = buf;
  const dest = ac.createMediaStreamDestination();
  srcNode.connect(dest);
  const stream = canvas.captureStream(30);
  stream.addTrack(dest.stream.getAudioTracks()[0]);
  const mime = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4e6 });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise((r) => { rec.onstop = r; });
  const t0 = performance.now();
  const draw = () => {
    const t = (performance.now() - t0) / 1000;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#2b4c7e'); g.addColorStop(1, '#1b2a3a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // bookshelf-ish backdrop
    for (let i = 0; i < 12; i++) { ctx.fillStyle = `hsl(${i * 30},40%,35%)`; ctx.fillRect(60 + i * 100, 80, 60, 160); }
    // presenter: drifts between x=380 and x=900 so auto-reframe has to follow
    const x = 640 + Math.sin(t / 6) * 260;
    ctx.fillStyle = '#d9a37a'; ctx.beginPath(); ctx.arc(x, 330, 80, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c0392b'; ctx.fillRect(x - 130, 420, 260, 300);
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(x - 28, 315, 9, 0, 7); ctx.arc(x + 28, 315, 9, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 40px system-ui'; ctx.fillText(`TEST ${(from + t).toFixed(1)}s`, 40, 680);
    ctx.fillText('LEFT', 20, 380); ctx.fillText('RIGHT', W - 140, 380);
  };
  draw();
  rec.start(1000);
  srcNode.start(0, from, seconds);
  await new Promise((resolve) => {
    const iv = setInterval(() => { draw(); if ((performance.now() - t0) / 1000 >= seconds) { clearInterval(iv); resolve(); } }, 33);
  });
  rec.stop();
  await done;
  ac.close();
  return new File(parts, `landscape-test.${mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`, { type: mime.split(';')[0] });
}
