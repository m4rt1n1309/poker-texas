// Reglas de la mesa de Texas Hold'em, sin servidor: la sala es un objeto JSON que se guarda
// en Redis. Todas las funciones reciben "now" (milisegundos): el tiempo avanza cada vez que
// alguien consulta la sala (tick), así funcionan el temporizador y la pausa entre manos.
const { newDeck, bestHand, compare, buildPots } = require('../public/poker.js');
const bots = require('./bots');

const MAX_SEATS = 9;
const config = {
  nextHandDelay: 6000, // pausa para ver el resultado antes de la mano siguiente
  runoutDelay: 1500, // pausa entre calles cuando todos están all-in
  offlineAfter: 20000, // sin consultar la sala por este tiempo = desconectado
  offlineTurn: 5000, // tiempo de turno para un jugador desconectado
};

// ---------- utilidades ----------
const clampInt = (v, min, max, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

// cuánto "piensa" un bot antes de jugar (milisegundos, mínimo y máximo)
const BOT_SPEEDS = { lenta: [3500, 5500], normal: [2000, 3500], rapida: [800, 1500] };

function parseSettings(s = {}, base = {}) {
  const bb = clampInt(s.bigBlind ?? base.bigBlind, 2, 100000, 20);
  return {
    startChips: clampInt(s.startChips ?? base.startChips, 10, 10000000, 1000),
    bigBlind: bb,
    smallBlind: Math.max(1, Math.floor(bb / 2)),
    turnTime: clampInt(s.turnTime ?? base.turnTime, 0, 300, 30), // 0 = sin límite
    botSpeed: BOT_SPEEDS[s.botSpeed] ? s.botSpeed : BOT_SPEEDS[base.botSpeed] ? base.botSpeed : 'normal',
  };
}

const seatList = (room) => room.seats.filter(Boolean);
const isOnline = (p, now) => p.bot || now - p.lastSeen < config.offlineAfter;
const findPlayer = (room, token) => seatList(room).find((p) => p.token === token) || null;

function nextSeat(room, from, pred) {
  for (let i = 1; i <= MAX_SEATS; i++) {
    const s = (((from + i) % MAX_SEATS) + MAX_SEATS) % MAX_SEATS;
    const p = room.seats[s];
    if (p && pred(p)) return s;
  }
  return -1;
}

function addChat(room, from, text, system = false) {
  room.chatId = (room.chatId || 0) + 1;
  room.chat.push({ id: room.chatId, from, text, system });
  if (room.chat.length > 60) room.chat.shift();
}

// Un mensaje de chat que aparece más tarde (para que los bots no contesten al instante)
function sayLater(room, from, text, now, delay) {
  room.pending = room.pending || [];
  room.pending.push({ at: now + delay, from, text });
}

// Estadísticas de cada jugador para el ranking de la sala (se guardan aunque se vaya)
function stat(room, p) {
  room.stats = room.stats || {};
  const s = room.stats[p.token] || (room.stats[p.token] = {
    name: p.name, bot: !!p.bot, buyIn: 0, handsWon: 0, played: 0, biggestPot: 0, best: null, left: null,
  });
  s.name = p.name;
  return s;
}

function rankingFor(room, token) {
  const h = room.hand;
  const live = h && h.stage !== 'showdown';
  return Object.entries(room.stats || {}).map(([t, s]) => {
    const p = findPlayer(room, t);
    const here = !!(p && !p.leaving);
    const chips = here ? p.chips + (live && p.inHand ? p.total : 0) : s.left || 0;
    return {
      name: s.name, bot: s.bot, isYou: t === token, here, chips, net: chips - s.buyIn,
      handsWon: s.handsWon, played: s.played, biggestPot: s.biggestPot, best: s.best ? s.best.name : null,
    };
  }).sort((a, b) => b.net - a.net || b.handsWon - a.handsWon);
}

// ---------- sala ----------
function createRoom(code, token, name, settings, now) {
  const room = {
    code,
    hostToken: token,
    settings: parseSettings(settings),
    seats: Array(MAX_SEATS).fill(null),
    hand: null,
    dealerSeat: -1,
    handNo: 0,
    chat: [],
    chatId: 0,
    running: false,
    nextHandAt: null,
  };
  join(room, token, name, now);
  return room;
}

function join(room, token, name, now) {
  let p = findPlayer(room, token);
  if (!p) {
    if (!name) return 'Escribe tu nombre.';
    const seat = room.seats.findIndex((s) => !s);
    if (seat < 0) return 'La sala está llena (máximo 9 jugadores).';
    p = {
      token, name, seat, chips: room.settings.startChips,
      cards: [], inHand: false, folded: false, allIn: false, bet: 0, total: 0,
      lastAction: null, lastSeen: now, leaving: false, showdown: null, won: 0,
    };
    room.seats[seat] = p;
    const st = stat(room, p);
    st.buyIn += room.settings.startChips; // si vuelve a entrar después de irse, es una nueva compra
    st.left = null;
    if (!room.hostToken || !findPlayer(room, room.hostToken)) room.hostToken = token;
    addChat(room, null, `${name} se unió a la mesa.`, true);
  } else {
    if (name) p.name = name;
    if (p.leaving) { p.leaving = false; addChat(room, null, `${p.name} volvió a la mesa.`, true); }
    p.lastSeen = now;
  }
  return null;
}

// ---------- lo que ve cada jugador ----------
function stateFor(room, token, now) {
  const me = findPlayer(room, token);
  if (!me || me.leaving) return { gone: true };
  const h = room.hand;
  const showCards = h && h.stage === 'showdown';
  const seats = room.seats.map((p, i) => {
    if (!p || p.leaving) return null;
    const reveal = p.token === token || (showCards && p.inHand && !p.folded && p.showdown);
    return {
      seat: i,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      inHand: p.inHand,
      folded: p.folded,
      allIn: p.allIn,
      connected: isOnline(p, now),
      isHost: p.token === room.hostToken,
      isYou: p.token === token,
      bot: p.bot ? bots.LEVELS[p.bot].label : null,
      thinking: !!(p.bot && h && h.stage !== 'showdown' && h.toAct === i),
      lastAction: p.lastAction,
      cards: p.inHand ? (reveal ? p.cards : p.cards.map(() => null)) : [],
      handName: showCards && p.showdown ? p.showdown.name : null,
      bestCards: showCards && p.showdown ? p.showdown.cards : null,
      won: p.won || 0,
    };
  });

  const st = {
    code: room.code,
    settings: room.settings,
    isHost: token === room.hostToken,
    running: room.running,
    handNo: room.handNo,
    yourSeat: me.seat,
    seats,
    stage: h ? h.stage : 'waiting',
    board: h ? h.board : [],
    pot: h ? h.seats.reduce((a, s) => a + room.seats[s].total, 0) : 0,
    dealerSeat: room.dealerSeat,
    sbSeat: h ? h.sbSeat : -1,
    bbSeat: h ? h.bbSeat : -1,
    toActSeat: h && h.stage !== 'showdown' ? h.toAct : -1,
    turnRemaining: h && h.deadline && h.stage !== 'showdown' ? Math.max(0, h.deadline - now) : null,
    turnTotal: h && h.turnTotal ? h.turnTotal : room.settings.turnTime * 1000,
    results: h && h.results ? h.results : null,
    chat: room.chat,
    ranking: rankingFor(room, token),
  };

  if (h && h.toAct === me.seat && h.stage !== 'showdown') {
    const toCall = Math.min(h.currentBet - me.bet, me.chips);
    const maxTo = me.bet + me.chips;
    st.actions = {
      canCheck: me.bet >= h.currentBet,
      currentBet: h.currentBet,
      myBet: me.bet,
      toCall,
      minRaiseTo: Math.min(h.currentBet + h.minRaise, maxTo),
      maxRaiseTo: maxTo,
      canRaise: maxTo > h.currentBet,
    };
  }
  return st;
}

// ---------- la mano ----------
const canPlay = (p) => p.chips > 0 && !p.leaving;
const handPlayers = (room) => room.hand.seats.map((s) => room.seats[s]);
const needs = {
  has: (h, t) => h.needs.includes(t),
  add: (h, t) => { if (!h.needs.includes(t)) h.needs.push(t); },
  del: (h, t) => { h.needs = h.needs.filter((x) => x !== t); },
};

function postBet(p, amount) {
  const a = Math.min(amount, p.chips);
  p.chips -= a;
  p.bet += a;
  p.total += a;
  if (p.chips === 0) p.allIn = true;
  return a;
}

function startHand(room, now) {
  room.nextHandAt = null;
  const eligible = seatList(room).filter(canPlay);
  if (eligible.length < 2) {
    room.hand = null;
    room.running = false;
    addChat(room, null, 'Se necesitan al menos 2 jugadores con fichas para continuar.', true);
    return;
  }

  room.handNo++;
  room.dealerSeat = nextSeat(room, room.dealerSeat, canPlay);
  const deck = newDeck();
  for (const p of seatList(room)) {
    Object.assign(p, {
      inHand: canPlay(p), cards: [], folded: false, allIn: false,
      bet: 0, total: 0, lastAction: null, showdown: null, won: 0,
    });
    if (p.bot) p.botMemory = {};
  }
  const players = seatList(room).filter((p) => p.inHand);
  for (const p of players) stat(room, p).played++;
  // de vez en cuando un bot charla al empezar la mano
  const chatty = players.filter((p) => p.bot);
  if (chatty.length && Math.random() < 0.04) sayLater(room, bots.pick(chatty).name, bots.pick(bots.TALK.charla), now, 2500);
  for (let r = 0; r < 2; r++) for (const p of players) p.cards.push(deck.pop());

  const inHand = (p) => p.inHand;
  const sbSeat = players.length === 2 ? room.dealerSeat : nextSeat(room, room.dealerSeat, inHand);
  const bbSeat = nextSeat(room, sbSeat, inHand);

  const h = {
    deck, board: [], stage: 'preflop',
    seats: players.map((p) => p.seat),
    sbSeat, bbSeat,
    currentBet: room.settings.bigBlind,
    minRaise: room.settings.bigBlind,
    needs: [], toAct: -1, deadline: null, turnTotal: null, runoutAt: null, results: null,
  };
  room.hand = h;

  postBet(room.seats[sbSeat], room.settings.smallBlind);
  room.seats[sbSeat].lastAction = 'Ciega chica';
  postBet(room.seats[bbSeat], room.settings.bigBlind);
  room.seats[bbSeat].lastAction = 'Ciega grande';

  for (const p of players) if (!p.allIn) needs.add(h, p.token);
  setTurn(room, nextSeat(room, bbSeat, (p) => needs.has(h, p.token)), now);
}

function setTurn(room, seat, now) {
  const h = room.hand;
  if (seat < 0) return advance(room, now);
  h.toAct = seat;
  const p = room.seats[seat];
  if (p.bot) {
    const [min, max] = BOT_SPEEDS[room.settings.botSpeed] || BOT_SPEEDS.normal;
    h.botAt = now + min + Math.random() * (max - min); // "piensa" antes de jugar
    h.deadline = null;
    h.turnTotal = null;
    return;
  }
  h.botAt = null;
  const t = isOnline(p, now) ? room.settings.turnTime * 1000 : config.offlineTurn;
  h.deadline = t > 0 ? now + t : null;
  h.turnTotal = t > 0 ? t : null;
}

function act(room, token, { type, amount }, now) {
  const h = room.hand;
  if (!h || h.stage === 'showdown') return 'No hay una mano en juego.';
  const p = findPlayer(room, token);
  if (!p || p.seat !== h.toAct) return 'No es tu turno.';

  const toCall = h.currentBet - p.bet;
  if (toCall > 0 && ['fold', 'call', 'raise', 'allin'].includes(type)) {
    p.stats = p.stats || { faced: 0, folded: 0 };
    p.stats.faced++;
    if (type === 'fold') p.stats.folded++;
  }
  if (type === 'allin') {
    type = p.bet + p.chips > h.currentBet ? 'raise' : 'call';
    amount = p.bet + p.chips;
  }

  switch (type) {
    case 'fold':
      p.folded = true;
      p.lastAction = 'Se retira';
      break;
    case 'check':
      if (toCall > 0) return 'No puedes pasar, hay una apuesta.';
      p.lastAction = 'Pasa';
      break;
    case 'call': {
      if (toCall <= 0) { p.lastAction = 'Pasa'; break; }
      const paid = postBet(p, toCall);
      p.lastAction = p.allIn ? `All-in ${p.bet}` : `Iguala ${paid}`;
      break;
    }
    case 'raise': {
      const maxTo = p.bet + p.chips;
      const target = clampInt(amount, 0, maxTo, maxTo);
      if (target <= h.currentBet) return 'La subida debe superar la apuesta actual.';
      const raiseSize = target - h.currentBet;
      if (raiseSize < h.minRaise && target < maxTo) return `La subida mínima es a ${h.currentBet + h.minRaise}.`;
      const wasBet = h.currentBet === 0;
      postBet(p, target - p.bet);
      for (const o of handPlayers(room)) {
        if (o === p || o.folded || o.allIn) continue;
        // subida completa: todos vuelven a actuar; all-in corto: solo quienes no igualaron
        if (raiseSize >= h.minRaise || o.bet < target) needs.add(h, o.token);
      }
      if (raiseSize >= h.minRaise) h.minRaise = raiseSize;
      h.currentBet = target;
      p.lastAction = p.allIn ? `All-in ${p.bet}` : `${wasBet ? 'Apuesta' : 'Sube a'} ${p.bet}`;
      break;
    }
    default:
      return 'Acción desconocida.';
  }
  needs.del(h, p.token);
  if (p.allIn && /^All-in/.test(p.lastAction)) {
    const others = seatList(room).filter((o) => o.bot && o !== p);
    if (others.length && Math.random() < 0.35) sayLater(room, bots.pick(others).name, bots.pick(bots.TALK.allin), now, 1200 + Math.random() * 1000);
  }
  setTurn(room, nextSeat(room, p.seat, (o) => needs.has(h, o.token)), now);
  return null;
}

// Nadie más tiene que actuar en esta calle: se pasa a la siguiente (o se termina la mano)
function advance(room, now) {
  const h = room.hand;
  h.deadline = null;
  h.turnTotal = null;
  h.botAt = null;
  h.toAct = -1;

  const alive = handPlayers(room).filter((p) => !p.folded);
  if (alive.length === 1) return winUncontested(room, alive[0], now);

  for (const p of handPlayers(room)) p.bet = 0;
  h.currentBet = 0;
  h.minRaise = room.settings.bigBlind;

  if (h.stage === 'river') return showdown(room, now);
  dealStreet(h);
  for (const p of alive) if (!p.allIn) p.lastAction = null;

  const canAct = alive.filter((p) => !p.allIn);
  if (canAct.length <= 1) {
    // todos (o todos menos uno) están all-in: se dan vuelta las cartas de a poco
    h.runoutAt = now + config.runoutDelay;
    return;
  }
  for (const p of canAct) needs.add(h, p.token);
  setTurn(room, nextSeat(room, room.dealerSeat, (o) => needs.has(h, o.token)), now);
}

function dealStreet(h) {
  h.deck.pop(); // carta quemada
  if (h.stage === 'preflop') { h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop()); h.stage = 'flop'; }
  else if (h.stage === 'flop') { h.board.push(h.deck.pop()); h.stage = 'turn'; }
  else if (h.stage === 'turn') { h.board.push(h.deck.pop()); h.stage = 'river'; }
}

