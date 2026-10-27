// Home: the sunrise, the two ways in, and the room search (which also finds easter eggs).
import { h, store, toast } from './dom.js';
import { EGGS } from '../engine/content.js';
import { makeSky } from './sky.js';
import { audio } from './audio.js';
import { openRules, openCanon } from './sheets.js';
import { capyRain, moment } from './moments.js';
import { DEFAULT_CONFIG } from '../engine/state.js';

function skyBand(app, { tall = false, progress = 0.32, seed = 1840 } = {}) {
  const canvas = h('canvas', { class: 'sun-canvas', 'aria-hidden': 'true' });
  const band = h('header', { class: 'sky' + (tall ? ' home-sky' : '') }, canvas);
  queueMicrotask(() => makeSky(canvas, { seed, clock: () => app.serverNow(), progress: () => progress }));
  return band;
}

function normalizeSearch(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

function findEgg(q) {
  let e = EGGS[q] || EGGS[q.replace(/-/g, '')];
  if (e && e.alias) e = EGGS[e.alias];
  return e || null;
}

export function renderHome(app) {
  document.documentElement.dataset.sun = 'yellow';
  const out = h('div', { class: 'egg-out', 'aria-live': 'polite' });
  const input = h('input', {
    id: 'room-search', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    placeholder: 'Room code, like KDRM-4H7Q', 'aria-describedby': 'search-help',
  });
  const go = () => {
    const q = normalizeSearch(input.value);
    if (!q) return;
    const code = q.replace(/-/g, '');
    if (/^[A-Z0-9]{8}$/.test(code) && !findEgg(q)) {
      if (app.preview) { toast('Real rooms run on the server version. Practice here with bots.'); return; }
      app.go(`/r/${code.slice(0, 4)}-${code.slice(4)}`);
      return;
    }
    const egg = findEgg(q);
    if (!egg) { out.replaceChildren(h('p', { class: 'dim' }, 'No table answers to that. Room codes are eight letters and numbers.')); return; }
    const key = Object.keys(EGGS).find((k) => EGGS[k] === egg) || q;
    const found = new Set(store.get('hs:eggs', []));
    found.add(key);
    store.set('hs:eggs', [...found]);
    app.ui.eggs = [...found];
    audio.unlock();
    out.replaceChildren(h('div', { class: 'egg' }, h('h3', null, egg.title), h('p', null, egg.text),
      h('p', { class: 'dim' }, `${found.size} of ${Object.keys(EGGS).filter((k) => !EGGS[k].alias).length} found on this device.`)));
    if (egg.bell) audio.peal();
    if (egg.rain) capyRain();
    if (egg.canon) openCanon();
    if (egg.sunrise) moment(app, 'eggSunrise');
    if (egg.matrix) moment(app, 'matrixEgg');
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  const config = { ...DEFAULT_CONFIG, ...store.get('hs:config', {}) };
  const hostBtn = app.preview ? null : h('button', { class: 'btn primary', type: 'button', onclick: () => app.hostTable(config) }, 'Host a table');
  const practiceBtn = h('button', {
    class: 'btn' + (app.preview ? ' primary' : ''), type: 'button',
    onclick: () => app.practice({ ...config, fillBots: true, pace: config.pace === 'blitz' ? 'quick' : config.pace }),
  }, app.preview ? 'Set a practice table' : 'Practice with bots');

  return h('div', null,
    h('header', { class: 'sky home-sky' },
      (() => { const c = h('canvas', { class: 'sun-canvas', 'aria-hidden': 'true' }); queueMicrotask(() => makeSky(c, { seed: 1840, clock: () => Date.now(), progress: () => 0.3, sunX: 0.74 })); return c; })(),
      h('h1', null, 'Handshake'),
      h('p', { class: 'lede' }, 'Social deduction on the westward trail. No login, no names, no faces. Just your word.')),
    h('main', { class: 'home-body' },
      h('div', { class: 'home-actions' },
        h('div', { class: 'row' }, hostBtn, practiceBtn),
        h('div', { class: 'search' },
          h('label', { for: 'room-search' }, 'Find your table'),
          h('div', { class: 'row' }, input, h('button', { class: 'btn', type: 'button', onclick: go }, 'Go')),
          h('span', { id: 'search-help', class: 'sr' }, 'Type a room code to join, or try a word.'))),
      out,
      h('p', { class: 'fineprint' },
        app.preview
          ? 'This is the single-device preview: you play one seat and bots play the rest, with the same rules engine the multiplayer server runs. '
          : 'The host opens a table and shares the link. Everyone else plays from their phone, no install. ',
        h('button', { class: 'linkish', type: 'button', onclick: openRules }, 'How to play'), '.'),
    ));
}

export function renderInvite(app, code) {
  const seen = `hs:seen:${code}`;
  let meta = null;
  const body = h('div', { class: 'stack' }, h('p', { class: 'dim' }, 'Checking the table…'));
  fetch(`/api/rooms/${code}/meta`).then((r) => r.json().then((j) => ({ ok: r.ok, j }))).then(({ ok, j }) => {
    if (!ok) { body.replaceChildren(h('p', null, 'There’s no table with that code. Ask the host for a fresh link.'), h('a', { class: 'btn', href: '/' }, 'Back to the trail')); return; }
    meta = j;
    let flagged = false;
    try { flagged = sessionStorage.getItem(seen) === '1'; } catch { /* no storage */ }
    if (!flagged) { fetch(`/api/rooms/${code}/seen`, { method: 'POST' }).catch(() => {}); try { sessionStorage.setItem(seen, '1'); } catch { /* no storage */ } }
    if (j.phase !== 'lobby') { body.replaceChildren(h('p', null, 'This table already started. Ask the host to open a new one.'), h('a', { class: 'btn', href: '/' }, 'Back to the trail')); return; }
    body.replaceChildren(
      h('p', null, `${j.seats} ${j.seats === 1 ? 'person has' : 'people have'} taken a seat. Up to ${j.max} can play.`),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => { audio.unlock(); app.joinTable(code, null); } }, 'Take a seat'),
        h('button', {
          class: 'btn ghost', type: 'button',
          onclick: () => {
            fetch(`/api/rooms/${code}/left`, { method: 'POST' }).catch(() => {});
            body.replaceChildren(h('p', null, 'You left them on read. The host sees a count, never a name.'), h('a', { class: 'btn', href: '/' }, 'Back to the trail'));
          },
        }, 'Leave on read')));
  }).catch(() => body.replaceChildren(h('p', null, 'Couldn’t reach the table. Check your connection and reload.')));
  return h('div', null,
    h('header', { class: 'sky home-sky' },
      (() => { const c = h('canvas', { class: 'sun-canvas', 'aria-hidden': 'true' }); queueMicrotask(() => makeSky(c, { seed: 7, progress: () => 0.12, sunX: 0.74 })); return c; })(),
      h('h1', null, 'A table is forming'),
      h('p', { class: 'lede' }, `Room ${code}`)),
    h('main', { class: 'home-body' }, body));
}

export { skyBand };
