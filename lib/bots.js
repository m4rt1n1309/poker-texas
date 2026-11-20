// Jugadores automáticos. Calculan qué tan buena es su mano simulando cientos de finales
// posibles (sin ver las cartas de nadie), la comparan con lo que cuesta seguir, y a veces
// mienten: apuestan fuerte con nada (farol), se hacen los débiles con una mano enorme, y
// también cuentan cosas en el chat que pueden ser verdad... o no.
const { bestHand, compare } = require('../public/poker.js');

const RANKS = '23456789TJQKA';
const FULL_DECK = [];
for (const s of 'SHDC') for (const r of RANKS) FULL_DECK.push(r + s);

const NAMES = ['Tito', 'Rulo', 'Pocha', 'Chiqui', 'Turco', 'Pancho', 'Lula', 'Beto', 'Coca', 'Nacho', 'Mora', 'Pipo',
  'Cholo', 'Fito', 'Kuka', 'Lalo', 'Mimi', 'Negro', 'Pato', 'Quique', 'Rafa', 'Sole', 'Tota', 'Vicky', 'Yaya', 'Zulma',
  'Bocha', 'Chango', 'Dani', 'Fefa', 'Gringo', 'Juanchi', 'Lechu', 'Manu', 'Ñata', 'Pelusa', 'Ruso', 'Tano', 'Uma', 'Coco'];

const LEVELS = {
  // simulaciones, error al leer su mano, faroles, sigue mintiendo, se hace el débil, charla,
  // cuánto se fija en cómo juegan los rivales (0 = nada, 1 = todo)
  facil: { iters: 60, noise: 0.18, bluff: 0.04, barrel: 0.3, slowplay: 0.05, talk: 0.2, reads: 0, margin: -0.08, label: 'fácil' },
  normal: { iters: 150, noise: 0.08, bluff: 0.07, barrel: 0.45, slowplay: 0.12, talk: 0.3, reads: 0.5, margin: 0, label: 'normal' },
  dificil: { iters: 260, noise: 0.03, bluff: 0.1, barrel: 0.6, slowplay: 0.2, talk: 0.35, reads: 1, margin: 0, label: 'difícil' },
};