function winUncontested(room, winner, now) {
  const h = room.hand;
  const pot = handPlayers(room).reduce((a, p) => a + p.total, 0);
  winner.chips += pot;
  winner.won = pot;
  const ws = stat(room, winner);
  ws.handsWon++;
  ws.biggestPot = Math.max(ws.biggestPot, pot);
  for (const p of handPlayers(room)) p.bet = 0;
  h.stage = 'showdown';
  h.results = [{ name: winner.name, amount: pot, hand: null }];
  addChat(room, null, `🏆 ${winner.name} gana ${pot} (los demás se retiraron).`, true);
  if (winner.bot && winner.botMemory && winner.botMemory.bluffing && Math.random() < 0.5) {
    addChat(room, winner.name, bots.pick(bots.TALK.farol));
  }
  finishHand(room, now);
}

function showdown(room, now) {
  const h = room.hand;
  while (h.board.length < 5) h.board.push(h.deck.pop());
  h.stage = 'showdown';
  const players = handPlayers(room);
  const alive = players.filter((p) => !p.folded);
  for (const p of alive) {
    p.showdown = bestHand([...p.cards, ...h.board]);
    const st = stat(room, p);
    if (!st.best || compare(p.showdown.score, st.best.score) > 0) st.best = { name: p.showdown.name, score: p.showdown.score };
  }

  const pots = buildPots(players.map((p) => ({ id: p.token, amount: p.total, folded: p.folded })));
  const totals = new Map();
  const fromDealer = (p) => (p.seat - room.dealerSeat + MAX_SEATS) % MAX_SEATS;
  pots.forEach((pot, idx) => {
    let best = [];
    for (const p of alive.filter((a) => pot.eligible.includes(a.token))) {
      const c = best.length ? compare(p.showdown.score, best[0].showdown.score) : 1;
      if (c > 0) best = [p];
      else if (c === 0) best.push(p);
    }
    best.sort((a, b) => fromDealer(a) - fromDealer(b)); // fichas sobrantes: al primero desde el repartidor
    const share = Math.floor(pot.amount / best.length);
    let rest = pot.amount - share * best.length;
    for (const w of best) {
      const amt = share + (rest-- > 0 ? 1 : 0);
      w.chips += amt;
      w.won += amt;
      totals.set(w, (totals.get(w) || 0) + amt);
    }
    if (pots.length > 1) {
      const label = idx === 0 ? 'Bote principal' : `Bote secundario ${idx}`;
      addChat(room, null, `${label} (${pot.amount}): ${best.map((w) => w.name).join(', ')}`, true);
    }
  });

  for (const [w, amount] of totals) {
    const st = stat(room, w);
    st.handsWon++;
    st.biggestPot = Math.max(st.biggestPot, amount);
    if (w.bot && amount >= room.settings.bigBlind * 15 && Math.random() < 0.5) {
      sayLater(room, w.name, bots.pick(bots.TALK.ganaGrande), now, 1500);
    }
  }
  h.results = [...totals.entries()].map(([p, amount]) => ({ name: p.name, amount, hand: p.showdown.name }));
  for (const r of h.results) addChat(room, null, `🏆 ${r.name} gana ${r.amount} con ${r.hand}.`, true);
  const sadBot = alive.find((p) => p.bot && !p.won);
  if (sadBot && Math.random() < 0.2) addChat(room, sadBot.name, bots.pick(bots.TALK.pierde));
  finishHand(room, now);
}

