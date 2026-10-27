// The end of the road: the outcome, then every seat's secret, released at last.
import { h } from './dom.js';
import { RUBRIC } from '../engine/content.js';
import { makeSky } from './sky.js';
import { seatName, archName, emblemEl } from './common.js';
import { ladderEl, rubricEl } from './lobby.js';

const MARK = Object.fromEntries(RUBRIC.map((r) => [r.id, r.title]));

function revealCard(app, e) {
  const p = app.pub;
  const mine = e.id === (app.priv && app.priv.seat);
  const facts = [];
  facts.push(`${archName(e.archetype)}. ${e.spectrum} (truthfulness ${e.elo}).`);
  if (e.turned.length) {
    const when = e.turned.map((r) => `day ${r}`).join(' and ');
    if (e.caught && e.prodigal === 'confessed') facts.push(`Turned on ${when}. Named by the table, and confessed.`);
    else if (e.caught && e.prodigal === 'returned') facts.push(`Turned on ${when}. Named, kept silent, then came home.`);
    else if (e.caught) facts.push(`Turned on ${when}. Named by the table, and stayed silent.`);
    else if (e.redeemed) facts.push(`Turned on ${when}, and stepped forward before anyone named them.`);
    else facts.push(`Turned on ${when}. Nobody ever named them.`);
  } else facts.push('Never turned.');
  if (e.sacrifice) facts.push(e.sacrifice.valid ? `Day ${e.sacrifice.round}: an offering, and the road took it.` : `Day ${e.sacrifice.round}: an offering the road did not take, because ${e.sacrifice.why.join(', and ')}.`);
  if (e.founding) facts.push(`Founding pledge “${e.founding.text}” ${e.founding.kept ? 'kept' : 'broken'}.`);
  facts.push(`Words: ${e.words.kept} kept, ${e.words.broken} broken, ${e.words.claimsFalse} untrue.`);
  return h('article', { class: 'reveal' + (e.turned.length && !e.redeemed ? ' turned' : '') + (mine ? ' me' : '') },
    h('header', null,
      emblemEl(e.character),
      h('div', null, h('b', null, `${e.name}${mine ? ' (you)' : ''}`), h('div', { class: 'dim' }, e.bot ? 'bot' : e.human ? 'player' : '')),
      h('div', { class: `grade hue-${e.hue}` }, h('b', null, e.label), h('span', null, e.rating.toFixed(2)))),
    h('div', { class: 'lines' }, (mine ? e.matrix.you : e.matrix.they).map((l) => h('p', null, l))),
    h('div', { class: 'facts' }, facts.map((f) => h('p', null, f))),
    e.marks.length ? h('div', { class: 'marks' }, e.marks.map((m) => h('span', { class: 'mark' }, '✓ ', MARK[m] || m))) : null);
}

export function renderEnd(app) {
  const p = app.pub;
  const me = app.priv || {};
  const r = p.result;
  const ep = p.epilogue || [];
  const mine = ep.find((e) => e.id === me.seat);
  const won = r.winners.includes(me.seat);
  const canvas = h('canvas', { class: 'sun-canvas', 'aria-hidden': 'true' });
  queueMicrotask(() => makeSky(canvas, { seed: 2026, progress: () => (r.kind === 'lost' ? 0.2 : 1) }));
  const again = app.code === 'PRACTICE'
    ? h('button', { class: 'btn primary', type: 'button', onclick: () => app.practice({ ...p.config }) }, 'Play another practice game')
    : (me.host && !app.preview ? h('button', { class: 'btn primary', type: 'button', onclick: () => app.hostTable({ ...p.config }) }, 'Host a new table') : null);
  return h('div', null,
    h('header', { class: 'sky' }, canvas,
      h('div', { class: 'sky-top' }, h('span', { class: 'wordmark' }, 'Handshake'), h('span', { class: 'chip' }, `${p.round} days on the trail`)),
      h('div', { class: 'outcome' },
        h('h1', null, r.title),
        h('p', null, r.line),
        h('p', null, won ? 'You are among the winners.' : mine && mine.turned.length && !mine.redeemed && r.kind === 'lost' ? 'You won from the shadows.' : 'This road did not end your way.'))),
    h('main', { class: 'stack', style: { 'margin-top': '18px' } },
      mine ? h('section', { class: 'panel' },
        h('div', { class: 'row between' },
          h('div', null, h('h2', null, 'The game saw you'), h('p', { class: 'hint' }, `${mine.spectrum}. Grade ${mine.label}, ${mine.rating.toFixed(2)}.`)),
          h('div', { class: `grade hue-${mine.hue}`, style: { 'text-align': 'right' } }, h('b', { style: { 'font-family': 'var(--font-display)', 'font-size': '3.25rem', 'font-weight': 400, 'line-height': 1 } }, mine.label))),
        h('div', { class: 'reveal-lines' }, mine.matrix.you.map((l) => h('p', { style: { 'font-family': 'var(--font-display)', 'font-style': 'italic', 'font-size': '1.2rem' } }, l))),
        me.passport ? h('p', { class: 'hint' }, `Your builder marks are saved on this device: ${mine.marks.length ? mine.marks.map((m) => MARK[m]).join(', ') : 'none this time'}.`) : null) : null,
      h('div', { class: 'section-head' }, h('h2', null, 'Every seat, revealed'), h('span', { class: 'dim' }, `${ep.length} seats`)),
      h('div', { class: 'reveals' }, ep.map((e) => revealCard(app, e))),
      h('div', { class: 'grid-end' },
        h('section', { class: 'panel' }, h('h3', null, 'The rating ladder'), ladderEl(app, { highlight: mine && mine.label === 'X' ? 'X' : null })),
        h('section', { class: 'panel' }, h('h3', null, 'Builder marks'), rubricEl())),
      h('div', { class: 'row' }, again, h('button', { class: 'btn ghost', type: 'button', onclick: () => app.leave(true) }, 'Back to the trail'))));
}

export { seatName };
