// Streamed audio decode for big MP4/MOV files: reads the file in 8 MB pieces,
// pulls out only the audio track (mp4box.js), decodes it with the browser's
// AudioDecoder (WebCodecs) and box-filters it down to 16 kHz mono on the fly.
// Memory stays near the size of the 16 kHz result instead of the whole file
// plus its full-rate decoded audio.
const SR = 16000;
const CHUNK = 8 * 1024 * 1024;

export const canStreamDecode = () => 'AudioDecoder' in window;

export async function decodeAudioStream(file, onProgress) {
  const MP4Box = (await import('https://cdn.jsdelivr.net/npm/mp4box@0.5.3/+esm')).default;
  const mp4 = MP4Box.createFile();
  let out = null, outLen = 0;
  let ratio = 0, t = 0, base = 0; // resampler state, in source-sample units
  let decoder = null, fail = null, trackId = null;

  const push = (m) => {
    // Box filter: each output sample is the mean of `ratio` source samples.
    const end = base + m.length;
    while (t + ratio <= end) {
      const a = Math.max(0, Math.floor(t) - base), b = Math.min(m.length, Math.floor(t + ratio) - base);
      let s = 0; for (let i = a; i < b; i++) s += m[i];
      if (outLen >= out.length) { // duration unknown up front (fragmented MP4): grow
        const bigger = new Float32Array(Math.ceil(out.length * 1.5) + SR * 60);
        bigger.set(out); out = bigger;
      }
      out[outLen++] = b > a ? s / (b - a) : 0;
      t += ratio;
    }
    base = end;
  };

  const ready = new Promise((resolve, reject) => {
    mp4.onError = (e) => reject(new Error('Could not read this file: ' + e));
    mp4.onReady = (info) => {
      const tr = info.audioTracks[0];
      if (!tr) { reject(new Error('This file has no audio track.')); return; }
      trackId = tr.id;
      const entry = mp4.getTrackById(tr.id).mdia.minf.stbl.stsd.entries[0];
      const desc = entry.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
      const rate = tr.audio.sample_rate, ch = tr.audio.channel_count;
      ratio = rate / SR;
      const seconds = info.duration / info.timescale || tr.duration / tr.timescale;
      out = new Float32Array(Math.ceil((seconds || 60) * SR) + SR);
      decoder = new AudioDecoder({
        output: (ad) => {
          const n = ad.numberOfFrames;
          const a = new Float32Array(n);
          ad.copyTo(a, { planeIndex: 0, format: 'f32-planar' });
          if (ad.numberOfChannels > 1) {
            const b = new Float32Array(n);
            ad.copyTo(b, { planeIndex: 1, format: 'f32-planar' });
            for (let i = 0; i < n; i++) a[i] = (a[i] + b[i]) / 2;
          }
          ad.close();
          push(a);
        },
        error: (e) => { fail = e; },
      });
      decoder.configure({ codec: tr.codec, sampleRate: rate, numberOfChannels: ch, ...(desc ? { description: desc } : {}) });
      mp4.setExtractionOptions(tr.id, null, { nbSamples: 400 });
      mp4.onSamples = (id, _u, samples) => {
        for (const s of samples) {
          decoder.decode(new EncodedAudioChunk({
            type: 'key', timestamp: (s.cts * 1e6) / s.timescale, duration: (s.duration * 1e6) / s.timescale, data: s.data,
          }));
        }
        mp4.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
      };
      mp4.start();
      resolve();
    };
  });

  let off = 0;
  ready.catch(() => {}); // awaited below
  while (off < file.size) {
    if (fail) throw fail;
    const buf = await file.slice(off, off + CHUNK).arrayBuffer();
    buf.fileStart = off;
    const next = mp4.appendBuffer(buf);
    off = next && next > off ? next : off + buf.byteLength;
    onProgress?.(Math.min(1, off / file.size));
    // Let the decoder catch up so encoded audio doesn't pile up in memory.
    while (decoder && decoder.decodeQueueSize > 64) await new Promise((r) => setTimeout(r, 5));
  }
  mp4.flush();
  await ready;
  await decoder.flush();
  if (fail) throw fail;
  decoder.close();
  return out.subarray(0, outLen);
}