function finishHand(room, now) {
  const h = room.hand;
  h.toAct = -1;
  h.deadline = null;
  h.botAt = null;
  h.runoutAt = null;
  h.deck = [];
  for (const p of handPlayers(room)) if (p.chips === 0) addChat(room, null, `${p.name} se quedó sin fichas.`, true);
  for (const p of seatList(room)) if (p.leaving) removePlayer(room, p);
  // quienes se fueron ya no están en los asientos: la mano terminada solo guarda los que siguen
  h.seats = h.seats.filter((s) => room.seats[s]);
  room.nextHandAt = now + config.nextHandDelay;
}

function removePlayer(room, p) {
  stat(room, p).left = p.chips;
  room.seats[p.seat] = null;
  if (room.hostToken === p.token) reassignHost(room, p);
}

// El anfitrión pasa al jugador que estuvo activo más recientemente
function reassignHost(room, leaving) {
  const next = seatList(room).filter((o) => o !== leaving && !o.leaving && !o.bot).sort((a, b) => b.lastSeen - a.lastSeen)[0];
  room.hostToken = next ? next.token : null;
  if (next) addChat(room, null, `${next.name} es ahora el anfitrión.`, true);
}

// Se va un jugador (o lo saca el anfitrión). Si está jugando una mano, primero se retira.
function leave(room, token, now) {
  const p = findPlayer(room, token);
  if (!p || p.leaving) return;
  addChat(room, null, `${p.name} salió de la sala.`, true);
  const h = room.hand;
  const playing = h && h.stage !== 'showdown' && p.inHand;
  if (!playing) return removePlayer(room, p);

  p.leaving = true; // se quita del asiento al terminar la mano (sus fichas apostadas siguen en el bote)
  if (room.hostToken === p.token) reassignHost(room, p);
  if (p.folded) return;
  if (h.toAct === p.seat) return void act(room, token, { type: 'fold' }, now);
  p.folded = true;
  p.lastAction = 'Se retira';
  needs.del(h, p.token);
  if (handPlayers(room).filter((o) => !o.folded).length === 1) advance(room, now);
}

