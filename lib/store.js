// Dónde se guardan las salas.
// - En Vercel: Upstash Redis por su API REST (se conecta desde Vercel → Storage, que crea las
//   variables KV_REST_API_URL y KV_REST_API_TOKEN, o UPSTASH_REDIS_REST_URL / _TOKEN).
// - En la compu (npm run dev) sin esas variables: en memoria.
// Cada sala tiene un número de versión: se guarda solo si nadie la cambió desde que se leyó,
// así dos jugadas al mismo tiempo no se pisan (la que pierde se reintenta).

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 7 * 24 * 60 * 60; // una sala sin movimiento se borra sola a los 7 días (con su ranking)

// las llaves comparten {…} para quedar en el mismo lugar de Redis (necesario para el script)
const keys = (code) => [`poker:{${code}}`, `poker:{${code}}:v`];

// Guarda solo si la versión sigue siendo la esperada. ARGV: json, versión esperada, nueva, ttl
const SAVE_SCRIPT = `
local v = redis.call('GET', KEYS[2]) or '0'
if v ~= ARGV[2] then return 0 end
if ARGV[1] == '' then
  redis.call('DEL', KEYS[1], KEYS[2])
else
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
  redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
end
return 1`;

async function redis(command) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(command),
  });
  const body = await res.json();
  if (body.error) throw new Error('Redis: ' + body.error);
  return body.result;
}

const redisStore = {
  async load(code) {
    const [json, ver] = await redis(['MGET', ...keys(code)]);
    return json ? { room: JSON.parse(json), ver: Number(ver) || 0 } : { room: null, ver: Number(ver) || 0 };
  },
  // room = null borra la sala
  async save(code, room, ver) {
    const r = await redis(['EVAL', SAVE_SCRIPT, '2', ...keys(code), room ? JSON.stringify(room) : '', String(ver), String(ver + 1), String(TTL)]);
    return r === 1;
  },
};

const memory = new Map();
const memoryStore = {
  async load(code) {
    const e = memory.get(code);
    return e ? { room: JSON.parse(e.json), ver: e.ver } : { room: null, ver: 0 };
  },
  async save(code, room, ver) {
    const e = memory.get(code);
    if ((e ? e.ver : 0) !== ver) return false;
    if (room) memory.set(code, { json: JSON.stringify(room), ver: ver + 1 });
    else memory.delete(code);
    return true;
  },
};

const configured = Boolean(URL && TOKEN);
// En Vercel cada consulta puede caer en una máquina distinta: la memoria no sirve.
const missing = !configured && Boolean(process.env.VERCEL);

module.exports = configured ? redisStore : memoryStore;
module.exports.missing = missing;
module.exports.kind = configured ? 'redis' : 'memoria';
