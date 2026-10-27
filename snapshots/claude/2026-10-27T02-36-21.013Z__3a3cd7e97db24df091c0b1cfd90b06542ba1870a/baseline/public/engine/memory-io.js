// In-memory host for RoomCore: used by tests, simulations, and the single-device preview.

export function memoryIO({ clock, fast = false, passportKey = 'handshake-preview', onSend, onAlarm } = {}) {
  const ledger = [];
  const intents = new Map();
  const conns = new Set();
  const io = {
    alarm: null,
    ledger,
    conns,
    fast,
    passportKey,
    saves: 0,
    now: () => (clock ? clock() : Date.now()),
    save() { io.saves += 1; },
    appendLedger(entries) { for (const e of entries) ledger.push(e); },
    readLedger(since) { return ledger.filter((e) => e.seq > since); },
    getIntent(key) { return intents.get(key) || null; },
    putIntent(key, result) {
      intents.set(key, result);
      if (intents.size > 4000) intents.delete(intents.keys().next().value);
    },
    connectedSeats() { return conns; },
    send(seatId, msg) { if (onSend) onSend(seatId, msg); },
    setAlarm(ms) { io.alarm = ms; if (onAlarm) onAlarm(ms); },
  };
  return io;
}
