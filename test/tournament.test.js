// Torneo de varias mesas: se juega entero (una persona que siempre iguala contra bots en
// varias mesas) y se verifica que las fichas cuadren, que se armen la mesa final y los puestos.
const test = require('node:test');
const assert = require('node:assert');
const game = require('../lib/game');

const roundtrip = (room) => JSON.parse(JSON.stringify(room));
function allChips(room) {
  const live = room.hand && room.hand.stage !== 'showdown';
  let sum = room.seats.filter(Boolean).reduce((a, p) => a + p.chips + (live ? p.total : 0), 0);
  for (const t of room.tour.tables) for (const p of t.seats) if (p) sum += p.chips;
  return sum;
}

test('torneo de 27: se cierran mesas, hay mesa final y un ganador', () => {
  let now = 1_000_000;
  const me = 'token-persona-1';
  let room = game.createRoom('TOUR', me, 'Yo', { startChips: 1500, bigBlind: 20, turnTime: 30, tourSize: 27, levelHands: 4 }, now);
  game.apply(room, me, 'settings', { botSpeed: 'rapida' }, now);
  assert.strictEqual(game.apply(room, me, 'start', {}, now), null);
  assert.strictEqual(room.tour.tables.length, 2);
  assert.strictEqual(room.seats.filter(Boolean).length, 9);
  const total = 27 * 1500;
  let sawFinal = false, sawWatch = false, maxTables = 3;

  for (let step = 0; step < 60000 && !room.tour.finished; step++) {
    now += 1600;
    room = roundtrip(room);
    game.tick(room, now);
    game.touch(room, me, now);
    assert.strictEqual(allChips(room), total, `fichas en paso ${step}`);
    if (room.tour.tables.length === 0) sawFinal = true;
    maxTables = Math.min(maxTables, room.tour.tables.length + 1);
    const st = game.stateFor(room, me, now);
    assert(!st.gone, 'la persona eliminada sigue pudiendo mirar');
    if (st.yourSeat < 0) sawWatch = true;
    if (st.actions) game.apply(room, me, 'action', { type: st.actions.canCheck ? 'check' : 'call' }, now);
  }
  const T = room.tour;
  assert(T.finished, 'el torneo terminó');
  assert(sawFinal, 'hubo mesa final');
  assert(T.winner);
  assert.strictEqual(T.out.length, 26);
  assert.deepStrictEqual(T.out.map((o) => o.place).sort((a, b) => a - b), Array.from({ length: 26 }, (_, i) => i + 2));
  assert(T.level > 0, 'subieron las ciegas');
  const st = game.stateFor(room, me, now);
  assert.strictEqual(st.tour.standings.length, 27);
  assert(st.tour.myPlace >= 1);
  assert(!game.isEmpty(room), 'la sala sigue mientras la persona mira');
  console.log(`  ganó ${T.winner}, yo quedé ${st.tour.myPlace}º, nivel ${T.level + 1}, mano ${room.handNo}${sawWatch ? ', miré como eliminado' : ''}`);
});

test('torneo: no se puede entrar una vez empezado ni dar fichas', () => {
  const now = 1_000_000;
  const room = game.createRoom('TOUR', 'token-host-x', 'Host', { tourSize: 18 }, now);
  assert.strictEqual(game.apply(room, 'token-amigo-1', 'join', { name: 'Amigo' }, now), null);
  game.apply(room, 'token-host-x', 'start', {}, now);
  assert.match(game.apply(room, 'token-nuevo-1', 'join', { name: 'Tarde' }, now), /ya empezó/);
  assert.match(game.apply(room, 'token-host-x', 'chips', { seat: 1, amount: 500 }, now), /torneo/);
  const total = room.seats.filter(Boolean).length + room.tour.tables.reduce((a, t) => a + t.seats.filter(Boolean).length, 0);
  assert.strictEqual(total, 18);
});
