// Handshake Worker: serves the phone client and routes each room to its Durable Object.
// Host-only creation: only POST /api/rooms mints a room. Joining never creates one.

import { Room } from './room.js';
import { newRoomCode, normalizeCode } from './codes.js';
import { SPEC_HASH } from './spec.js';
import { BUILD } from '../public/engine/constants.js';

export { Room };

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const ROOM_ACTIONS = {
  meta: 'GET',
  seen: 'POST',
  left: 'POST',
  poll: 'GET',
  intent: 'POST',
  ws: 'GET',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (err) {
        return json({ err: 'server_error' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function api(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', code, action]
  if (parts[1] === 'health') return json({ ok: true, build: BUILD, spec: SPEC_HASH });
  if (parts[1] !== 'rooms') return json({ err: 'not_found' }, 404);

  if (parts.length === 2) {
    if (request.method !== 'POST') return json({ err: 'method' }, 405);
    const body = await request.json().catch(() => ({}));
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newRoomCode();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      const res = await stub.fetch('https://room/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, seed, specHash: SPEC_HASH, config: body && body.config, allowDev: env.HANDSHAKE_DEV === '1' }),
      });
      if (res.status === 409) continue; // astronomically unlikely collision: draw again
      return res;
    }
    return json({ err: 'try_again' }, 503);
  }

  const code = normalizeCode(decodeURIComponent(parts[2] || ''));
  if (!code) return json({ err: 'bad_code' }, 400);
  const action = parts[3] || 'meta';
  const method = ROOM_ACTIONS[action];
  if (!method) return json({ err: 'not_found' }, 404);
  if (request.method !== method) return json({ err: 'method' }, 405);
  if (action === 'ws' && request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected a WebSocket', { status: 426 });
  }
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  return stub.fetch(new Request(`https://room/${action}${url.search}`, request));
}
