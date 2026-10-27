// The sunrise. Desert ridge, saguaros, and I-10 running east into it.
// Everything moves on the server clock, so every phone at the table shows the same sky.

import { reducedMotion } from './dom.js';

function seeded(n) {
  let s = n >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function makeSky(canvas, { seed = 7, clock = () => Date.now(), progress = () => 0.3, fracture = () => null, sunX = 0.5 } = {}) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 1, raf = 0, last = 0, alive = true;
  const rnd = seeded(seed);
  const stars = Array.from({ length: 70 }, () => ({ x: rnd(), y: rnd() * 0.8, r: 0.4 + rnd() * 1.2, ph: rnd() * 6.28 }));
  const ridge = Array.from({ length: 9 }, () => rnd());
  const cacti = Array.from({ length: 6 }, () => ({ x: 0.06 + rnd() * 0.88, s: 0.6 + rnd() * 0.6, arm: rnd() }));

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function saguaro(x, base, s, arm) {
    const W = 5 * s, H = 34 * s, r = W * 0.4;
    ctx.beginPath();
    ctx.roundRect(x - W / 2, base - H, W, H, W / 2);
    const ly = base - H * (0.4 + arm * 0.15);
    const lx = x - W / 2 - W * 1.5;
    ctx.roundRect(lx, ly - r, W * 2, W * 0.8, r);
    ctx.roundRect(lx, ly - H * 0.3, W * 0.8, H * 0.3 + r, r);
    const ry = base - H * (0.58 - arm * 0.12);
    const rx = x + W / 2 + W * 0.7;
    ctx.roundRect(x, ry - r, W * 2, W * 0.8, r);
    ctx.roundRect(rx, ry - H * 0.24, W * 0.8, H * 0.24 + r, r);
    ctx.fill();
  }

  function draw(now) {
    if (!w || (canvas.clientWidth && (canvas.clientWidth !== w || canvas.clientHeight !== h))) resize();
    ctx.clearRect(0, 0, w, h);
    const p = Math.max(0, Math.min(1, progress()));
    const t = clock() / 1000;
    const sunA = cssVar(canvas, '--sun-a', '#f7c948');
    const ground = '#0d1022';

    // Stars fade as the sun comes up.
    const starAlpha = Math.max(0, 0.9 - p * 1.1);
    if (starAlpha > 0) {
      ctx.fillStyle = '#f3ecdd';
      for (const s of stars) {
        ctx.globalAlpha = starAlpha * (0.55 + 0.45 * Math.sin(t * 1.3 + s.ph));
        ctx.beginPath();
        ctx.arc(s.x * w, s.y * h * 0.7, s.r, 0, 6.283);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // The sun.
    const horizon = h - 30;
    const R = Math.min(w, h) * 0.22 + 18;
    const cy = horizon + R * 0.9 - p * (R * 1.5 + h * 0.18);
    const sx = w * sunX;
    const g = ctx.createRadialGradient(sx, cy, R * 0.2, sx, cy, R * 3.2);
    g.addColorStop(0, sunA);
    g.addColorStop(0.32, sunA + '88');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = sunA;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.arc(sx, cy, R, 0, 6.283);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Ridge line.
    ctx.fillStyle = ground;
    ctx.beginPath();
    ctx.moveTo(0, h);
    const seg = w / (ridge.length - 1);
    ctx.lineTo(0, horizon - ridge[0] * 18);
    for (let i = 1; i < ridge.length; i++) ctx.lineTo(i * seg, horizon - 6 - ridge[i] * (i % 3 === 0 ? 30 : 16));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(0, horizon + 4, w, h - horizon);

    // I-10, eastbound into the sunrise.
    ctx.strokeStyle = 'rgba(243, 236, 221, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 3, horizon + 4);
    ctx.lineTo(w * 0.18, h);
    ctx.moveTo(w / 2 + 3, horizon + 4);
    ctx.lineTo(w * 0.82, h);
    ctx.stroke();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(244, 184, 96, 0.35)';
    ctx.beginPath();
    ctx.moveTo(w / 2, horizon + 6);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const c of cacti) {
      if (Math.abs(c.x - 0.5) < 0.12) continue;
      saguaro(c.x * w, horizon + 10 + c.s * 6, c.s * Math.max(0.7, Math.min(1.4, h / 190)), c.arm);
    }

    // The fracture between Rome and 1775.
    const fr = fracture();
    if (fr) {
      ctx.strokeStyle = fr === 'rome' ? 'rgba(201, 162, 39, 0.8)' : 'rgba(140, 192, 236, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let x = w * 0.15, y = h * 0.1;
      ctx.moveTo(x, y);
      const r2 = seeded(seed + 99);
      while (y < horizon) { x += (r2() - 0.4) * 40; y += 12 + r2() * 18; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  }

  let seen = false;
  function loop(ts) {
    if (!alive) return;
    if (canvas.isConnected) seen = true;
    else if (seen) { alive = false; if (ro) ro.disconnect(); return; }
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    if (ts - last < 50) return;
    last = ts;
    draw(ts);
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { resize(); draw(performance.now()); }) : null;
  if (ro) ro.observe(canvas);
  resize();
  draw(performance.now());
  if (!reducedMotion()) raf = requestAnimationFrame(loop);

  return {
    redraw: () => draw(performance.now()),
    destroy() { alive = false; cancelAnimationFrame(raf); if (ro) ro.disconnect(); },
  };
}

export function ridgeSvg() {
  return '<svg class="ridge" viewBox="0 0 400 46" preserveAspectRatio="none" fill="currentColor"><path d="M0 46V28l40-8 30 6 50-14 40 10 36-6 44 12 30-10 46 8 40-12 44 14v26z"/></svg>';
}
