// Timeline for the selected short: a time ruler, one block per range (with the
// source waveform), caption chunks underneath and a draggable playhead.
// Drag a block's edge to trim it; click or drag elsewhere to move the playhead.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtT = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${String(Math.floor(s)).padStart(2, '0')}`; };

export class Timeline {
  constructor(canvas, hooks) {
    this.c = canvas; this.h = hooks;
    this.data = null; this.t = 0; this.pps = 40; this.scroll = 0; this.fit = true;
    this.drag = null;
    new ResizeObserver(() => { if (this.fit && this.data) this.fitAll(); this.draw(); }).observe(canvas);
    // Positions come from the bounding box, not offsetX, so zoomed pages and pens agree.
    const pos = (e) => { const b = canvas.getBoundingClientRect(); return { offsetX: e.clientX - b.left, offsetY: e.clientY - b.top, pointerId: e.pointerId }; };
    canvas.addEventListener('pointerdown', (e) => this.down(pos(e)));
    canvas.addEventListener('pointermove', (e) => this.move(pos(e)));
    canvas.addEventListener('pointerup', (e) => this.up(pos(e)));
    canvas.addEventListener('pointercancel', (e) => this.up(pos(e)));
    canvas.addEventListener('wheel', (e) => {
      if (!this.data) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - canvas.getBoundingClientRect().left);
      else { this.fit = false; this.scroll = Math.max(0, this.scroll + (e.deltaX || e.deltaY) / this.pps); this.draw(); }
    }, { passive: false });
  }
  // data = { blocks: [{ len, label, src, start, end, speed }], captions: [{ t0, t1 }] (sequence time), duration, peaks: {src: Float32Array} }
  set(data) {
    const durChanged = Math.abs((data?.duration || 0) - (this.data?.duration || 0)) > 1e-3;
    this.data = data;
    if ((this.fit || durChanged) && !this.drag) this.fitAll(); // keep the scale steady while dragging a trim
    this.draw();
    requestAnimationFrame(() => { if (this.fit && !this.drag) { this.fitAll(); this.draw(); } }); // after layout settles
  }
  setTime(t) {
    this.t = t;
    if (this.data && !this.drag) { // keep the playhead in view
      const W = this.c.clientWidth, x = (t - this.scroll) * this.pps;
      if (x > W - 30 || x < 0) { this.scroll = Math.max(0, t - 30 / this.pps); this.fit = false; }
    }
    this.draw();
  }
  fitAll() { const W = this.c.getBoundingClientRect().width || 600; this.pps = Math.max(2, (W - 24) / Math.max(1, this.data?.duration || 1)); this.scroll = 0; this.fit = true; }
  zoom(k, atX = this.c.clientWidth / 2) {
    const at = this.scroll + atX / this.pps;
    this.pps = Math.max(2, Math.min(800, this.pps * k));
    this.scroll = Math.max(0, at - atX / this.pps); this.fit = false; this.draw();
  }
  x2t(x) { return Math.max(0, Math.min(this.data?.duration || 0, this.scroll + x / this.pps)); }
  edgeAt(x, y) {
    if (!this.data || y < 18 || y > 18 + this.bh) return null;
    let acc = 0;
    for (let i = 0; i < this.data.blocks.length; i++) {
      const b = this.data.blocks[i];
      const x0 = (acc - this.scroll) * this.pps, x1 = (acc + b.len - this.scroll) * this.pps;
      if (Math.abs(x - x0) < 7) return { i, side: 'start', x0: acc };
      if (Math.abs(x - x1) < 7) return { i, side: 'end', x0: acc };
      acc += b.len;
    }
    return null;
  }
  down(e) {
    if (!this.data) return;
    try { this.c.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const edge = this.edgeAt(e.offsetX, e.offsetY);
    if (edge) {
      const b = this.data.blocks[edge.i];
      this.drag = { kind: 'trim', ...edge, x: e.offsetX, orig: edge.side === 'start' ? b.start : b.end, speed: b.speed || 1 };
    } else { this.drag = { kind: 'seek' }; this.h.seek(this.x2t(e.offsetX)); }
  }
  move(e) {
    if (!this.data) return;
    if (!this.drag) { this.c.style.cursor = this.edgeAt(e.offsetX, e.offsetY) ? 'ew-resize' : 'pointer'; return; }
    if (this.drag.kind === 'seek') this.h.seek(this.x2t(e.offsetX));
    else this.h.trim(this.drag.i, this.drag.side, this.drag.orig + ((e.offsetX - this.drag.x) / this.pps) * this.drag.speed);
  }
  up() { const trim = this.drag?.kind === 'trim'; this.drag = null; if (trim) { this.h.trimEnd?.(); if (this.fit) { this.fitAll(); this.draw(); } } }

  draw() {
    const c = this.c, dpr = devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const ink = css('--ink') || '#f5f5f5', muted = css('--muted') || '#8a8a8a', line = 'rgba(255,255,255,.12)';
    const d = this.data;
    if (!d) { g.fillStyle = muted; g.font = '12px Geist, sans-serif'; g.fillText('Select a clip to see its timeline', 12, H / 2); return; }
    const capH = d.captions?.length ? 18 : 0;
    this.bh = H - 18 - capH - 8;
    // ruler
    g.font = '10px "Geist Mono", monospace'; g.fillStyle = muted; g.strokeStyle = line;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * this.pps >= 60) || 600;
    for (let t = Math.floor(this.scroll / step) * step; (t - this.scroll) * this.pps < W; t += step) {
      const x = (t - this.scroll) * this.pps;
      g.fillRect(x, 12, 1, 6);
      g.fillText(fmtT(t), x + 3, 10);
    }
    // blocks
    let acc = 0;
    d.blocks.forEach((b, i) => {
      const x0 = (acc - this.scroll) * this.pps, w = b.len * this.pps, y = 18;
      if (x0 + w > 0 && x0 < W) {
        g.fillStyle = b.active ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.08)';
        g.strokeStyle = b.active ? 'rgba(255,255,255,.7)' : 'rgba(255,255,255,.25)';
        g.lineWidth = 1;
        g.beginPath(); g.roundRect(x0 + 1, y, Math.max(2, w - 2), this.bh, 6); g.fill(); g.stroke();
        const pk = d.peaks?.[b.src];
        if (pk) { // waveform from the source audio (100 peaks per second)
          g.fillStyle = 'rgba(255,255,255,.45)';
          const mid = y + this.bh / 2, amp = this.bh / 2 - 6;
          for (let px = Math.max(0, Math.floor(x0)); px < Math.min(W, x0 + w); px++) {
            const st = b.start + ((px - x0) / this.pps) * (b.speed || 1);
            const k = Math.floor(st * 100);
            const v = Math.min(1, (pk[k] || 0) * 1.6) * amp;
            g.fillRect(px, mid - v, 1, Math.max(1, v * 2));
          }
        }
        g.fillStyle = ink; g.font = '600 11px Geist, sans-serif';
        g.save(); g.beginPath(); g.rect(x0 + 6, y, Math.max(0, w - 12), 18); g.clip();
        g.fillText(b.label, x0 + 8, y + 13); g.restore();
        // trim handles
        g.fillStyle = 'rgba(255,255,255,.85)';
        g.fillRect(x0 + 1, y + this.bh / 2 - 9, 3, 18);
        g.fillRect(x0 + w - 4, y + this.bh / 2 - 9, 3, 18);
      }
      acc += b.len;
    });
    // captions
    if (capH) {
      const y = 18 + this.bh + 4;
      g.fillStyle = 'rgba(255,255,255,.22)';
      for (const cp of d.captions) {
        const x0 = (cp.t0 - this.scroll) * this.pps, w = Math.max(2, (cp.t1 - cp.t0) * this.pps - 1);
        if (x0 + w < 0 || x0 > W) continue;
        g.beginPath(); g.roundRect(x0, y, w, capH - 4, 3); g.fill();
      }
    }
    // playhead
    const px = (this.t - this.scroll) * this.pps;
    g.fillStyle = ink;
    g.fillRect(px - 0.5, 0, 2, H);
    g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 6, 0); g.lineTo(px + 0.5, 7); g.fill();
  }
}