const TALK = {
  // lo dice cuando apuesta fuerte (con buena mano o mintiendo)
  bravo: ['Esta mano es mía 😎', 'Retirate mientras puedas', 'No me vas a pagar esto…', 'Hoy estoy con suerte 🍀',
    'Tengo lo que necesito', '¿Seguro que querés ver mis cartas?', 'Uff, qué linda mano me tocó',
    'Pagá si te animás 😏', 'Esto ya está cocinado 🍳', 'Yo que vos, me voy'],
  // lo dice para hacerse el débil (con buena mano, mintiendo; o con mano floja, de verdad)
  timido: ['Uff, no sé qué hacer…', 'Pago para ver, no tengo nada', 'Mmm, me la juego igual', 'Qué mano fea me tocó 😩',
    'Bueno, voy… pero no me tengo fe', 'Me parece que me ganan', 'Ay, no sé, no sé…', 'Voy de curioso nomás 🙈'],
  // gana sin mostrar después de un farol
  farol: ['Jaja, no tenía nada 🤫', '¿Querés ver mis cartas? Ni loco 😏', 'Mejor no pregunten qué tenía',
    'El que no arriesga no gana 😎', 'Qué fácil se asustan 😂', 'Esa fue con humo 💨'],
  // pierde en el showdown
  pierde: ['Ufa, casi', 'La próxima es mía', 'No puede ser… 😤', 'Bien jugado', '¿Quién mezcló estas cartas? 😒', 'Me robaron 😭'],
  // se sienta a la mesa
  saludo: ['¡Hola a todos! 👋', 'Vengo por sus fichas 😎', 'Buenas, ¿se juega por amor o por fichas? 😂', 'Prepárense…',
    'Hola, es mi primera vez jugando… 😇', '¡A jugar se ha dicho! 🃏'],
  // alguien va all-in
  allin: ['¡Uh, se puso picante! 🌶️', 'Ojo que viene con todo', '¿All-in? Mmm… sospechoso 🤨', 'Uy uy uy',
    'Esto se pone bueno 🍿', '¡Qué valiente!'],
  // gana un bote grande
  ganaGrande: ['¡Gracias por las fichas! 💰', 'Así se juega 😎', 'Vengan de a uno 💪', 'Hoy no me para nadie 🔥', 'Muy rico todo 😋'],
  // alguien lo nombra en el chat
  mencion: ['¿Qué querés, che? 😄', 'Yo solo vine a jugar 😇', 'No me distraigas que estoy pensando 🤔', 'Jaja, ya vas a ver',
    'Shh, concentración 🤫', '¿Me hablás a mí? 👀', 'Presente 🙋'],
  // lo acusan de mentir
  acusado: ['¿Yo? Jamás 😇', 'Yo nunca miento… casi nunca 😏', 'Mentir es una palabra fea. Prefiero "estrategia" 🧠',
    'Pagá y fijate 😎', 'Todos acá somos gente honesta 🙃', 'Eso es una calumnia 😤'],
  // charla suelta al empezar una mano
  charla: ['¿Alguien quiere un mate? 🧉', 'Qué linda noche para jugar al póker', 'Me siento con suerte hoy 🍀',
    'Esta mesa está muy tranquila…', 'Les aviso que soy invencible 😎', '¿Quién trajo las facturas? 🥐'],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// used: nombres que ya están en la sala (en el torneo, en todas las mesas)
function botName(room, used = new Set(room.seats.filter(Boolean).map((p) => p.name))) {
  const free = NAMES.filter((n) => !used.has(`🤖 ${n}`));
  if (free.length) return `🤖 ${pick(free)}`;
  for (let i = 2; ; i++) {
    const n = `🤖 ${pick(NAMES)} ${i}`;
    if (!used.has(n)) return n;
  }
}

// Probabilidad de ganar contra nOpp manos al azar (empates cuentan como parte del bote)
function equity(hole, board, nOpp, iters) {
  const known = new Set([...hole, ...board]);
  const rest = FULL_DECK.filter((c) => !known.has(c));
  const need = 2 * nOpp + (5 - board.length);
  let won = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (rest.length - i));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const full = board.concat(rest.slice(2 * nOpp, need));
    const mine = bestHand(hole.concat(full)).score;
    let ties = 1, lost = false;
    for (let o = 0; o < nOpp && !lost; o++) {
      const c = compare(bestHand([rest[2 * o], rest[2 * o + 1]].concat(full)).score, mine);
      if (c > 0) lost = true;
      else if (c === 0) ties++;
    }
    if (!lost) won += 1 / ties;
  }
  return won / iters;
}

