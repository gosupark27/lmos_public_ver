// Full-screen moments: sunrise, silence, an outbreak, peace, and the end where the game admits it sees you.
import { h, svg, reducedMotion } from './dom.js';
import { makeSky } from './sky.js';
import { CAPYBARA } from './art.js';
import { CROSSINGS } from '../engine/content.js';
import { charOf, archName } from './common.js';

let current = null;

function closeCurrent() {
  if (current) { current.remove(); current = null; }
}

function typeOut(el, text, speed = 55) {
  if (reducedMotion()) { el.textContent = text; return; }
  el.textContent = '';
  let i = 0;
  const t = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(t); }, speed);
}

export function moment(app, kind) {
  closeCurrent();
  const p = app.pub || {};
  const me = app.priv || {};
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const card = h('div', { class: 'card' });
  const cls = { outbreak: 'curtain outbreak', peace: 'curtain peace' }[kind] || 'curtain';
  const el = h('div', { class: cls, role: 'dialog', 'aria-live': 'assertive', 'aria-label': kind, tabindex: '-1' }, canvas, card);
  const start = performance.now();
  let progress = () => 0.2;
  let life = 5200;
  let fracture = () => null;

  if (kind === 'sunrise') {
    const act = p.act || 1;
    const name = ['Act I', 'Act II', 'Act III'][act - 1];
    const triad = ['The beginner road', 'The intermediate road', 'The advanced road'][act - 1];
    const crossing = CROSSINGS.find((c) => c.act === act);
    progress = () => Math.min(1, 0.1 + ((performance.now() - start) / 5000) * 0.8);
    if (p.round === 0) {
      const seat = (p.seats || []).find((s) => s.id === me.seat);
      const ch = charOf(seat);
      card.append(h('h1', null, 'The train forms'),
        ch ? h('p', null, `You are the ${ch.name}, a ${archName(seat.archetype)}.`) : null,
        ch ? h('p', { class: 'tapnote' }, ch.garb) : null);
      life = 6000;
    } else {
      card.append(h('h1', null, `${name}`), h('p', null, `${triad}. Ahead: ${crossing ? crossing.name : 'the sea'}.`));
      if (p.era) {
        fracture = () => p.era;
        card.append(h('span', { class: 'era-word' }, p.era === '1775' ? '1775' : 'ROME'),
          h('p', { class: 'tapnote' }, p.era === '1775' ? 'The table has mostly kept its word. The country leans toward a founding.' : 'The table has broken its word too often. The country leans toward an empire.'));
      }
      if (p.apocalypse) card.append(h('p', { class: 'tapnote' }, 'The sky went pink. The last days.'));
    }
  } else if (kind === 'silence') {
    progress = () => 0.08;
    card.append(h('h1', null, 'Be still.'), h('p', null, 'Before anyone speaks, look at who you’re riding with.'));
    life = 4500;
  } else if (kind === 'outbreak') {
    progress = () => 0.15;
    if (me.turned) {
      card.append(h('h1', null, 'You turned.'), h('p', null, 'No one else knows. If the train fails, you win. You can still step forward before anyone names you.'));
      life = 7000;
    } else {
      card.append(h('h1', null, 'Something turned.'), h('p', null, 'Someone at this table is not who they were at dawn.'));
    }
  } else if (kind === 'peace') {
    progress = () => 1;
    card.append(h('h1', null, 'Peace.'), h('p', null, 'Four offerings, freely made. The table is frozen. Listen for the bell.'));
    life = 9000;
  } else if (kind === 'matrix') {
    progress = () => 0.5;
    const line = h('p', { class: 'matrix' });
    card.append(line, h('p', { class: 'tapnote' }, 'Every word you said was checked against what you did.'));
    typeOut(line, 'I saw everything.');
    life = 4200;
  } else if (kind === 'eggSunrise') {
    progress = () => Math.min(1, ((performance.now() - start) / 6000));
    card.append(h('h1', null, 'I-10, eastbound'), h('p', null, '5:42 a.m. The same sunrise for everyone at the table.'));
    life = 6500;
  } else if (kind === 'matrixEgg') {
    const line = h('p', { class: 'matrix' });
    card.append(line);
    typeOut(line, 'It sees you.');
    life = 3200;
  }
  card.append(h('p', { class: 'tapnote' }, 'Tap to continue'));
  el.addEventListener('click', closeCurrent);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') closeCurrent(); });
  document.body.appendChild(el);
  current = el;
  el.focus();
  makeSky(canvas, { seed: 99, clock: () => (app.serverNow ? app.serverNow() : Date.now()), progress, fracture });
  setTimeout(() => { if (current === el) closeCurrent(); }, life);
}

export function capyRain() {
  if (reducedMotion()) return;
  const rain = h('div', { class: 'rain', 'aria-hidden': 'true' });
  for (let i = 0; i < 28; i++) {
    const c = svg(CAPYBARA);
    c.style.left = `${Math.random() * 96}vw`;
    c.style.animationDuration = `${2.6 + Math.random() * 2.4}s`;
    c.style.animationDelay = `${Math.random() * 1.6}s`;
    rain.appendChild(c);
  }
  document.body.appendChild(rain);
  setTimeout(() => rain.remove(), 6500);
}
