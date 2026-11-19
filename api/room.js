// Función de Vercel: GET /api/room?code=ABCD&token=… devuelve la mesa como la ve ese jugador.
//                   POST /api/room { op, code, token, … } crea, entra o hace una jugada.
const crypto = require('crypto');
const game = require('../lib/game');
const store = require('../lib/store');

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const makeCode = () => Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');
const clean = (s, max) => game.cleanText(s, max);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Lee la sala, le aplica el paso del tiempo y el cambio pedido, y la guarda.
// Si otro jugador la cambió en el medio, vuelve a intentar con la versión nueva.
async function mutate(code, change) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { room, ver } = await store.load(code);
    if (!room) throw new HttpError(404, 'La sala ya no existe.');
    const now = Date.now();
    let dirty = game.tick(room, now);
    const result = change(room, now) || {};
    dirty = dirty || result.dirty;
    if (!dirty) return { room, now, error: result.error };
    const empty = game.isEmpty(room);
    if (await store.save(code, empty ? null : room, ver)) return { room, now, error: result.error };
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * (attempt + 1)));
  }
  throw new HttpError(503, 'Hay mucho movimiento en la sala, intenta de nuevo.');
}

async function handle(req) {
  if (store.missing) throw new HttpError(500, 'Falta conectar la base de datos: en Vercel, Storage → Upstash Redis.');

  if (req.method === 'GET') {
    const code = clean(req.query.code, 8).toUpperCase();
    const token = clean(req.query.token, 64);
    const { room, now } = await mutate(code, (r, t) => ({ dirty: game.touch(r, token, t) }));
    return game.stateFor(room, token, now);
  }

  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido.');
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const op = clean(body.op, 16);
  const token = clean(body.token, 64);
  if (token.length < 8) throw new HttpError(400, 'Falta la identificación del jugador.');

  if (op === 'create') {
    const name = clean(body.name, 16);
    if (!name) throw new HttpError(400, 'Escribe tu nombre.');
    for (let i = 0; i < 20; i++) {
      const code = makeCode();
      const now = Date.now();
      const room = game.createRoom(code, token, name, body.settings, now);
      if (await store.save(code, room, 0)) return game.stateFor(room, token, now);
    }
    throw new HttpError(503, 'No se pudo crear la sala, intenta de nuevo.');
  }

  const code = clean(body.code, 8).toUpperCase();
  const { room, now, error } = await mutate(code, (r, t) => {
    const before = JSON.stringify(r);
    const err = game.apply(r, token, op, body, t);
    return { error: err, dirty: JSON.stringify(r) !== before };
  });
  if (op === 'join' && error) throw new HttpError(400, error);
  return { ...game.stateFor(room, token, now), error: error || undefined };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json(await handle(req));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    res.status(e.status || 500).json({ error: e instanceof HttpError ? e.message : 'Error del servidor, intenta de nuevo.' });
  }
};
