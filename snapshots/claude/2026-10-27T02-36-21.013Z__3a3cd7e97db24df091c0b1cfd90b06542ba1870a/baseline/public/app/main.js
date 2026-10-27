// Handshake client: routing, the link to the room, and effects that arrive with state.
import { h, swap, store, toast } from './dom.js';
import { ServerLink, LocalLink } from './net.js';
import { verifyChain } from '../engine/core.js';
import { audio } from './audio.js';
import { errorText } from './text.js';
import { renderHome, renderInvite } from './home.js';
import { renderLobby } from './lobby.js';
import { mountTable, updateTable } from './table.js';
import { renderEnd } from './end.js';
import { moment, capyRain } from './moments.js';

export const app = {
  preview: !!globalThis.HANDSHAKE_PREVIEW,
  specHash: globalThis.HANDSHAKE_SPEC || null,
  root: document.getElementById('app'),
  link: null,
  code: null,
  pub: null,
  priv: null,
  events: [],
  chain: { ok: true },
  gapNote: null,
  status: 'idle',
  screen: null,
  tableMounted: false,
  lastPs: null,
  shownMoments: new Set(),
  cleanup: [],
  ui: { tab: 'table', act: null, word: null, trade: null, confess: '', glow: false, eggs: store.get('hs:eggs', []) },
  serverNow() { return app.link ? app.link.serverNow() : Date.now(); },
  send(intent) {
    if (!app.link || !app.pub) return Promise.resolve({ ok: false });
    return app.link.send({ ps: app.pub.ps, ...intent }).then((ack) => {
      if (!ack.ok && ack.err) toast(errorText(ack.err), true);
      return ack;
    });
  },
  rerender() { render(); },
  go(path) {
    if (!app.preview) history.pushState(null, '', path);
    route();
  },
  hostTable,
  joinTable,
  practice,
  leave,
};

function setScreen(name, build) {
  const changed = app.screen !== name;
  // Tear down the old screen's timers before the new one starts its own.
  for (const f of app.cleanup.splice(0)) { try { f(); } catch { /* already gone */ } }
  const node = typeof build === 'function' ? build() : build;
  app.screen = name;
  app.tableMounted = false;
  swap(app.root, node);
  if (changed) window.scrollTo(0, 0);
}

// ---------- routes ----------

function route() {
  const m = !app.preview && location.pathname.match(/^\/r\/([A-Za-z0-9-]{8,9})\/?$/);
  if (m) {
    const code = m[1].toUpperCase().replace(/^(.{4})-?(.{4})$/, '$1-$2');
    const token = store.get(`hs:tok:${code}`);
    if (token) return joinTable(code, token);
    return setScreen('invite', () => renderInvite(app, code));
  }
  if (app.link) leave(false);
  setScreen('home', () => renderHome(app));
}

window.addEventListener('popstate', route);

// ---------- rooms ----------

async function hostTable(config) {
  audio.unlock();
  try {
    const r = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config }) });
    const j = await r.json();
    if (!j.token) throw new Error(j.err || 'no room');
    store.set(`hs:tok:${j.code}`, j.token);
    history.pushState(null, '', `/r/${j.code}`);
    joinTable(j.code, j.token);
  } catch {
    toast('Couldn’t open a table. Check that the server is running.', true);
  }
}

function joinTable(code, token) {
  if (app.link) leave(false);
  resetRoom();
  app.code = code;
  app.link = new ServerLink({
    code, token, passport: store.get('hs:passport'),
    onMessage, onStatus,
  });
  app.link.connect();
  setScreen('connecting', h('div', { class: 'home-body' }, h('p', { class: 'dim', style: { 'margin-top': '40px' } }, 'Finding your table…')));
}

function practice(config) {
  audio.unlock();
  if (app.link) leave(false);
  resetRoom();
  app.code = 'PRACTICE';
  app.link = new LocalLink({ config, specHash: app.specHash, onMessage, onStatus });
  app.link.connect();
}

function leave(goHome = true) {
  if (app.link) app.link.close();
  app.link = null;
  audio.music(false);
  resetRoom();
  if (goHome) {
    if (!app.preview) history.pushState(null, '', '/');
    setScreen('home', () => renderHome(app));
  }
}