// Decide la jugada. view = { cards, board, stage, pot, toCall, currentBet, minRaiseTo, maxRaiseTo,
// myBet, chips, opponents, bigBlind }. Devuelve { type, amount?, say? }.
function decide(level, view, memory) {
  const L = LEVELS[level] || LEVELS.normal;
  const nOpp = Math.max(1, Math.min(5, view.opponents));
  // fast: en las otras mesas del torneo calculan con menos precisión para no demorar la sala
  const eq = equity(view.cards, view.board, nOpp, view.fast ? Math.min(L.iters, 30) : L.iters);
  // fuerza de la mano: 0 = lo que le toca "en promedio" contra esa cantidad de rivales
  // (50% mano a mano, 25% contra tres), 1 = gana seguro, negativo = peor que el promedio
  const fair = 1 / (nOpp + 1);
  const str = (Math.max(0, Math.min(1, eq + (Math.random() * 2 - 1) * L.noise)) - fair) / (1 - fair);
  const potAfter = view.pot + view.toCall;
  const odds = view.toCall / (potAfter || 1);
  const r = Math.random();
  const headsUpBonus = nOpp === 1 ? 1.5 : nOpp === 2 ? 1 : 0.5; // se miente más contra pocos rivales
  const lateStreet = view.stage === 'turn' || view.stage === 'river';
  // Lectura de rivales: contra los que casi nunca se retiran no conviene mentir, y conviene
  // apostar más fuerte cuando tiene buena mano; contra los que se asustan, mentir rinde.
  const foldRate = view.opponentsFoldRate ?? 0.35;
  const lieFactor = 1 + L.reads * (Math.min(1.8, Math.max(0.15, foldRate / 0.35)) - 1);
  const valueExtra = L.reads * Math.max(0, 0.35 - foldRate) * 1.5;

  const raiseTo = (fraction) => {
    let to = view.currentBet + Math.max(view.minRaiseTo - view.currentBet, Math.round(fraction * potAfter));
    to = Math.round(to / view.bigBlind) * view.bigBlind || view.minRaiseTo;
    return Math.max(view.minRaiseTo, Math.min(view.maxRaiseTo, to));
  };
  const canRaise = view.maxRaiseTo > view.currentBet;
  const say = (kind) => (Math.random() < L.talk ? pick(TALK[kind]) : undefined);

  // --- nadie apostó todavía: pasar o apostar ---
  if (view.toCall === 0) {
    if (str > 0.25 && canRaise) {
      if (Math.random() < L.slowplay) return { type: 'check', say: say('timido') }; // se hace el débil
      return { type: 'raise', amount: raiseTo(0.45 + valueExtra + Math.random() * 0.5), say: say(Math.random() < 0.5 ? 'bravo' : 'timido') };
    }
    const keepLying = memory.bluffing && Math.random() < L.barrel * Math.min(1, lieFactor);
    const newBluff = Math.random() < L.bluff * lieFactor * headsUpBonus * (lateStreet ? 1.2 : 1) * (str > -0.15 ? 1.4 : 1);
    if (canRaise && (keepLying || newBluff)) {
      memory.bluffing = true; // farol: apuesta como si tuviera una gran mano
      return { type: 'raise', amount: raiseTo(0.5 + Math.random() * 0.4), say: say('bravo') };
    }
    return { type: 'check' };
  }

  // --- hay una apuesta: retirarse, igualar o subir ---
  const allInCall = view.toCall >= view.chips;
  if (str > 0.4 && canRaise && !allInCall) {
    if (Math.random() < L.slowplay) return { type: 'call', say: say('timido') }; // solo iguala para atrapar
    const shove = str > 0.65 && Math.random() < 0.3;
    return shove ? { type: 'allin', say: say('bravo') } : { type: 'raise', amount: raiseTo(0.6 + valueExtra + Math.random() * 0.6), say: say('bravo') };
  }
  if (memory.bluffing && view.toCall > view.pot * 0.4) {
    // le subieron mientras mentía: casi siempre abandona el farol
    if (Math.random() < 0.8) return { type: 'fold' };
  }
  const margin = L.margin;
  const cheap = view.toCall <= view.bigBlind && view.stage === 'preflop';
  if (eq >= odds + margin || cheap || (level === 'facil' && r < 0.25)) {
    // a veces re-sube de farol en lugar de solo igualar
    if (canRaise && !allInCall && !memory.bluffing && Math.random() < L.bluff * lieFactor * 0.5 * headsUpBonus && view.toCall < view.chips * 0.15) {
      memory.bluffing = true;
      return { type: 'raise', amount: raiseTo(0.8 + Math.random() * 0.5), say: say('bravo') };
    }
    return { type: 'call', say: str > 0.2 ? say('timido') : undefined };
  }
  // mano floja: a veces sube igual de farol si es barato intentarlo
  if (canRaise && !allInCall && Math.random() < L.bluff * lieFactor * 0.6 * headsUpBonus && view.toCall < view.chips * 0.1) {
    memory.bluffing = true;
    return { type: 'raise', amount: raiseTo(0.9 + Math.random() * 0.6), say: say('bravo') };
  }
  return { type: 'fold' };
}

module.exports = { decide, botName, LEVELS, TALK, pick, equity };