// ---------- bots ----------
function addBot(room, level, now) {
  if (!bots.LEVELS[level]) level = 'normal';
  const seat = room.seats.findIndex((s) => !s);
  if (seat < 0) return 'La mesa está llena (máximo 9 jugadores).';
  const p = {
    token: 'bot-' + require('crypto').randomBytes(8).toString('hex'),
    name: bots.botName(room), seat, chips: room.settings.startChips, bot: level, botMemory: {},
    cards: [], inHand: false, folded: false, allIn: false, bet: 0, total: 0,
    lastAction: null, lastSeen: now, leaving: false, showdown: null, won: 0,
  };
  room.seats[seat] = p;
  stat(room, p).buyIn += room.settings.startChips;
  addChat(room, null, `${p.name} se sentó a la mesa (bot ${bots.LEVELS[level].label}).`, true);
  if (Math.random() < 0.6) sayLater(room, p.name, bots.pick(bots.TALK.saludo), now, 1000 + Math.random() * 1500);
  return null;
}

function botPlays(room, now) {
  const h = room.hand;
  const p = room.seats[h.toAct];
  h.botAt = null;
  const view = {
    cards: p.cards,
    board: h.board,
    stage: h.stage,
    pot: handPlayers(room).reduce((a, o) => a + o.total, 0),
    toCall: Math.min(h.currentBet - p.bet, p.chips),
    currentBet: h.currentBet,
    myBet: p.bet,
    chips: p.chips,
    minRaiseTo: Math.min(h.currentBet + h.minRaise, p.bet + p.chips),
    maxRaiseTo: p.bet + p.chips,
    opponents: handPlayers(room).filter((o) => o !== p && !o.folded).length,
    // qué tan seguido se retiran los rivales que siguen en la mano (con un valor inicial prudente)
    opponentsFoldRate: (() => {
      const rivals = handPlayers(room).filter((o) => o !== p && !o.folded && !o.allIn);
      if (!rivals.length) return 0.35;
      return rivals.reduce((a, o) => a + ((o.stats ? o.stats.folded : 0) + 1) / ((o.stats ? o.stats.faced : 0) + 3), 0) / rivals.length;
    })(),
    bigBlind: room.settings.bigBlind,
  };
  let d;
  try { d = bots.decide(p.bot, view, p.botMemory || (p.botMemory = {})); } catch { d = { type: 'fold' }; }
  if (d.say) addChat(room, p.name, d.say);
  // si la jugada no vale (no debería pasar), pasa o se retira
  if (act(room, p.token, d, now)) act(room, p.token, { type: view.toCall > 0 ? 'fold' : 'check' }, now);
}

