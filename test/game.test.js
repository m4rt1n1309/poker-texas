// Simula partidas completas con bots y tiempo simulado, pasando la sala por JSON en cada
// paso (como cuando se guarda en Redis), y verifica que las fichas siempre cuadren.
const test = require('node:test');
const assert = require('node:assert');
const game = require('../lib/game');

const roundtrip = (room) => JSON.parse(JSON.stringify(room));
const chipsOnTable = (room) =>
  room.seats.filter(Boolean).reduce((a, p) => a + p.chips + (room.hand && room.hand.stage !== 'showdown' ? p.total : 0), 0);

function playGame({ players = 4, start = 20000, hands = 60, seed = 1, silentChance = 0.02 }) {
  let rnd = seed;
  const random = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  let now = 1_000_000;
  const tokens = Array.from({ length: players }, (_, i) => `token-jugador-${i}`);
  let room = game.createRoom('TEST', tokens[0], 'J0', { startChips: start, bigBlind: 20, turnTime: 30 }, now);
  for (let i = 1; i < players; i++) assert.strictEqual(game.apply(room, tokens[i], 'join', { name: 'J' + i }, now), null);
  assert.strictEqual(game.apply(room, tokens[0], 'start', {}, now), null);
  const total = players * start;
  let timeouts = 0, showdowns = 0, lastHand = 0;

  for (let step = 0; step < 20000 && room.handNo <= hands; step++) {
    now += 500;
    room = roundtrip(room);
    game.tick(room, now);
    for (const t of tokens) game.touch(room, t, now);
    assert.strictEqual(chipsOnTable(room), total, `fichas en paso ${step}`);
    if (room.hand && room.hand.stage === 'showdown' && room.handNo !== lastHand) {
      lastHand = room.handNo;
      if (room.hand.results.some((r) => r.hand)) showdowns++;
    }
    if (!room.running) break;

    for (const t of tokens) {
      const st = game.stateFor(room, t, now);
      if (st.gone) continue;
      // nadie ve cartas ajenas antes del final de la mano
      if (st.stage !== 'showdown') {
        for (const s of st.seats) if (s && !s.isYou) assert(s.cards.every((c) => c === null), 'carta ajena visible');
      }
      const a = st.actions;
      if (!a) continue;
      if (random() < silentChance) { timeouts++; now += 31000; break; } // no responde: vence el turno
      const r = random();
      let act;
      if ((r < 0.15 || a.toCall > 2000) && !a.canCheck && random() < 0.8) act = { type: 'fold' };
      else if (r < 0.65) act = { type: a.canCheck ? 'check' : 'call' };
      else if (r < 0.9 && a.canRaise && a.currentBet < 200) act = { type: 'raise', amount: a.minRaiseTo + Math.floor(random() * 3) * 20 };
      else if (r < 0.915) act = { type: 'allin' };
      else act = { type: a.canCheck ? 'check' : 'call' };
      assert.strictEqual(game.apply(room, t, 'action', act, now), null, JSON.stringify(act));
      break;
    }
  }
  return { room, timeouts, showdowns, total };
}

test('partidas simuladas: las fichas cuadran, vencen turnos y hay showdowns', () => {
  let hands = 0, timeouts = 0, showdowns = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const r = playGame({ players: 2 + (seed % 5), seed });
    hands += r.room.handNo; timeouts += r.timeouts; showdowns += r.showdowns;
  }
  console.log(`  manos: ${hands}, showdowns: ${showdowns}, turnos vencidos: ${timeouts}`);
  assert(hands > 200 && showdowns > 30 && timeouts > 5);
});

test('no se puede jugar fuera de turno ni pasar ante una apuesta', () => {
  const now = 0;
  const room = game.createRoom('TEST', 'aaaaaaaa1', 'Ana', {}, now);
  game.apply(room, 'bbbbbbbb2', 'join', { name: 'Beto' }, now);
  game.apply(room, 'aaaaaaaa1', 'start', {}, now);
  const toAct = room.seats[room.hand.toAct].token;
  const other = toAct === 'aaaaaaaa1' ? 'bbbbbbbb2' : 'aaaaaaaa1';
  assert.strictEqual(game.apply(room, other, 'action', { type: 'call' }, now), 'No es tu turno.');
  assert.match(game.apply(room, toAct, 'action', { type: 'check' }, now), /No puedes pasar/);
  assert.strictEqual(game.apply(room, other, 'start', {}, now) === null, other === 'aaaaaaaa1');
});

test('si alguien se va en medio de la mano, se retira y sus fichas quedan en el bote', () => {
  let now = 0;
  const room = game.createRoom('TEST', 'aaaaaaaa1', 'Ana', { startChips: 1000 }, now);
  game.apply(room, 'bbbbbbbb2', 'join', { name: 'Beto' }, now);
  game.apply(room, 'cccccccc3', 'join', { name: 'Caro' }, now);
  game.apply(room, 'aaaaaaaa1', 'start', {}, now);
  const anaStack = room.seats.find((p) => p && p.token === 'aaaaaaaa1').chips; // lo que no apostó se va con ella
  game.apply(room, 'aaaaaaaa1', 'leave', {}, now); // el anfitrión se va
  assert.notStrictEqual(room.hostToken, 'aaaaaaaa1');
  const total = room.seats.filter(Boolean).reduce((a, p) => a + p.chips + p.total, 0);
  assert.strictEqual(total, 3000);
  assert(game.stateFor(room, 'aaaaaaaa1', now).gone);
  // los otros dos terminan la mano
  for (let i = 0; i < 50 && room.hand.stage !== 'showdown'; i++) {
    const t = room.seats[room.hand.toAct]?.token;
    if (t) game.apply(room, t, 'action', { type: 'call' }, now);
    now += 2000; game.tick(room, now);
  }
  const left = room.seats.filter(Boolean);
  assert.strictEqual(left.length, 2);
  assert.strictEqual(left.reduce((a, p) => a + p.chips, 0), 3000 - anaStack);
});
