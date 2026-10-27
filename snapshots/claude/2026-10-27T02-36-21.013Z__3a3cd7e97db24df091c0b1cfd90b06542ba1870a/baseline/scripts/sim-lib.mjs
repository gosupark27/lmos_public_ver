// Run all-bot games to the end. Used by the simulator and the tests.
import { RoomCore } from '../public/engine/core.js';
import { memoryIO } from '../public/engine/memory-io.js';

export function runBotGame({
  seed = 1, seats = 6, tier = 2, pace = 'standard', fast = true, listen = false,
  onTick, onSend, maxTicks = 20000, chaos = null,
} = {}) {
  let t = 1_000_000;
  const io = memoryIO({ clock: () => t, fast, onSend: (seat, msg) => { if (onSend) onSend(seat, msg, core); } });
  const { core } = RoomCore.create({ code: `SIM-${seed}`, now: t, seed, specHash: 'sim', config: { seats, tier, pace, fillBots: true } }, io);
  const host = core.state.seats[0];
  host.human = false;
  host.bot = true;
  const r = core.intent(0, { k: 'start' }, t);
  if (!r.ok) throw new Error('start failed: ' + r.err);
  if (listen) for (const s of core.state.seats) io.conns.add(s.id);
  let ticks = 0;
  while (core.state.phase !== 'end' && ticks++ < maxTicks) {
    t = Math.max(t + 1, io.alarm ?? t + 1000);
    if (chaos) chaos(core, t);
    core.tick(t);
    if (onTick) onTick(core, t);
  }
  return { core, io, ticks, t };
}
