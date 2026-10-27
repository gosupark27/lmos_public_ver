// The table: sky band, what to do now, your hand, the seats, the crossing, talk, and the diary.
import { h, swap, svg, toast } from './dom.js';
import { RES, PRESENCE_LEVELS, PACES } from '../engine/constants.js';
import { WORDS, FOUNDING, CHARACTERS, scenarioForRound } from '../engine/content.js';
import { makeSky } from './sky.js';
import { ICON } from './art.js';
import { audio } from './audio.js';
import {
  PHASE_NAME, PHASE_HINT, ACTIONS, GROUPS, sacrificeLabel, sacrificeHelp, WORD_LABEL, FOUNDING_LABEL,
} from './text.js';
import { seatName, SeatName, archName, emblemEl, icon, resIcon, resText, stepper, pills, fmtTime, charOf } from './common.js';
import { openRules, openSeat } from './sheets.js';

const PHASE_ORDER = { talk: 0, act: 1, reveal: 2, vote: 3, prodigal: 3, crossing: 4, sunrise: 0, silence: 0, frozen: 4 };

function dayProgress(p, now) {
  if (!p || !p.round) return 0.06;
  const idx = PHASE_ORDER[p.phase] ?? 0;
  let frac = 0;
  if (p.endsAt && p.startedAt) frac = Math.max(0, Math.min(1, (now - p.startedAt) / Math.max(1, p.endsAt - p.startedAt)));
  return Math.min(1, ((p.round - 1) + (idx + frac) / 5) / 9) * 0.92 + 0.06;
}

function hashCode(s) {
  let x = 7;
  for (const ch of String(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x;
}

export function mountTable(app) {
  const E = (app.els = {});
  E.canvas = h('canvas', { class: 'sun-canvas', 'aria-hidden': 'true' });
  E.timer = h('span', { class: 'timer', role: 'timer', 'aria-live': 'off' });
  E.net = h('span', { class: 'netline' });
  E.day = h('span', { class: 'wordmark' });
  E.title = h('div', { class: 'sky-title' });
  E.meta = h('div', { class: 'sky-meta' });
  E.sound = h('button', { class: 'btn small ghost', type: 'button' });
  E.sound.addEventListener('click', () => { audio.unlock(); audio.setMuted(!audio.muted); paintSound(); });
  const paintSound = () => { E.sound.replaceChildren(svg(audio.muted ? ICON.mute : ICON.sound)); E.sound.setAttribute('aria-label', audio.muted ? 'Sound on' : 'Sound off'); };
  paintSound();
  E.sky = h('header', { class: 'sky' }, E.canvas,
    h('div', { class: 'sky-top' }, E.day, h('div', { class: 'row' }, E.net,
      h('button', { class: 'btn small ghost', type: 'button', onclick: openRules }, 'Rules'), E.sound, E.timer)),
    E.title, E.meta);

  E.phase = h('section', { class: 'panel', id: 'now', 'aria-live': 'polite' });
  E.hand = h('section', { class: 'panel hand' });
  E.seats = h('section', { class: 'panel seats-panel' });
  E.cache = h('section', { class: 'panel cache' });
  E.chatLog = h('div', { class: 'chat', role: 'log', 'aria-label': 'Table talk' });
  E.chatInput = h('input', { id: 'chat-input', type: 'text', maxlength: 140, autocomplete: 'off', placeholder: 'Say something to the table' });
  E.chatForm = h('form', { class: 'chat-form' }, E.chatInput, h('button', { class: 'btn', type: 'submit' }, 'Send'));
  E.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = E.chatInput.value.trim();
    if (!text) return;
    app.send({ k: 'talk', text }).then((ack) => { if (ack.ok) E.chatInput.value = ''; });
  });
  E.chatNote = h('p', { class: 'hint' });
  E.chat = h('section', { class: 'panel' }, h('h3', null, 'Table talk'), E.chatNote, E.chatLog, E.chatForm);
  E.diaryList = h('div', { class: 'diary-entries' });
  E.seal = h('p', { class: 'seal' });
  E.diary = h('section', { class: 'diary', 'aria-label': 'Trail diary' }, h('h2', null, 'The trail diary'), E.diaryList, E.seal);

  E.board = h('div', { class: 'board', 'data-tab': app.ui.tab || 'table' },
    h('div', { class: 'stack main-col' }, E.phase, E.hand, E.seats, E.cache, E.chat),
    h('div', { class: 'diary-col' }, E.diary));
  const tab = (id, label) => h('button', {
    type: 'button', 'aria-pressed': String((app.ui.tab || 'table') === id),
    onclick: (e) => {
      app.ui.tab = id;
      E.board.dataset.tab = id;
      for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
    },
  }, label);
  E.tabs = h('nav', { class: 'tabs', 'aria-label': 'View' }, tab('table', 'Table'), tab('diary', 'Diary'));

  const sky = makeSky(E.canvas, {
    seed: hashCode(app.code),
    clock: () => app.serverNow(),
    progress: () => dayProgress(app.pub, app.serverNow()),
    fracture: () => (app.pub && app.pub.phase === 'sunrise' && app.pub.era ? app.pub.era : null),
  });
  const tick = setInterval(() => {
    const p = app.pub;
    if (!p) return;
    const left = p.endsAt ? p.endsAt - app.serverNow() : null;
    E.timer.textContent = left != null ? fmtTime(left) : '';
    E.timer.classList.toggle('low', left != null && left < 6000);
  }, 250);
  app.cleanup.push(() => clearInterval(tick), () => sky.destroy());
  return h('div', null, E.sky, E.tabs, E.board);
}

