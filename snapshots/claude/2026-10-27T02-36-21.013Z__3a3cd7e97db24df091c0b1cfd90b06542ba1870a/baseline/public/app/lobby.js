// The camp: invitations, seats filling with lanterns, and the host's table settings.
import { h, svg, store, toast } from './dom.js';
import { TIERS, PACES, LADDER, LIMITS } from '../engine/constants.js';
import { RUBRIC } from '../engine/content.js';
import { FLAME } from './art.js';
import { audio } from './audio.js';
import { makeSky } from './sky.js';
import { icon, stepper, pills } from './common.js';
import { openRules } from './sheets.js';

export function passportMarks() {
  const tok = store.get('hs:passport');
  if (!tok || typeof tok !== 'string') return [];
  try {
    const body = tok.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(atob(body + '==='.slice((body.length + 3) % 4)));
    return Array.isArray(j.m) ? j.m : [];
  } catch {
    return [];
  }
}

export function ladderEl(app, { highlight = null } = {}) {
  const eggs = new Set(app.ui.eggs || []);
  return h('div', { class: 'ladder' }, LADDER.map((l) => {
    if (l.sealed && !eggs.has('X') && highlight !== 'X') {
      return h('div', { class: 'rung sealed' }, h('b', null, '?'), h('span', null, 'Sealed. Discovered by searching, earned by a perfect road.'), h('span', { class: 'num' }, ''));
    }
    const note = l.sealed ? 'A perfect road ending in peace.' : l.bottom ? 'The true bottom, for a truly slippery road.' : l.floor ? 'Soft floor: honest play never drops below this.' : l.id === 'A' ? 'Everyone starts here.' : '';
    return h('div', { class: `rung hue-${l.hue}${l.id === 'A' ? ' start' : ''}` },
      h('b', null, l.label),
      h('span', null, note),
      h('span', { class: 'num dim' }, Number.isFinite(l.min) ? l.min.toFixed(2) : 'below 3.67'));
  }));
}

export function rubricEl() {
  const earned = new Set(passportMarks());
  const known = RUBRIC.filter((r) => !r.hidden || earned.has(r.id));
  const hidden = RUBRIC.length - known.length;
  return h('div', { class: 'rubric' },
    h('ul', null,
      known.map((r) => h('li', null, h('span', { 'aria-hidden': 'true' }, earned.has(r.id) ? '✓' : '○'), h('span', null, h('b', null, r.title), ` ${r.how}`))),
      hidden ? h('li', null, h('span', { 'aria-hidden': 'true' }, '…'), h('span', { class: 'q' }, `${hidden} more ${hidden === 1 ? 'mark is' : 'marks are'} learned by playing.`)) : null));
}

function flashlight(app, cfg) {
  if (!cfg.flashlight.on || !matchMedia('(pointer: fine)').matches) return null;
  const el = h('div', { class: 'flashlight', 'aria-hidden': 'true', style: { '--r': `${cfg.flashlight.radius}px` } });
  const move = (e) => { el.style.setProperty('--x', `${e.clientX}px`); el.style.setProperty('--y', `${e.clientY}px`); };
  window.addEventListener('pointermove', move, { passive: true });
  const stop = new MutationObserver(() => { if (!el.isConnected) { window.removeEventListener('pointermove', move); stop.disconnect(); } });
  queueMicrotask(() => stop.observe(document.body, { childList: true, subtree: true }));
  return el;
}

