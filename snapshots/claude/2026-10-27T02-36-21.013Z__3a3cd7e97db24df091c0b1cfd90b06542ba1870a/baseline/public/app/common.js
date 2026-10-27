// Shared bits for the screens.
import { CHARACTERS } from '../engine/content.js';
import { ARCHETYPES, RES } from '../engine/constants.js';
import { h, svg } from './dom.js';
import { EMBLEMS, RES_ICON, ICON } from './art.js';

export function charOf(seat) {
  return seat ? CHARACTERS.find((c) => c.id === seat.character) : null;
}

export function seatName(pub, id, { the = true } = {}) {
  const s = pub && pub.seats ? pub.seats.find((x) => x.id === id) : null;
  const c = charOf(s);
  if (!c) return `Seat ${id + 1}`;
  return the ? `the ${c.name}` : c.name;
}

export function SeatName(pub, id) {
  const n = seatName(pub, id);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export function archName(a) {
  return ARCHETYPES[a] ? ARCHETYPES[a].name : '';
}

export function emblemEl(characterId, cls) {
  return svg(EMBLEMS[characterId] || EMBLEMS.surveyor, cls);
}

export function icon(name, cls) {
  return svg(ICON[name] || ICON.still, cls);
}

export function resIcon(r, cls) {
  return svg(RES_ICON[r], cls);
}

export function resText(bag) {
  const parts = RES.filter((r) => bag && bag[r] > 0).map((r) => `${bag[r]} ${r}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

export function stepper(id, value, min, max, onChange, label) {
  const out = h('output', { id: id + '-out', 'aria-live': 'polite' }, String(value));
  const dec = h('button', { type: 'button', 'aria-label': `Less ${label || ''}`.trim(), onclick: () => onChange(Math.max(min, value - 1)) }, '−');
  const inc = h('button', { type: 'button', 'aria-label': `More ${label || ''}`.trim(), onclick: () => onChange(Math.min(max, value + 1)) }, '+');
  return h('span', { class: 'stepper', id }, dec, out, inc);
}

export function pills(options, selected, onPick, { label } = {}) {
  return h('div', { class: 'pills', role: 'group', 'aria-label': label || null },
    options.map((o) => h('button', {
      type: 'button', class: 'pill', 'aria-pressed': String(o.value === selected),
      onclick: () => onPick(o.value),
    }, o.label)));
}

export function fmtTime(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}`;
}