export function updateTable(app) {
  const E = app.els;
  const p = app.pub;
  if (!E || !p) return;
  const me = app.priv || {};
  const sc = p.scenario || scenarioForRound(p.round);

  // Sky band
  E.day.textContent = p.round ? `Day ${p.round} of 9` : 'Handshake';
  const triad = sc ? { beginner: 'Act I', intermediate: 'Act II', advanced: 'Act III' }[sc.triad] : '';
  swap(E.title,
    h('h1', null, sc ? sc.title : PHASE_NAME[p.phase]),
    h('p', null, sc ? `${sc.line} (${sc.book})` : ''));
  const chips = [
    h('span', { class: 'chip' + (p.weather.band === 'hot' ? ' hot' : p.weather.band === 'boiling' ? ' storm' : '') }, svg(ICON.heat), p.weather.name),
    h('span', { class: 'chip', title: 'Wagons left' }, h('span', { class: 'wagons', 'aria-label': `${p.health} of ${p.healthMax} wagons` },
      Array.from({ length: p.healthMax }, (_, i) => svg(ICON.wagon, i < p.health ? '' : 'lost')))),
    triad ? h('span', { class: 'chip' }, `${triad}, ${PHASE_NAME[p.phase]}`) : h('span', { class: 'chip' }, PHASE_NAME[p.phase]),
    p.era ? h('span', { class: `chip era-${p.era}` }, p.era === '1775' ? '1775' : 'Rome') : null,
    p.outbreaks ? h('span', { class: 'chip storm' }, `${p.outbreaks} turned so far`) : null,
  ];
  swap(E.meta, chips);
  E.sky.classList.toggle('desync', !!me.desync);
  if (me.desync && !E.sky.querySelector('.seen-flash')) {
    E.sky.appendChild(h('span', { class: 'seen-flash' }, 'Seen.'));
  } else if (!me.desync) {
    const f = E.sky.querySelector('.seen-flash');
    if (f) f.remove();
  }
  E.net.className = 'netline' + (app.status === 'open' ? '' : ' off');
  swap(E.net, h('i'), app.code === 'PRACTICE' ? 'Practice' : app.status === 'open' ? 'Live' : 'Reconnecting');

  swap(E.phase, ...phasePanel(app));
  swap(E.hand, ...handPanel(app));
  swap(E.seats, ...seatsPanel(app));
  swap(E.cache, ...cachePanel(app));
  paintChat(app);
  paintDiary(app);
}

// ---------- the phase panel ----------

function phasePanel(app) {
  const p = app.pub;
  const head = (title, hint) => h('div', { class: 'section-head' }, h('h2', null, title), hint ? h('span', { class: 'dim' }, hint) : null);
  switch (p.phase) {
    case 'sunrise': return [head('Sunrise'), h('p', null, p.round === 0 ? 'The train is forming. Your character is dealt.' : 'A new act begins.')];
    case 'silence': return [head('Be still'), h('p', null, 'Before anyone speaks, a moment of silence. Look at who you’re riding with.')];
    case 'talk': return talkPanel(app, head);
    case 'act': return actPanel(app, head);
    case 'reveal': return revealPanel(app, head);
    case 'vote': return votePanel(app, head);
    case 'prodigal': return prodigalPanel(app, head);
    case 'crossing': return crossingPanel(app, head);
    case 'frozen': return [head('Peace'), h('p', null, 'The table is frozen. Listen for the bell.')];
    default: return [head(PHASE_NAME[p.phase] || p.phase)];
  }
}

function wordText(p, w) {
  const name = (id) => seatName(p, id);
  if (w.founding) return FOUNDING[w.kind] ? FOUNDING[w.kind].say : w.kind;
  return WORDS[w.kind] ? WORDS[w.kind].say(w, name) : w.kind;
}

