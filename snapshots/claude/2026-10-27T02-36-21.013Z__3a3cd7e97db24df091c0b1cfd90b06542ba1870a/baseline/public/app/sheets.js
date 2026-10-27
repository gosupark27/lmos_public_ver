// Sheets: rules, one seat up close, and the 66-event canon.
import { h, svg } from './dom.js';
import { ARCHETYPES, PRESENCE_LEVELS } from '../engine/constants.js';
import { CANON, WORDS, FOUNDING } from '../engine/content.js';
import { RULES, LEVERS, ACTIONS, sacrificeLabel } from './text.js';
import { CAPYBARA } from './art.js';
import { seatName, SeatName, archName, emblemEl, charOf } from './common.js';

export function openSheet(title, ...body) {
  const prev = document.activeElement;
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); if (prev && prev.focus) prev.focus(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    h('button', { class: 'btn small ghost close', type: 'button', onclick: () => close() }, 'Close'),
    h('h2', null, title),
    ...body);
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } }, sheet);
  document.body.appendChild(back);
  document.addEventListener('keydown', esc);
  sheet.focus();
  return close;
}

export function openRules() {
  openSheet('How to play',
    ...RULES.map(([t, p]) => h('div', null, h('h3', null, t), h('p', null, p))),
    h('h3', null, 'The seven capybaras'),
    h('p', null, 'Seven levers shape what you can do. The first six can be pulled. The seventh cannot be touched.'),
    h('ul', { class: 'capy-list' }, LEVERS.map(([n, d]) => h('li', null, svg(CAPYBARA), h('span', null, h('b', null, n), `. ${d}`)))));
}

export function openCanon() {
  openSheet('The canon',
    h('p', null, 'Sixty-six events, one for each book. Nine load into every room, three per act. Fifty-seven are parked.'),
    h('ul', null, CANON.map((c) => h('li', null, h('b', null, `${c.book}: ${c.title}. `), c.line, c.status === 'loaded' ? h('span', { class: 'badge ok', style: { 'margin-left': '6px' } }, 'loaded') : null))));
}

const QUICK = ['accuse', 'vouch', 'give', 'peek', 'witness', 'callin', 'boundary', 'sacrifice'];

export function openSeat(app, id) {
  const p = app.pub;
  const me = app.priv || {};
  const s = p.seats.find((x) => x.id === id);
  if (!s) return;
  const ch = charOf(s);
  const A = ARCHETYPES[s.archetype];
  const facts = [];
  facts.push(`${archName(s.archetype)}: ${A ? A.gives.toLowerCase() : ''}.`);
  facts.push(`Lantern: ${PRESENCE_LEVELS[s.presence] ? PRESENCE_LEVELS[s.presence].name : ''}. Wagon: ${s.weight}.`);
  if (p.lead === s.id) facts.push('Leads the train.');
  if (s.silence) facts.push('Holding silence this act.');
  if (s.outside) facts.push('Outside the line today.');
  if (s.sacrificed) facts.push('Has made an offering.');
  if (s.caught) facts.push(s.redeemed ? 'Was named, and came home.' : 'Was named, and sits in the prodigal seat.');
  else if (s.redeemed) facts.push('Stepped forward, and came home.');
  if (s.standIn) facts.push('A stand-in is playing this seat.');
  if (s.founding) facts.push(`Founding pledge: “${FOUNDING[s.founding.kind].say}”`);
  if (s.last && s.last.kind !== 'private') {
    const t = s.last.target != null ? ` ${seatName(p, s.last.target)}` : '';
    facts.push(`Last deed: ${(ACTIONS[s.last.kind] ? ACTIONS[s.last.kind].label || 'an offering' : s.last.kind).toLowerCase()}${t}.`);
  } else if (s.last) facts.push('Last deed: kept to themselves.');
  const said = p.words.filter((w) => w.seat === id && w.round === p.round && !w.founding)
    .map((w) => h('li', null, `“${WORDS[w.kind] ? WORDS[w.kind].say(w, (x) => seatName(p, x)) : w.kind}”`));

  const quick = [];
  const L = me.legal || {};
  if (id !== me.seat && p.phase === 'act' && L.actions) {
    for (const kind of QUICK) {
      const a = L.actions.find((x) => x.kind === kind && x.targets && x.targets.includes(id));
      if (!a) continue;
      const label = kind === 'sacrifice' ? sacrificeLabel(a.archetype) : ACTIONS[kind].label;
      quick.push(h('button', {
        class: 'btn small', type: 'button',
        onclick: () => {
          app.ui.act = { kind, target: id, res: a.res ? a.res[0] : undefined, n: 1 };
          close();
          app.rerender();
          const now = document.getElementById('now');
          if (now) now.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      }, label));
    }
  }
  if (id !== me.seat && p.phase === 'talk' && L.canTrade && L.tradeTargets && L.tradeTargets.includes(id)) {
    quick.push(h('button', {
      class: 'btn small', type: 'button',
      onclick: () => { app.ui.trade = { to: id, give: {}, get: {} }; close(); app.rerender(); const now = document.getElementById('now'); if (now) now.scrollIntoView({ behavior: 'smooth' }); },
    }, 'Offer a trade'));
  }
  const close = openSheet(ch ? `${ch.name}${id === me.seat ? ' (you)' : ''}` : `Seat ${id + 1}`,
    h('div', { class: 'row' }, emblemEl(s.character, 'hand-emblem'), h('p', { class: 'hint' }, ch ? ch.garb : '')),
    h('ul', null, facts.map((f) => h('li', null, f))),
    said.length ? h('div', null, h('h3', null, 'Said today'), h('ul', null, said)) : null,
    quick.length ? h('div', null, h('h3', null, 'Do something about them'), h('div', { class: 'row' }, quick)) : null);
}

export { SeatName };