function botReply(room, text, now) {
  const seated = seatList(room).filter((o) => o.bot && !o.leaving);
  if (!seated.length) return;
  const lower = text.toLowerCase();
  const named = seated.find((o) => lower.includes(o.name.replace('🤖', '').trim().toLowerCase()));
  const accused = /mient|mentir|farol|tramp|bluff|chamuy/.test(lower);
  if (accused && Math.random() < 0.8) {
    sayLater(room, (named || bots.pick(seated)).name, bots.pick(bots.TALK.acusado), now, 1500 + Math.random() * 1500);
  } else if (named && Math.random() < 0.85) {
    sayLater(room, named.name, bots.pick(bots.TALK.mencion), now, 1500 + Math.random() * 1500);
  }
}

// ---------- el paso del tiempo ----------
// Se llama en cada consulta: aplica lo que tenía que pasar (turnos vencidos, cartas de un
// all-in, mano siguiente). Devuelve true si cambió algo.
function tick(room, now) {
  let changed = false;
  for (let guard = 0; guard < 200; guard++) {
    const h = room.hand;
    const live = h && h.stage !== 'showdown';
    if (live && h.runoutAt && now >= h.runoutAt) {
      h.runoutAt = null;
      advance(room, now);
    } else if (live && h.toAct >= 0 && h.botAt && now >= h.botAt) {
      botPlays(room, now);
    } else if (live && h.toAct >= 0 && h.deadline && now >= h.deadline) {
      const p = room.seats[h.toAct];
      const action = p.bet >= h.currentBet ? 'check' : 'fold';
      addChat(room, null, `⏰ ${p.name} se quedó sin tiempo (${action === 'check' ? 'pasa' : 'se retira'}).`, true);
      act(room, p.token, { type: action }, now);
    } else if (room.nextHandAt && now >= room.nextHandAt) {
      room.nextHandAt = null;
      if (room.running) startHand(room, now);
    } else {
      break;
    }
    changed = true;
  }
  if (room.pending && room.pending.length && room.pending.some((m) => now >= m.at)) {
    for (const m of room.pending.filter((x) => now >= x.at).sort((a, b) => a.at - b.at)) addChat(room, m.from, m.text);
    room.pending = room.pending.filter((x) => now < x.at);
    changed = true;
  }
  return changed;
}