function wordsList(app) {
  const p = app.pub;
  const words = p.words.filter((w) => w.round === p.round && !w.founding);
  if (!words.length) return h('p', { class: 'hint' }, 'Nobody has said anything yet.');
  return h('div', { class: 'words' }, words.map((w) => h('div', { class: 'word' },
    svg(WORDS[w.kind] && WORDS[w.kind].family === 'claim' ? ICON.claim : ICON.word),
    h('span', null, h('span', { class: 'who' }, SeatName(app.pub, w.seat)), `“${wordText(p, w)}”`))));
}

function talkPanel(app, head) {
  const p = app.pub;
  const me = app.priv;
  const L = me.legal || {};
  const out = [head('Talk', PHASE_HINT.talk)];
  if (p.scenario) out.push(h('p', { class: 'hint' }, p.scenario.rule));
  const meSeat = p.seats.find((s) => s.id === me.seat);

  if (L.words && L.words.founding) {
    out.push(h('div', { class: 'picker' },
      h('b', null, 'Your founding pledge'),
      h('p', { class: 'hint' }, 'It lasts the whole road and does not count toward today’s two.'),
      h('div', { class: 'choices' }, L.words.founding.map((k) => h('button', {
        type: 'button', class: 'choice',
        onclick: () => app.send({ k: 'founding', kind: k }),
      }, svg(ICON.word), h('span', null, h('b', null, FOUNDING_LABEL[k])))))));
  } else if (meSeat && meSeat.founding) {
    out.push(h('p', { class: 'hint' }, `Your founding pledge: “${FOUNDING_LABEL[meSeat.founding.kind]}”`));
  }

  out.push(h('h3', null, 'Said today'), wordsList(app));
  if (L.words) out.push(wordBuilder(app, L));
  out.push(tradeBlock(app, L));
  if (me.silence && me.silence.holding) out.push(h('p', { class: 'hint' }, 'You’re holding silence this act. Saying anything, trading, or talking breaks it, and breaking it costs you.'));
  else if (L.canHoldSilence) out.push(h('button', { class: 'btn ghost', type: 'button', onclick: () => app.send({ k: 'silence' }) }, svg(ICON.hush), 'Hold silence for this act'));
  const ready = meSeat && meSeat.ready;
  out.push(h('button', { class: 'btn primary wide', type: 'button', disabled: ready, onclick: () => app.send({ k: 'ready' }) }, ready ? 'Ready. Waiting for the table' : 'Ready'));
  return out;
}

function wordBuilder(app, L) {
  const p = app.pub;
  const me = app.priv;
  const left = L.words.left;
  const box = h('div', { class: 'picker' });
  if (left <= 0) {
    box.append(h('p', { class: 'hint' }, 'You’ve said your two things today. The game will check them against what you do.'));
    return box;
  }
  const w = app.ui.word || (app.ui.word = { kind: null, res: null, n: 1, target: null, yes: true });
  const kinds = L.words.kinds.map((k) => k.kind);
  box.append(h('div', { class: 'row between' }, h('b', null, 'Say something'), h('span', { class: 'hint' }, `${left} of 2 left`)));
  box.append(pills(kinds.map((k) => ({ value: k, label: WORD_LABEL[k] })), w.kind, (k) => {
    const K = L.words.kinds.find((x) => x.kind === k);
    app.ui.word = { kind: k, res: K.res ? K.res[0] : null, n: 1, target: K.targets ? K.targets[0] ?? null : null, yes: true };
    app.rerender();
  }, { label: 'What to say' }));
  if (w.kind) {
    const K = L.words.kinds.find((x) => x.kind === w.kind);
    const set = (patch) => { Object.assign(w, patch); app.rerender(); };
    if (K && K.targets) box.append(pills(K.targets.map((id) => ({ value: id, label: seatName(p, id, { the: false }) })), w.target, (id) => set({ target: id }), { label: 'Who' }));
    if (K && K.res) box.append(pills(K.res.map((r) => ({ value: r, label: r })), w.res, (r) => set({ res: r }), { label: 'Which supply' }));
    if (['contribute', 'give', 'holding', 'need'].includes(w.kind)) {
      const max = w.kind === 'need' ? 40 : w.kind === 'holding' ? 30 : 12;
      const min = w.kind === 'holding' || w.kind === 'need' ? 0 : 1;
      box.append(h('div', { class: 'row' }, h('span', { class: 'hint' }, 'How many'), stepper('word-n', w.n, min, max, (v) => set({ n: v }), 'amount')));
    }
    if (w.kind === 'vote') box.append(pills([{ value: true, label: 'Yes, name them' }, { value: false, label: 'No' }], w.yes, (v) => set({ yes: v }), { label: 'Your vote' }));
    const preview = WORDS[w.kind] ? WORDS[w.kind].say({ ...w }, (id) => seatName(p, id)) : '';
    box.append(h('p', { style: { 'font-family': 'var(--font-display)', 'font-size': '1.15rem' } }, `“${preview}”`));
    if (w.kind === 'sacrifice') box.append(h('p', { class: 'hint' }, 'Some offerings are not accepted if they are announced first.'));
    if (me.silence && me.silence.holding) box.append(h('p', { class: 'hint' }, 'Saying this breaks your silence.'));
    box.append(h('button', {
      class: 'btn', type: 'button',
      onclick: () => {
        const msg = { k: 'word', kind: w.kind };
        if (w.target != null && K.targets) msg.target = w.target;
        if (w.res && K.res) msg.res = w.res;
        if (['contribute', 'give', 'holding', 'need'].includes(w.kind)) msg.n = w.n;
        if (w.kind === 'vote') msg.yes = !!w.yes;
        app.send(msg).then((ack) => { if (ack.ok) { app.ui.word = null; app.rerender(); } });
      },
    }, 'Say it'));
  }
  return box;
}

