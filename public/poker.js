// Motor de Texas Hold'em: mazo, evaluador de manos y reparto de botes.
(function (root) {
const RANKS = '23456789TJQKA';
const SUITS = ['S', 'H', 'D', 'C'];

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  // Fisher-Yates con aleatoriedad criptográfica
  for (let i = deck.length - 1; i > 0; i--) {
    const j = require('crypto').randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const rankVal = (c) => RANKS.indexOf(c[0]) + 2;

const HAND_NAMES = [
  'Carta alta', 'Par', 'Doble par', 'Trío', 'Escalera',
  'Color', 'Full', 'Póker', 'Escalera de color', 'Escalera real',
];

// Evalúa 5 cartas -> arreglo comparable [categoría, desempates...]
function eval5(cards) {
  const vals = cards.map(rankVal).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const uniq = [...new Set(vals)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals[0] === 14 && vals[1] === 5) straightHigh = 5; // A-2-3-4-5
  }
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([v, n]) => [n, +v])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const byGroup = groups.map((g) => g[1]);

  if (straightHigh && flush) return [straightHigh === 14 ? 9 : 8, straightHigh];
  if (groups[0][0] === 4) return [7, ...byGroup];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...byGroup];
  if (flush) return [5, ...vals];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, ...byGroup];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...byGroup];
  if (groups[0][0] === 2) return [1, ...byGroup];
  return [0, ...vals];
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Mejor mano de 5 entre 5-7 cartas
function bestHand(cards) {
  let best = null, bestCards = null;
  const combo = [];
  (function pick(start) {
    if (combo.length === 5) {
      const sc = eval5(combo);
      if (!best || compare(sc, best) > 0) { best = sc; bestCards = combo.slice(); }
      return;
    }
    for (let i = start; i < cards.length; i++) {
      combo.push(cards[i]); pick(i + 1); combo.pop();
    }
  })(0);
  return { score: best, name: HAND_NAMES[best[0]], cards: bestCards };
}

// Divide el dinero apostado en bote principal y botes secundarios.
// contributions: [{id, amount, folded}]
function buildPots(contributions) {
  const levels = [...new Set(contributions.filter((c) => !c.folded && c.amount > 0).map((c) => c.amount))]
    .sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const lvl of levels) {
    let amount = 0;
    for (const c of contributions) amount += Math.max(0, Math.min(c.amount, lvl) - prev);
    const eligible = contributions.filter((c) => !c.folded && c.amount >= lvl).map((c) => c.id);
    if (amount > 0) pots.push({ amount, eligible });
    prev = lvl;
  }
  // Fichas por encima del mayor nivel activo (apuesta no igualada de alguien que se retiró): al último bote
  let extra = 0;
  for (const c of contributions) extra += Math.max(0, c.amount - prev);
  if (extra && pots.length) pots[pots.length - 1].amount += extra;
  return pots;
}

const api = { newDeck, bestHand, compare, buildPots, HAND_NAMES };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Poker = api;
})(this);
