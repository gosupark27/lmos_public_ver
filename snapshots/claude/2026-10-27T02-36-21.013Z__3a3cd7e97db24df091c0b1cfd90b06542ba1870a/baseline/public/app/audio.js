// Sound, all synthesized: no files. Music before glow; a bell for every seat that fills.
// The designed bell cue is PARKED in the sync file, so these are placeholders.

import { store } from './dom.js';

const PENTA = [293.66, 329.63, 369.99, 440.0, 493.88, 587.33, 659.25, 739.99, 880.0, 987.77, 1174.66, 1318.51];

let ctx = null;
let master = null;
let musicNodes = null;
let muted = store.get('hs:muted', false);

function ensure() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.8;
  master.connect(ctx.destination);
  return ctx;
}

export const audio = {
  get muted() { return muted; },
  unlock() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
    return !!c;
  },
  setMuted(v) {
    muted = !!v;
    store.set('hs:muted', muted);
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.05);
  },
  bell(index = 0, { gain = 0.22, decay = 3.2 } = {}) {
    const c = ensure();
    if (!c || c.state !== 'running') return;
    const f = PENTA[index % PENTA.length];
    const t = c.currentTime;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    out.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    out.connect(master);
    // A small FM bell: carrier plus an inharmonic modulator.
    const car = c.createOscillator();
    const mod = c.createOscillator();
    const modGain = c.createGain();
    car.frequency.value = f;
    mod.frequency.value = f * 2.76;
    modGain.gain.setValueAtTime(f * 1.6, t);
    modGain.gain.exponentialRampToValueAtTime(1, t + decay * 0.8);
    mod.connect(modGain).connect(car.frequency);
    car.connect(out);
    car.start(t); mod.start(t);
    car.stop(t + decay + 0.1); mod.stop(t + decay + 0.1);
  },
  peal() {
    [0, 2, 4, 7].forEach((n, i) => setTimeout(() => audio.bell(n, { gain: 0.26, decay: 5.5 }), i * 220));
  },
  rumble() {
    const c = ensure();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(55, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 2.4);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    o.connect(lp).connect(g).connect(master);
    o.start(t); o.stop(t + 2.7);
  },
  music(on) {
    const c = ensure();
    if (!c) return;
    if (!on) {
      if (musicNodes) {
        const t = c.currentTime;
        musicNodes.gain.gain.setTargetAtTime(0.0001, t, 0.6);
        const n = musicNodes;
        setTimeout(() => { try { n.stop(); } catch { /* done */ } }, 2500);
        musicNodes = null;
      }
      return;
    }
    if (musicNodes) return;
    const t = c.currentTime;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.09, t + 3);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.connect(gain).connect(master);
    const voices = [146.83, 220.0, 293.66].map((f, i) => {
      const o = c.createOscillator();
      o.type = i === 2 ? 'sine' : 'triangle';
      o.frequency.value = f;
      o.detune.value = (i - 1) * 6;
      const lfo = c.createOscillator();
      const lg = c.createGain();
      lfo.frequency.value = 0.07 + i * 0.03;
      lg.gain.value = 4;
      lfo.connect(lg).connect(o.detune);
      o.connect(lp);
      o.start(t); lfo.start(t);
      return [o, lfo];
    });
    let step = 0;
    const timer = setInterval(() => {
      if (c.state !== 'running') return;
      const seq = [0, 3, 5, 3, 1, 3, 4, 2];
      audio.bell(seq[step % seq.length], { gain: 0.045, decay: 2.4 });
      step += 1;
    }, 1700);
    musicNodes = { gain, stop: () => { clearInterval(timer); for (const [o, l] of voices) { o.stop(); l.stop(); } } };
  },
};