function tradeBlock(app, L) {
  const p = app.pub;
  const me = app.priv;
  const box = h('div', { class: 'picker' }, h('b', null, 'Trade'));
  for (const o of me.offersIn || []) {
    box.append(h('div', { class: 'row between' },
      h('span', null, `${SeatName(p, o.from)} offers ${resText(o.give)} for your ${resText(o.get)}.`),
      h('span', { class: 'row' },
        h('button', { class: 'btn small primary', type: 'button', onclick: () => app.send({ k: 'accept', offer: o.id }) }, 'Accept'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => app.send({ k: 'decline', offer: o.id }) }, 'Decline'))));
  }
  for (const o of me.offersOut || []) {
    box.append(h('div', { class: 'row between' },
      h('span', { class: 'dim' }, `You offered ${seatName(p, o.to)} ${resText(o.give)} for ${resText(o.get)}.`),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => app.send({ k: 'cancel', offer: o.id }) }, 'Withdraw')));
  }
  if (!L.canTrade) { box.append(h('p', { class: 'hint' }, 'You’re outside the line today and can’t trade.')); return box; }
  const t = app.ui.trade || (app.ui.trade = { to: null, give: {}, get: {} });
  const set = () => app.rerender();
  box.append(pills(L.tradeTargets.map((id) => ({ value: id, label: seatName(p, id, { the: false }) })), t.to, (id) => { t.to = id; set(); }, { label: 'Trade with' }));
  if (t.to != null) {
    const line = (side, label) => h('div', { class: 'row' }, h('span', { class: 'hint', style: { 'min-width': '4.5em' } }, label),
      RES.map((r) => h('span', { class: 'row' }, resIcon(r, 'sr-icon'), h('span', { class: 'hint' }, r),
        stepper(`${side}-${r}`, t[side][r] || 0, 0, side === 'give' ? me.res[r] || 0 : 12, (v) => { t[side][r] = v; set(); }, `${r} to ${side}`))));
    box.append(line('give', 'You give'), line('get', 'You get'));
    const clean = (bag) => Object.fromEntries(Object.entries(bag).filter(([, v]) => v > 0));
    const ok = Object.keys(clean(t.give)).length && Object.keys(clean(t.get)).length;
    if (L.tradeTax) box.append(h('p', { class: 'hint' }, 'Dust storm: trading costs you 1 water.'));
    box.append(h('button', {
      class: 'btn', type: 'button', disabled: !ok,
      onclick: () => app.send({ k: 'offer', to: t.to, give: clean(t.give), get: clean(t.get) }).then((ack) => { if (ack.ok) { app.ui.trade = null; toast('Offer sent.'); app.rerender(); } }),
    }, `Offer to ${seatName(p, t.to)}`));
  }
  return box;
}

function describeAction(p, a) {
  if (!a) return '';
  const who = a.target != null ? seatName(p, a.target) : '';
  switch (a.kind) {
    case 'contribute': return `Put ${a.n} ${a.res} into the cache.`;
    case 'give': return `Give ${a.n} ${a.res} to ${who}.`;
    case 'forage': return `Forage for ${a.res}.`;
    case 'accuse': return `Call ${who} to account.`;
    case 'vouch': return `Vouch for ${who}.`;
    case 'boundary': return `Put ${who} outside the line.`;
    case 'peek': return `Read ${who}’s mail.`;
    case 'callin': return `Call in a debt from ${who} (${a.res}).`;
    case 'witness': return `Watch ${who}.`;
    case 'sacrifice': return a.target != null ? `Lay the crown on ${who}.` : 'Make your offering.';
    case 'spoil': return `Take ${a.res || 'supplies'} from the cache.`;
    default: return ACTIONS[a.kind] ? ACTIONS[a.kind].label + '.' : a.kind;
  }
}

