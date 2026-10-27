// Test fixture: a table where every seat is a connected human the test controls.
import { RoomCore } from '../public/engine/core.js';
import { memoryIO } from '../public/engine/memory-io.js';

export function makeTable({ seats = 4, tier = 2, seed = 7, config = {}, connect = true } = {}) {
  let t = 1_000_000;
  const sent = [];
  const io = memoryIO({ clock: () => t, onSend: (seat, msg) => sent.push({ seat, msg, t }) });
  const { core, hostToken } = RoomCore.create({
    code: 'TEST-0001', now: t, seed, specHash: 'test',
    config: { seats, tier, fillBots: false, pace: 'standard', ...config },
  }, io);
  const tokens = [hostToken];
  if (connect) {
    io.conns.add(0);
    core.greet(0, { token: hostToken, isNew: false, lastSeq: 0 }, t);
    for (let i = 1; i < seats; i++) {
      const a = core.authenticate({}, t);
      io.conns.add(a.seat);
      core.greet(a.seat, { token: a.token, isNew: true, lastSeq: 0 }, t);
      tokens.push(a.token);
    }
  }
  const T = {
    core, io, sent, tokens,
    get state() { return core.state; },
    get now() { return t; },
    set now(v) { t = v; },
    tick(ms = 0) { t += ms; core.tick(t); },
    intent(seat, msg) { return core.intent(seat, { ps: core.state.phaseSeq, ...msg }, t); },
    seatOf(archetype) { return core.state.seats.find((s) => s.archetype === archetype); },
    // Jump the server clock to the end of the current phase.
    expire() { if (core.state.phaseEndsAt != null) { t = core.state.phaseEndsAt; core.tick(t); } },
    skipTo(phase, guard = 60) {
      while (core.state.phase !== phase && guard-- > 0) T.expire();
      if (core.state.phase !== phase) throw new Error(`never reached ${phase}, stuck in ${core.state.phase}`);
    },
    allReady() { for (const s of core.state.seats) T.intent(s.id, { k: 'ready' }); },
    // Play one act phase: actions is {seatId: action}; everyone else is still.
    act(actions = {}) {
      if (core.state.phase !== 'act') throw new Error('not in act, in ' + core.state.phase);
      for (const s of core.state.seats) {
        const a = actions[s.id] || { kind: 'still' };
        const r = T.intent(s.id, { k: 'act', a });
        if (!r.ok) throw new Error(`seat ${s.id} act ${a.kind} refused: ${r.err}`);
      }
    },
    start() {
      const r = T.intent(0, { k: 'start' });
      if (!r.ok) throw new Error('start: ' + r.err);
      T.skipTo('talk');
    },
    messagesTo(seat) { return sent.filter((x) => x.seat === seat).map((x) => x.msg); },
  };
  return T;
}
