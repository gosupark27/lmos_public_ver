// Room codes aren't guessable (invariant 4).
// 8 characters from a 30-letter alphabet with no look-alikes (no I, L, O, U, 0, 1):
// 30^8 ≈ 6.6 × 10^11 codes, drawn with rejection sampling so every letter is equally likely.
// Only the host's create call mints one; joining never creates a room.

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const CODE_LENGTH = 8;

export function newRoomCode() {
  const out = [];
  const limit = 256 - (256 % CODE_ALPHABET.length); // 240: reject bytes above to avoid bias
  while (out.length < CODE_LENGTH) {
    const buf = new Uint8Array(16);
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < CODE_LENGTH) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
    }
  }
  return out.slice(0, 4).join('') + '-' + out.slice(4).join('');
}

export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== CODE_LENGTH) return null;
  for (const ch of raw) if (!CODE_ALPHABET.includes(ch)) return null;
  return raw.slice(0, 4) + '-' + raw.slice(4);
}