function actPanel(app, head) {
  const p = app.pub;
  const me = app.priv;
  const L = me.legal || {};
  const out = [head('Act', PHASE_HINT.act)];
  if (p.scenario) out.push(h('p', { class: 'hint' }, p.scenario.rule));
  if (me.action) out.push(h('div', { class: 'chosen' }, h('b', null, 'Your choice: '), describeAction(p, me.action), h('span', { class: 'hint' }, ' You can still change it.')));
  const actions = L.actions || [];
  const sel = app.ui.act;
  for (const g of GROUPS) {
    const items = actions.filter((a) => (ACTIONS[a.kind] || {}).group === g.id);
    if (!items.length) continue;
    const group = h('div', { class: 'choice-group' }, h('h4', null, g.label));
    for (const a of items) {
      const T = ACTIONS[a.kind];
      const label = a.kind === 'sacrifice' ? sacrificeLabel(a.archetype) : T.label;
      const help = a.kind === 'sacrifice' ? sacrificeHelp(a.archetype) : typeof T.help === 'function' ? T.help(a) : T.help;
      const pressed = sel && sel.kind === a.kind;
      group.append(h('button', {
        type: 'button', class: 'choice' + (g.id === 'turned' ? ' turned' : g.id === 'calling' ? ' calling' : ''), 'aria-pressed': String(!!pressed),
        onclick: () => {
          app.ui.act = { kind: a.kind, target: a.targets ? a.targets[0] : undefined, res: a.res ? a.res[0] : undefined, n: 1 };
          if (a.kind === 'contribute') {
            const best = a.res.slice().sort((x, y) => (p.crossing && p.crossing.gauges[y] ? p.crossing.gauges[y].level : 0) - (p.crossing && p.crossing.gauges[x] ? p.crossing.gauges[x].level : 0))[0];
            app.ui.act.res = best;
          }
          app.rerender();
        },
      }, svg(ICON[T.icon] || ICON.still), h('span', null, h('b', null, label), h('small', null, help))));
      if (pressed) group.append(actPicker(app, a));
    }
    out.push(group);
  }
  return out;
}

function actPicker(app, A) {
  const p = app.pub;
  const me = app.priv;
  const a = app.ui.act;
  const set = (patch) => { Object.assign(a, patch); app.rerender(); };
  const box = h('div', { class: 'picker' });
  if (A.targets) box.append(pills(A.targets.map((id) => ({ value: id, label: seatName(p, id, { the: false }) })), a.target, (id) => set({ target: id }), { label: 'Who' }));
  if (A.res) box.append(pills(A.res.map((r) => ({ value: r, label: A.max ? `${r} (${A.max[r]})` : r })), a.res, (r) => set({ res: r, n: 1 }), { label: 'Which supply' }));
  if (A.kind === 'contribute' || A.kind === 'give') {
    const max = A.max ? A.max[a.res] || 1 : 1;
    box.append(h('div', { class: 'row' }, h('span', { class: 'hint' }, 'How many'), stepper('act-n', Math.min(a.n, max), 1, max, (v) => set({ n: v }), 'amount')));
  }
  if (A.kind === 'sacrifice') box.append(h('p', { class: 'hint' }, 'This cannot be undone. You will not be told whether the road accepts it until the end.'));
  box.append(h('button', {
    class: 'btn primary', type: 'button',
    onclick: () => {
      const msg = { kind: a.kind };
      if (A.targets) msg.target = a.target;
      if (A.res) msg.res = a.res;
      if (A.kind === 'contribute' || A.kind === 'give') msg.n = Math.min(a.n, A.max ? A.max[a.res] : a.n);
      app.send({ k: 'act', a: msg }).then((ack) => { if (ack.ok) { app.ui.act = null; app.rerender(); } });
    },
  }, A.kind === 'sacrifice' ? 'Make the offering' : 'Do this'));
  return box;
}

function revealPanel(app, head) {
  const p = app.pub;
  const me = app.priv;
  const meSeat = p.seats.find((s) => s.id === me.seat);
  const today = app.events.filter((e) => e.round === p.round && !['word', 'dawn', 'silence', 'vote_open'].includes(e.kind));
  const lines = (p.revealOf === 'verdict' || p.revealOf === 'prodigal')
    ? today.filter((e) => ['caught', 'wrong', 'hung', 'confess', 'prodigal_silent', 'calmed'].includes(e.kind))
    : today.filter((e) => !['caught', 'wrong', 'hung', 'confess', 'prodigal_silent'].includes(e.kind));
  const out = [head(p.revealOf === 'verdict' ? 'The verdict' : p.revealOf === 'prodigal' ? 'The prodigal seat' : 'What happened', PHASE_HINT.reveal)];
  out.push(lines.length ? h('div', { class: 'words' }, lines.map((e) => h('p', { class: 'word', style: { display: 'block' } }, e.text))) : h('p', { class: 'hint' }, 'A quiet day on the trail.'));
  if (p.revealOf === 'act' && p.vote && !p.vote.result) out.push(h('p', null, h('b', null, `Next: the table votes on ${seatName(p, p.vote.accused)}.`)));
  const ready = meSeat && meSeat.ready;
  out.push(h('button', { class: 'btn primary wide', type: 'button', disabled: ready, onclick: () => app.send({ k: 'ready' }) }, ready ? 'Waiting for the table' : 'Continue'));
  return out;
}

