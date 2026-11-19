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

test('se puede jugar solo contra bots: juegan, mienten a veces y las fichas cuadran', () => {
  let now = 0;
  const me = 'humano-0001';
  let room = game.createRoom('BOTS', me, 'Ana', { startChips: 5000, bigBlind: 20, turnTime: 30 }, now);
  for (const level of ['facil', 'normal', 'dificil']) assert.strictEqual(game.apply(room, me, 'addBot', { level }, now), null);
  game.apply(room, 'humano-0002', 'join', { name: 'Beto' }, now);
  assert.strictEqual(game.apply(room, 'humano-0002', 'addBot', {}, now), 'Solo el anfitrión puede agregar bots.');
  game.apply(room, 'humano-0002', 'leave', {}, now);
  assert.strictEqual(game.apply(room, me, 'start', {}, now), null);

  let bluffs = 0, botActions = 0, raises = 0;
  const seenBluff = new Set();
  for (let step = 0; step < 6000 && room.handNo < 40 && room.running; step++) {
    now += 700;
    room = roundtrip(room);
    game.tick(room, now);
    game.touch(room, me, now);
    const total = room.seats.filter(Boolean).reduce((a, p) => a + p.chips + (room.hand && room.hand.stage !== 'showdown' ? p.total : 0), 0);
    assert.strictEqual(total, 20000, `fichas en paso ${step}`);
    for (const p of room.seats) {
      if (p && p.bot && p.botMemory && p.botMemory.bluffing && !seenBluff.has(room.handNo + p.token)) { seenBluff.add(room.handNo + p.token); bluffs++; }
      if (p && p.bot && /Sube|Apuesta|All-in/.test(p.lastAction || '')) raises++;
      if (p && p.bot && p.lastAction) botActions++;
    }
    const st = game.stateFor(room, me, now);
    if (st.actions) game.apply(room, me, 'action', { type: st.actions.canCheck ? 'check' : 'call' }, now);
  }
  const botChat = room.chat.filter((m) => !m.system && m.from.startsWith('🤖'));
  console.log(`  manos: ${room.handNo}, faroles: ${bluffs}, mensajes de bots: ${botChat.length}`);
  assert(room.handNo >= 8, 'se jugaron manos');
  assert(bluffs > 0, 'los bots mintieron al menos una vez');
  assert(raises > 0 && botActions > 0);
  assert.strictEqual(room.hostToken, me, 'el anfitrión sigue siendo la persona');
  const st = game.stateFor(room, me, now);
  assert(st.seats.filter((s) => s && s.bot).every((s) => s.connected), 'los bots siempre están conectados');
});

test('si la única persona se va, la sala queda vacía aunque haya bots', () => {
  const room = game.createRoom('BOTS', 'humano-0001', 'Ana', {}, 0);
  game.apply(room, 'humano-0001', 'addBot', { level: 'facil' }, 0);
  assert(!game.isEmpty(room));
  game.apply(room, 'humano-0001', 'leave', {}, 0);
  assert(game.isEmpty(room));
});

test('ranking: la suma de ganancias y pérdidas da cero, aunque alguien se vaya o reciba fichas', () => {
  let now = 0;
  let room = game.createRoom('RANK', 'humano-0001', 'Ana', { startChips: 1000, bigBlind: 20, botSpeed: 'rapida' }, now);
  game.apply(room, 'humano-0002', 'join', { name: 'Beto' }, now);
  game.apply(room, 'humano-0001', 'addBot', { level: 'dificil' }, now);
  game.apply(room, 'humano-0001', 'chips', { seat: 1, amount: 500 }, now); // el anfitrión le da 500 a Beto
  game.apply(room, 'humano-0001', 'start', {}, now);
  for (let step = 0; step < 400 && room.handNo < 12 && room.running; step++) {
    now += 1000;
    room = roundtrip(room);
    game.tick(room, now);
    for (const t of ['humano-0001', 'humano-0002']) {
      game.touch(room, t, now);
      const st = game.stateFor(room, t, now);
      if (st.actions) game.apply(room, t, 'action', { type: st.actions.canCheck ? 'check' : 'call' }, now);
    }
    if (room.handNo === 6 && !room.seats.some((p) => p && p.token === 'humano-0002' && p.leaving)) {
      game.apply(room, 'humano-0002', 'leave', {}, now); // Beto se va a mitad de la partida
    }
  }
  const ranking = game.stateFor(room, 'humano-0001', now).ranking;
  assert.strictEqual(ranking.length, 3);
  assert.strictEqual(ranking.reduce((a, r) => a + r.net, 0), 0, JSON.stringify(ranking));
  assert(ranking.some((r) => r.name === 'Beto' && !r.here), 'Beto sigue en el ranking aunque se fue');
  assert(ranking.reduce((a, r) => a + r.handsWon, 0) >= room.handNo - 1);
  assert(ranking[0].net >= ranking[2].net, 'ordenado de mayor a menor');
});

test('los bots contestan en el chat (un rato después) si los nombran o los acusan de mentir', () => {
  let now = 0;
  const room = game.createRoom('CHAT', 'humano-0001', 'Ana', {}, now);
  game.apply(room, 'humano-0001', 'addBot', { level: 'normal' }, now);
  const bot = room.seats.find((p) => p && p.bot);
  const bare = bot.name.replace('🤖', '').trim();
  let replies = 0;
  for (let i = 0; i < 20; i++) {
    const before = room.chat.length;
    game.apply(room, 'humano-0001', 'chat', { text: i % 2 ? `che ${bare.toLowerCase()}, ¿qué tenés?` : 'sos un mentiroso' }, now);
    assert.strictEqual(room.chat.length, before + 1, 'no contesta al instante');
    now += 4000;
    game.tick(room, now);
    replies += room.chat.slice(before + 1).filter((m) => m.from === bot.name).length;
  }
  assert(replies >= 10, `contestó ${replies} de 20`);
});

test('velocidad de los bots: lenta tarda más que rápida', () => {
  const thinkTime = (speed) => {
    const room = game.createRoom('VELO', 'humano-0001', 'Ana', { botSpeed: speed }, 0);
    game.apply(room, 'humano-0001', 'addBot', {}, 0);
    game.apply(room, 'humano-0001', 'start', {}, 0);
    if (room.seats[room.hand.toAct].bot) return room.hand.botAt;
    game.apply(room, 'humano-0001', 'action', { type: 'call' }, 0);
    return room.hand.botAt;
  };
  assert(thinkTime('lenta') >= 3500 && thinkTime('rapida') <= 1500);
  assert.strictEqual(game.stateFor(game.createRoom('X', 'humano-0001', 'A', { botSpeed: 'cualquiera' }, 0), 'humano-0001', 0).settings.botSpeed, 'normal');
});