function resetRoom() {
  app.pub = null; app.priv = null; app.events = []; app.chain = { ok: true }; app.gapNote = null;
  app.lastPs = null; app.shownMoments = new Set();
  app.ui.act = null; app.ui.word = null; app.ui.trade = null; app.ui.confess = ''; app.ui.glow = false;
}

function onStatus(s, info) {
  app.status = s;
  if (s === 'gap' && info) app.gapNote = `Gap flagged: diary entries ${info.from}–${info.to} were missing, so the table resent them.`;
  if (s === 'closed' && info && app.code) {
    const known = errorText(info);
    if (info === 'bad_token' || info === 'started' || info === 'full') {
      store.del(`hs:tok:${app.code}`);
      toast(known, true);
      leave(true);
      return;
    }
  }
  if (app.screen === 'table') updateTable(app);
}

function onMessage(msg) {
  if (msg.t === 'welcome') {
    if (msg.token && app.code && app.code !== 'PRACTICE') store.set(`hs:tok:${app.code}`, msg.token);
    return;
  }
  if (msg.t === 'error') { toast(errorText(msg.err), true); return; }
  if (msg.t !== 'state' && msg.t !== 'sync') return;
  const fresh = [];
  const have = new Set(app.events.map((e) => e.seq));
  for (const e of msg.events || []) if (!have.has(e.seq)) { app.events.push(e); fresh.push(e); }
  app.events.sort((a, b) => a.seq - b.seq);
  app.chain = verifyChain(app.events);
  const prevPhase = app.pub ? app.pub.phase : null;
  app.pub = msg.pub;
  app.priv = msg.priv;
  app.fresh = new Set(fresh.map((e) => e.seq));
  if (app.priv && app.priv.passport) store.set('hs:passport', app.priv.passport);
  if (app.pub.ps !== app.lastPs) {
    app.lastPs = app.pub.ps;
    app.ui.act = null; app.ui.word = null; app.ui.trade = null;
  }
  render(prevPhase);
  for (const f of msg.fx || []) effect(f);
}

// ---------- effects that arrive with state ----------

function effect(f) {
  const delay = Math.max(0, (f.at || 0) - app.serverNow());
  setTimeout(() => {
    switch (f.kind) {
      case 'join': if (app.ui.glow) audio.bell(Math.max(0, f.n - 1)); break;
      case 'outbreak':
        audio.rumble();
        moment(app, 'outbreak');
        break;
      case 'bell':
        audio.peal();
        break;
      case 'verdict':
        if (f.caught) audio.bell(9);
        break;
      case 'feast':
        audio.bell(4); setTimeout(() => audio.bell(6), 240);
        break;
      case 'crossing':
        if (f.ok) audio.bell(5, { decay: 2 }); else audio.rumble();
        break;
      case 'matrix':
        moment(app, 'matrix');
        break;
      default: break;
    }
  }, delay);
}

// ---------- render ----------

function render(prevPhase) {
  const p = app.pub;
  if (!p) return;
  document.documentElement.dataset.sun = p.sunrise || 'yellow';
  if (p.phase === 'lobby') {
    setScreen('lobby', () => renderLobby(app));
    return;
  }
  if (p.phase === 'end') {
    if (app.screen !== 'end' || prevPhase !== 'end') setScreen('end', () => renderEnd(app));
    return;
  }
  if (app.screen !== 'table') {
    setScreen('table', () => mountTable(app));
    app.tableMounted = true;
  }
  updateTable(app);
  // Full-screen moments, once each.
  const key = `${p.phase}:${p.ps}`;
  if (!app.shownMoments.has(key)) {
    if (p.phase === 'sunrise') { app.shownMoments.add(key); moment(app, 'sunrise'); }
    if (p.phase === 'silence') { app.shownMoments.add(key); moment(app, 'silence'); }
    if (p.phase === 'frozen') { app.shownMoments.add(key); moment(app, 'peace'); }
  }
  if (prevPhase === 'lobby' && p.phase !== 'lobby') audio.music(false);
}

export { capyRain };
globalThis.__handshake = app; // for tests and curious players
route();