function votePanel(app, head) {
  const p = app.pub;
  const me = app.priv;
  const L = me.legal || {};
  const accused = p.vote.accused;
  const out = [head(`Name ${seatName(p, accused)}?`, `${p.vote.cast} voted`)];
  const accusers = (p.accusation && p.accusation.accusers) || [];
  out.push(h('p', { class: 'hint' }, `Called to account by ${accusers.map((id) => seatName(p, id)).join(' and ')}.${p.seats[accused].vouchedBy.length ? ` Vouched for by ${p.seats[accused].vouchedBy.length}.` : ''} If the table names someone who had turned, they get the prodigal seat. Name someone who hadn’t, and the camp heats up.`));
  if (accused === me.seat) { out.push(h('p', null, 'The table is voting on you. You can’t vote.')); return out; }
  if (!L.canVote) { out.push(h('p', null, p.vote.builders.includes(me.seat) ? 'You built today, so you don’t vote today.' : 'You’re outside the line and can’t vote today.')); return out; }
  app.ui.stake = app.ui.stake ?? false;
  const cast = (yes) => app.send({ k: 'vote', yes, stake: !!app.ui.stake && L.canStake });
  const mine = me.vote;
  out.push(h('div', { class: 'ballot' },
    h('button', { class: 'btn' + (mine && mine.yes ? ' primary' : ''), type: 'button', onclick: () => cast(true) }, 'Name them'),
    h('button', { class: 'btn' + (mine && !mine.yes ? ' primary' : ''), type: 'button', onclick: () => cast(false) }, 'Not them')));
  if (L.canStake) out.push(h('label', { class: 'toggle', for: 'stake' }, h('span', null, 'Stake your conviction (your vote counts double)'),
    h('input', { id: 'stake', type: 'checkbox', checked: !!app.ui.stake, onchange: (e) => { app.ui.stake = e.target.checked; if (mine) cast(mine.yes); } })));
  if (mine) out.push(h('p', { class: 'hint' }, `You voted ${mine.yes ? 'to name them' : 'not to'}${mine.stake ? ', with conviction' : ''}. You can change it until time runs out.`));
  return out;
}

function prodigalPanel(app, head) {
  const p = app.pub;
  const me = app.priv;
  const seat = p.prodigal.seat;
  if (seat !== me.seat) return [head('The prodigal seat'), h('p', null, `${SeatName(p, seat)} sits in the prodigal seat. The table waits to hear from them.`)];
  const ta = h('textarea', { id: 'confess-text', maxlength: 200, placeholder: 'Say it in your own words, if you want to.' });
  ta.value = app.ui.confess || '';
  ta.addEventListener('input', () => { app.ui.confess = ta.value; });
  return [head('The prodigal seat'),
    h('p', null, 'The table named you, and they were right. Nobody is sent away. Confess out loud, or stay silent.'),
    ta,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => app.send({ k: 'prodigal', choice: 'confess', text: app.ui.confess || '' }) }, 'Confess'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => app.send({ k: 'prodigal', choice: 'silent' }) }, 'Stay silent'))];
}

function crossingPanel(app, head) {
  const p = app.pub;
  const r = p.crossing && p.crossing.result;
  if (!r) return [head('The crossing')];
  const rows = Object.keys(r.need).map((res) => h('div', { class: 'cache-row' }, resIcon(res), h('span', null, h('b', null, `${r.pool[res] || 0} of ${r.need[res]}`), ` ${res}`)));
  return [head(r.ok ? 'Across' : 'A wagon lost'),
    h('p', null, r.ok ? `The train crossed ${p.crossing.name}.` : `${p.crossing.name.charAt(0).toUpperCase() + p.crossing.name.slice(1)} took a wagon, and the river took weight from everyone.`),
    h('div', { class: 'cache-rows' }, rows)];
}

// ---------- your hand ----------