export function renderLobby(app) {
  const p = app.pub;
  const me = app.priv;
  const isHost = me && me.host;
  const cfg = p.config;
  const humans = p.seats.filter((s) => s.human);
  const glowCls = 'glow-gate' + (app.ui.glow ? ' on' : '');

  const lightIt = () => {
    audio.unlock();
    if (!audio.muted) audio.music(true);
    setTimeout(() => { app.ui.glow = true; app.rerender(); }, audio.muted ? 0 : 1600);
  };

  const canvas = h('canvas', { class: 'sun-canvas', 'aria-hidden': 'true' });
  queueMicrotask(() => makeSky(canvas, { seed: 33, clock: () => app.serverNow(), progress: () => 0.04 }));

  const lanterns = [];
  const total = Math.max(cfg.seats, humans.length);
  for (let i = 0; i < total; i++) {
    const s = humans[i];
    if (s) {
      lanterns.push(h('div', { class: 'lantern lit' },
        svg(FLAME, 'flame'),
        h('span', null, s.id === p.host ? 'Host' : s.id === me.seat ? 'You' : 'Joined'),
        s.marks ? h('span', { class: 'dim', title: 'Builder marks earned on that device' }, '✓'.repeat(Math.min(4, s.marks))) : null));
    } else {
      lanterns.push(h('div', { class: 'lantern' + (cfg.fillBots ? ' bot' : '') }, svg(FLAME, 'flame'), h('span', null, cfg.fillBots ? 'Stand-in' : 'Open seat')));
    }
  }

  const inviteUrl = `${location.origin}/r/${p.code}`;
  const invite = app.code === 'PRACTICE' ? null : h('section', { class: 'panel' },
    h('h3', null, 'Invite the table'),
    h('p', { class: 'hint' }, 'Send this link. People can take a seat or leave you on read.'),
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
      ? h('p', { class: 'hint', style: { color: '#ffd2a1' } }, 'Phones can\u2019t open a localhost link. Open this page from your Wi-Fi address (the server prints it) and copy the link from there.')
      : null,
    h('div', { class: 'invite-link' },
      h('input', { id: 'invite-url', type: 'text', readonly: true, value: inviteUrl, 'aria-label': 'Invite link', onclick: (e) => e.target.select() }),
      h('button', {
        class: 'btn', type: 'button',
        onclick: (e) => {
          const done = () => toast('Link copied.');
          if (navigator.clipboard) navigator.clipboard.writeText(inviteUrl).then(done, () => document.getElementById('invite-url').select());
          else document.getElementById('invite-url').select();
          e.currentTarget.blur();
        },
      }, 'Copy')),
    h('div', { class: 'stats3' },
      h('div', { class: 'stat' }, h('b', null, String(p.invites.read)), h('span', null, 'opened it')),
      h('div', { class: 'stat' }, h('b', null, String(p.invites.accepted)), h('span', null, 'took a seat')),
      h('div', { class: 'stat' }, h('b', null, String(p.invites.leftOnRead)), h('span', null, 'left on read'))));

  const setCfg = (patch) => {
    const next = { ...cfg, ...patch };
    store.set('hs:config', { tier: next.tier, seats: next.seats, pace: next.pace, fillBots: next.fillBots, tableTalk: next.tableTalk, flashlight: next.flashlight });
    app.send({ k: 'config', config: patch });
  };

  const hostPanel = isHost ? h('section', { class: 'panel' },
    h('h3', null, 'Set the table'),
    h('div', { class: 'field' }, h('span', null, 'Level of play'),
      h('div', { class: 'tiers', role: 'group', 'aria-label': 'Level of play' }, TIERS.map((t) => h('button', {
        type: 'button', class: 'tier', 'aria-pressed': String(cfg.tier === t.id), onclick: () => setCfg({ tier: t.id }),
      }, h('b', { class: 'dupr' }, t.dupr), h('span', null, h('b', null, t.name), h('small', null, t.note)))))),
    h('div', { class: 'row between' },
      h('div', { class: 'field' }, h('span', null, 'Seats'), stepper('seats', cfg.seats, LIMITS.minSeats, LIMITS.maxSeats, (v) => setCfg({ seats: v }), 'seats')),
      h('div', { class: 'field' }, h('span', null, 'Pace'), pills(
        Object.entries(PACES).filter(([, v]) => !v.dev || cfg.pace === 'blitz' || p.config.pace === 'blitz').map(([k, v]) => ({ value: k, label: `${v.label} ${v.minutes}` })),
        cfg.pace, (v) => setCfg({ pace: v }), { label: 'Pace' }))),
    h('label', { class: 'toggle', for: 'fill-bots' }, h('span', null, 'Fill empty seats with stand-ins'), h('input', { id: 'fill-bots', type: 'checkbox', checked: cfg.fillBots, onchange: (e) => setCfg({ fillBots: e.target.checked }) })),
    h('label', { class: 'toggle', for: 'table-talk' }, h('span', null, 'Table talk'), h('input', { id: 'table-talk', type: 'checkbox', checked: cfg.tableTalk, onchange: (e) => setCfg({ tableTalk: e.target.checked }) })),
    h('label', { class: 'toggle', for: 'flash-on' }, h('span', null, 'Flashlight cursor on desktop'), h('input', { id: 'flash-on', type: 'checkbox', checked: cfg.flashlight.on, onchange: (e) => setCfg({ flashlight: { ...cfg.flashlight, on: e.target.checked } }) })),
    cfg.flashlight.on ? h('label', { class: 'field', for: 'flash-r' }, h('span', null, `Flashlight radius: ${cfg.flashlight.radius}px`),
      h('input', { id: 'flash-r', type: 'range', min: 60, max: 320, step: 10, value: cfg.flashlight.radius, onchange: (e) => setCfg({ flashlight: { ...cfg.flashlight, radius: Number(e.target.value) } }) })) : null,
    h('button', {
      class: 'btn primary wide', type: 'button',
      disabled: !cfg.fillBots && humans.length < LIMITS.minSeats,
      onclick: () => { audio.unlock(); app.send({ k: 'start' }); },
    }, cfg.fillBots ? `Start with ${humans.length} ${humans.length === 1 ? 'person' : 'people'}` : 'Start'),
    !cfg.fillBots && humans.length < LIMITS.minSeats ? h('p', { class: 'hint' }, `A table needs ${LIMITS.minSeats}. Turn on stand-ins or wait for more people.`) : null,
  ) : h('section', { class: 'panel' },
    h('h3', null, 'The host is setting the table'),
    h('p', { class: 'hint' }, `Level ${p.tier.dupr} (${p.tier.name}), ${PACES[cfg.pace] ? PACES[cfg.pace].label.toLowerCase() : ''} pace, ${cfg.seats} seats.`));

  return h('div', null,
    flashlight(app, cfg),
    h('header', { class: 'sky' }, canvas,
      h('div', { class: 'sky-top' },
        h('span', { class: 'wordmark' }, 'Handshake'),
        h('div', { class: 'row' },
          h('button', { class: 'btn small ghost', type: 'button', onclick: openRules }, 'Rules'),
          h('button', { class: 'btn small ghost', type: 'button', 'aria-label': audio.muted ? 'Sound on' : 'Sound off', onclick: () => { audio.unlock(); audio.setMuted(!audio.muted); if (!audio.muted && app.ui.glow) audio.music(true); else audio.music(false); app.rerender(); } }, icon(audio.muted ? 'mute' : 'sound')))),
      h('div', { class: 'sky-title' },
        h('h1', null, app.code === 'PRACTICE' ? 'A practice camp' : 'The camp at Independence'),
        h('p', null, app.code === 'PRACTICE' ? 'Bots will fill every other seat.' : `Room ${p.code}`))),
    app.ui.glow ? null : h('section', { class: 'panel', style: { 'margin-top': '18px' } },
      h('p', null, 'The camp is dark. Light your lantern to join the circle.'),
      h('button', { class: 'btn primary', type: 'button', onclick: lightIt }, 'Light the lantern')),
    h('div', { class: 'lobby ' + glowCls },
      h('div', { class: 'stack' },
        h('section', { class: 'panel' },
          h('div', { class: 'section-head' }, h('h2', null, 'Around the fire'), h('span', { class: 'dim' }, `${humans.length} of ${total}`)),
          h('div', { class: 'lanterns' }, lanterns)),
        invite),
      h('div', { class: 'stack' },
        hostPanel,
        h('section', { class: 'panel' }, h('h3', null, 'The rating ladder'), h('p', { class: 'hint' }, 'Grades come out at the end, to the hundredth.'), ladderEl(app)),
        h('section', { class: 'panel' }, h('h3', null, 'Builder marks'), h('p', { class: 'hint' }, 'Checkmarks for demonstrated purpose. They stay on this device.'), rubricEl()))));
}
