// Prueba la parte de Redis contra una imitación de la API REST de Upstash (con demoras al azar
// para que las consultas se crucen): muchas jugadas a la vez no deben perderse ni pisarse.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const data = new Map();
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => setTimeout(() => {
    if (req.headers.authorization !== 'Bearer token-de-prueba') return res.end(JSON.stringify({ error: 'Unauthorized' }));
    const [cmd, ...args] = JSON.parse(body);
    let result;
    if (cmd === 'MGET') result = args.map((k) => data.get(k) ?? null);
    else if (cmd === 'EVAL') {
      // misma lógica que SAVE_SCRIPT de lib/store.js
      const [script, , k1, k2, json, expected, next] = args;
      assert.match(script, /redis\.call\('GET', KEYS\[2\]\)/);
      if ((data.get(k2) ?? '0') !== expected) result = 0;
      else {
        if (json === '') { data.delete(k1); data.delete(k2); } else { data.set(k1, json); data.set(k2, next); }
        result = 1;
      }
    } else return res.end(JSON.stringify({ error: 'comando no soportado ' + cmd }));
    res.end(JSON.stringify({ result }));
  }, Math.random() * 15));
});

function call(handler, method, payload) {
  return new Promise((resolve) => {
    const req = method === 'GET' ? { method, query: payload } : { method, body: payload, query: {} };
    const res = {
      statusCode: 200,
      setHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler(req, res);
  });
}

test('con Redis: jugadas simultáneas no se pierden', async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.KV_REST_API_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.KV_REST_API_TOKEN = 'token-de-prueba';
  const store = require('../lib/store');
  assert.strictEqual(store.kind, 'redis');
  const handler = require('../api/room');

  const created = await call(handler, 'POST', { op: 'create', token: 'jugador-0000', name: 'Ana' });
  assert.strictEqual(created.status, 200);
  const code = created.body.code;
  assert.match(code, /^[A-Z]{4}$/);

  // 5 jugadores entran a la vez
  const joins = await Promise.all([1, 2, 3, 4, 5].map((i) => call(handler, 'POST', { op: 'join', code, token: `jugador-000${i}`, name: `J${i}` })));
  joins.forEach((j) => assert.strictEqual(j.status, 200, JSON.stringify(j.body)));

  // 40 mensajes de chat y 20 consultas, todos al mismo tiempo
  const ops = [];
  for (let i = 0; i < 40; i++) ops.push(call(handler, 'POST', { op: 'chat', code, token: `jugador-000${i % 6}`, text: `mensaje ${i}` }));
  for (let i = 0; i < 20; i++) ops.push(call(handler, 'GET', { code, token: `jugador-000${i % 6}` }));
  const results = await Promise.all(ops);
  results.forEach((r) => assert.strictEqual(r.status, 200, JSON.stringify(r.body)));

  const final = await call(handler, 'GET', { code, token: 'jugador-0000' });
  assert.strictEqual(final.body.seats.filter(Boolean).length, 6);
  const texts = final.body.chat.map((m) => m.text);
  for (let i = 0; i < 40; i++) assert(texts.includes(`mensaje ${i}`), `falta mensaje ${i}`);

  // empezar y jugar: cada uno ve solo sus cartas
  assert.strictEqual((await call(handler, 'POST', { op: 'start', code, token: 'jugador-0000' })).status, 200);
  const views = await Promise.all([0, 1, 2].map((i) => call(handler, 'GET', { code, token: `jugador-000${i}` })));
  for (const v of views) {
    const mine = v.body.seats.find((s) => s && s.isYou);
    assert(mine.cards.every(Boolean), 'veo mis cartas');
    for (const s of v.body.seats) if (s && !s.isYou) assert(s.cards.every((c) => c === null), 'no veo cartas ajenas');
  }

  // sala inexistente
  assert.strictEqual((await call(handler, 'GET', { code: 'ZZZZ', token: 'jugador-0000' })).status, 404);
  fake.close();
});