// ---------- acciones que llegan de los jugadores ----------
// Devuelve un mensaje de error o null.
function apply(room, token, op, data, now) {
  const p = findPlayer(room, token);
  if (op === 'join') return join(room, token, cleanText(data.name, 16), now);
  if (!p || p.leaving) return 'Ya no estás en esta sala.';
  p.lastSeen = now;
  const isHost = room.hostToken === token;
  const target = () => {
    const t = room.seats[clampInt(data.seat, 0, MAX_SEATS - 1, -1)];
    return t && !t.leaving ? t : null;
  };

  switch (op) {
    case 'action':
      return act(room, token, { type: data.type, amount: data.amount }, now);
    case 'chat': {
      const text = cleanText(data.text, 200);
      if (!text) return null;
      addChat(room, p.name, text);
      botReply(room, text, now);
      return null;
    }
    case 'leave':
      leave(room, token, now);
      return null;
    case 'start':
      if (!isHost) return 'Solo el anfitrión puede empezar.';
      room.running = true;
      if ((!room.hand || room.hand.stage === 'showdown') && !room.nextHandAt) startHand(room, now);
      return null;
    case 'pause':
      if (!isHost) return 'Solo el anfitrión puede pausar.';
      room.running = false;
      addChat(room, null, 'El anfitrión pausó el juego (termina la mano actual).', true);
      return null;
    case 'chips': {
      if (!isHost) return 'Solo el anfitrión puede dar fichas.';
      const t = target();
      const amount = clampInt(data.amount, -10000000, 10000000, 0);
      if (!t || !amount) return null;
      const applied = Math.max(amount, -t.chips);
      t.chips += applied;
      stat(room, t).buyIn += applied;
      addChat(room, null, `El anfitrión ${applied > 0 ? 'dio' : 'quitó'} ${Math.abs(applied)} fichas a ${t.name}.`, true);
      return null;
    }
    case 'addBot':
      if (!isHost) return 'Solo el anfitrión puede agregar bots.';
      return addBot(room, data.level, now);
    case 'kick': {
      if (!isHost) return 'Solo el anfitrión puede sacar jugadores.';
      const t = target();
      if (t && t !== p) leave(room, t.token, now);
      return null;
    }
    case 'settings': {
      if (!isHost) return 'Solo el anfitrión puede cambiar las reglas.';
      room.settings = parseSettings(data, room.settings);
      const s = room.settings;
      const speed = { lenta: 'lentos', normal: 'a velocidad normal', rapida: 'rápidos' }[s.botSpeed];
      addChat(room, null, `Nuevas reglas: ciegas ${s.smallBlind}/${s.bigBlind}, ${s.turnTime ? s.turnTime + ' s por turno' : 'sin límite de tiempo'}, bots ${speed} (desde la próxima mano).`, true);
      return null;
    }
    default:
      return 'Operación desconocida.';
  }
}

// Marca que el jugador sigue conectado (sin escribir en cada consulta)
function touch(room, token, now) {
  const p = findPlayer(room, token);
  if (p && now - p.lastSeen > 8000) { p.lastSeen = now; return true; }
  return false;
}

const isEmpty = (room) => seatList(room).every((p) => p.leaving || p.bot);

module.exports = { config, createRoom, apply, tick, touch, stateFor, isEmpty, cleanText, MAX_SEATS };