function handPanel(app) {
  const p = app.pub;
  const me = app.priv;
  const seat = p.seats.find((s) => s.id === me.seat) || {};
  const ch = charOf(seat);
  const lvl = PRESENCE_LEVELS.slice().reverse().find((l) => me.presence >= l.min) || PRESENCE_LEVELS[0];
  const out = [];
  out.push(h('div', { class: 'row between' },
    h('div', { class: 'row' }, emblemEl(seat.character, 'hand-emblem'),
      h('div', null, h('h3', null, ch ? `You are the ${ch.name}` : 'Your hand'), h('p', { class: 'hint' }, ch ? `${archName(seat.archetype)}. ${ch.garb}.` : ''))),
    me.host ? h('span', { class: 'badge lead' }, 'Host') : null));
  if (me.turned) {
    out.push(h('div', { class: 'turned-band', role: 'note' },
      h('strong', null, 'You have turned.'),
      h('span', null, 'No one else knows. If the train fails, you win. You can still step forward before anyone names you.')));
  }
  out.push(h('div', { class: 'supplies' }, RES.map((r) => h('div', { class: 'supply' }, resIcon(r), h('b', null, String(me.res ? me.res[r] : 0)), h('span', null, r)))));
  out.push(h('div', { class: 'row between' },
    h('span', { class: 'hint' }, `Carrying ${me.weight}: ${seat.weight || ''}${seat.weight === 'heavy' ? '. Heavy wagons dim your lantern and raise the river.' : ''}`),
    seat.hungry ? h('span', { class: 'badge hot' }, 'Hungry') : null));
  out.push(h('div', { class: 'field' },
    h('span', null, `Presence: ${me.presence} (${lvl.name})`),
    h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': me.presence }, h('i', { style: { width: `${me.presence}%` } }))));
  const assets = [];
  if (me.assets) {
    if (me.assets.crowns) assets.push(`${me.assets.crowns > 1 ? me.assets.crowns + ' crowns' : 'the crown'}`);
    if (me.assets.crowd) assets.push(`a crowd of ${me.assets.crowd}`);
    const lev = Object.entries(me.assets.leverage || {}).filter(([, n]) => n > 0);
    if (lev.length) assets.push(`letters on ${lev.map(([id, n]) => `${seatName(p, Number(id))} (${n})`).join(', ')}`);
    if (me.assets.conviction) assets.push('your conviction');
  }
  out.push(h('p', { class: 'hint' }, assets.length ? `You hold ${assets.join(', ')}.` : me.sacrificed ? `You made your offering on day ${me.sacrificed.round}.` : 'You hold nothing the others want.'));
  const notes = (me.notes || []).slice().reverse().filter((n) => !(n.data && n.data.turned)).slice(0, 5);
  if (notes.length) {
    out.push(h('div', { class: 'field' }, h('span', null, 'What only you know'),
      h('div', { class: 'words' }, notes.map((n) => h('p', { class: 'word', style: { display: 'block' } }, `Day ${n.round}: ${n.text}`)))));
  }
  return out;
}

// ---------- seats ----------

function seatsPanel(app) {
  const p = app.pub;
  const me = app.priv;
  const saidBy = new Set(p.words.filter((w) => w.round === p.round && !w.founding).map((w) => w.seat));
  const progress = (s) => (p.phase === 'talk' || p.phase === 'reveal' ? s.ready : p.phase === 'act' ? s.acted : p.phase === 'vote' ? s.voted : false);
  const out = [h('div', { class: 'section-head' }, h('h2', null, 'The train'), h('span', { class: 'dim' }, `${p.seats.length} wagons`))];
  out.push(h('div', { class: 'seats' }, p.seats.map((s) => {
    const ch = charOf(s);
    const badges = [];
    if (p.lead === s.id) badges.push(h('span', { class: 'badge lead', title: 'Leads the train' }, svg(ICON.crown)));
    if (s.crowns) badges.push(h('span', { class: 'badge', title: 'Crowns held' }, svg(ICON.crown), s.crowns > 1 ? String(s.crowns) : null));
    if (s.crowd) badges.push(h('span', { class: 'badge', title: 'Crowd' }, svg(ICON.crowd), String(s.crowd)));
    if (s.letters) badges.push(h('span', { class: 'badge', title: 'Letters held' }, svg(ICON.letter), String(s.letters)));
    if (s.conviction) badges.push(h('span', { class: 'badge', title: 'Conviction' }, svg(ICON.scale)));
    if (s.silence) badges.push(h('span', { class: 'badge', title: 'Holding silence' }, svg(ICON.hush)));
    if (s.sacrificed) badges.push(h('span', { class: 'badge ok', title: 'Made an offering' }, svg(ICON.sacrifice)));
    if (s.vouchedBy.length) badges.push(h('span', { class: 'badge ok', title: 'Vouched for' }, svg(ICON.vouch), String(s.vouchedBy.length)));
    if (s.hungry) badges.push(h('span', { class: 'badge hot', title: 'Hungry' }, '!'));
    if (s.standIn || (!s.connected && s.human)) badges.push(h('span', { class: 'badge', title: s.standIn ? 'A stand-in is playing' : 'Disconnected' }, svg(ICON.standin)));
    if (s.caught && s.prodigal === 'silent') badges.push(h('span', { class: 'badge hot' }, 'silent'));
    if (s.weight === 'heavy') badges.push(h('span', { class: 'badge hot', title: 'Heavy wagon' }, 'heavy'));
    const glow = [0.05, 0.25, 0.45, 0.7, 1][s.presence] ?? 0.4;
    return h('button', {
      type: 'button',
      class: 'seat' + (s.id === me.seat ? ' me' : '') + (s.outside ? ' outside' : '') + (s.caught && !s.redeemed ? ' caught' : '') + (s.redeemed ? ' redeemed' : '') + (!s.connected && s.human && !s.standIn ? ' offline' : ''),
      'aria-label': `${ch ? ch.name : 'Seat'}${s.id === me.seat ? ' (you)' : ''}, ${archName(s.archetype)}, presence ${PRESENCE_LEVELS[s.presence].name}`,
      onclick: () => openSeat(app, s.id),
    },
    progress(s) ? h('span', { class: 'ready-mark', 'aria-hidden': 'true' }, '✓') : null,
    saidBy.has(s.id) ? h('span', { class: 'said', title: 'Said something today' }) : null,
    h('span', { class: 'token', style: { '--glow': String(glow) } }, emblemEl(s.character)),
    h('span', { class: 'name' }, ch ? ch.name : `Seat ${s.id + 1}`, s.id === me.seat ? ' (you)' : ''),
    h('span', { class: 'arch' }, archName(s.archetype)),
    h('span', { class: 'badges' }, badges));
  })));
  return out;
}

// ---------- crossing cache ----------

function cachePanel(app) {
  const p = app.pub;
  const c = p.crossing;
  if (!c) return [h('h3', null, 'The crossing')];
  const out = [h('div', { class: 'section-head' }, h('h2', null, c.name.charAt(0).toUpperCase() + c.name.slice(1)), h('span', { class: 'dim' }, 'at the end of this act'))];
  out.push(h('p', { class: 'hint' }, c.line));
  out.push(h('div', { class: 'cache-rows' }, Object.keys(c.pool).map((r) => {
    const g = c.gauges && c.gauges[r];
    return h('div', { class: 'cache-row' }, resIcon(r), h('span', null, h('b', null, String(c.pool[r] || 0)), ` ${r} in the cache`, h('br'), g ? h('small', { class: `lvl-${g.level}` }, g.text) : null));
  })));
  const rules = p.rules;
  const notes = [];
  if (rules.accuseNeeds > 1) notes.push('Clear skies: a vote needs two accusers.');
  if (p.weather.band === 'hot' || p.weather.band === 'boiling') notes.push('Every dawn costs a water now.');
  if (!rules.forage) notes.push('Too stormy to forage.');
  if (!rules.boundary) notes.push('No one can draw a line in a dust storm.');
  if (rules.tradeTax) notes.push('Trades cost a water.');
  if (notes.length) out.push(h('p', { class: 'hint' }, notes.join(' ')));
  return out;
}

// ---------- talk + diary ----------

function paintChat(app) {
  const E = app.els;
  const p = app.pub;
  const me = app.priv;
  if (!p.config.tableTalk) {
    E.chat.hidden = true;
    return;
  }
  E.chat.hidden = false;
  const atBottom = E.chatLog.scrollHeight - E.chatLog.scrollTop - E.chatLog.clientHeight < 40;
  swap(E.chatLog, p.chat.length ? p.chat.map((c) => h('p', null, h('b', null, `${seatName(p, c.seat, { the: false })}: `), c.text)) : h('p', { class: 'hint' }, 'No one has said anything yet.'));
  if (atBottom) E.chatLog.scrollTop = E.chatLog.scrollHeight;
  E.chatNote.textContent = me.silence && me.silence.holding ? 'You’re holding silence. Talking here breaks it.' : 'Never scored by the game.';
}

function paintDiary(app) {
  const E = app.els;
  const atBottom = E.diaryList.scrollHeight - E.diaryList.scrollTop - E.diaryList.clientHeight < 60;
  const kids = [];
  let day = -1;
  for (const e of app.events) {
    if (e.round !== day) {
      day = e.round;
      kids.push(h('p', { class: 'diary-day' }, day === 0 ? 'Independence' : `Day ${day}`));
    }
    kids.push(h('p', { class: `diary-entry k-${e.kind}${app.fresh && app.fresh.has(e.seq) ? ' new' : ''}` }, e.text));
  }
  swap(E.diaryList, kids);
  if (atBottom || (app.fresh && app.fresh.size)) E.diaryList.scrollTop = E.diaryList.scrollHeight;
  const chain = app.chain;
  E.seal.className = 'seal' + (chain.ok ? '' : ' bad');
  E.seal.textContent = chain.ok
    ? `${app.events.length} entries, sealed in order. Latest seal ${chain.head ? chain.head.slice(0, 12) : ''}.${app.gapNote ? ' ' + app.gapNote : ''}`
    : `The diary’s seals don’t match at entry ${chain.at}. Reload to fetch a clean copy.`;
}

export { PACES, CHARACTERS };
