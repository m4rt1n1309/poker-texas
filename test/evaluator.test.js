const assert = require('assert');
const { bestHand, compare, buildPots } = require('../public/poker');
const H = (s) => bestHand(s.split(' '));
const cases = [
  ['AS KS QS JS TS 2D 3C', 'Escalera real'],
  ['9S KS QS JS TS 2D 3C', 'Escalera de color'],
  ['AS AD AH AC TS 2D 3C', 'Póker'],
  ['AS AD AH KC KS 2D 3C', 'Full'],
  ['2H 7H 9H JH KH AD 3C', 'Color'],
  ['AS 2D 3H 4C 5S 9D JC', 'Escalera'],
  ['7S 7D 7H 4C 5S 9D JC', 'Trío'],
  ['7S 7D 4H 4C 5S 9D JC', 'Doble par'],
  ['7S 7D 2H 4C 5S 9D JC', 'Par'],
  ['7S 3D 2H 4C KS 9D JC', 'Carta alta'],
];
for (const [c, n] of cases) assert.strictEqual(H(c).name, n, c);
// desempates
assert(compare(H('AS AD KH 4C 5S 9D JC').score, H('AS AD QH 4C 5S 9D JC').score) > 0, 'kicker');
assert(compare(H('6S 2D 3H 4C 5S 9D JC').score, H('AS 2D 3H 4C 5S 9D JC').score) > 0, 'escalera 6 > rueda');
assert.strictEqual(compare(H('AS KD 2H 2C 7S 7D 9C').score, H('AH KC 2H 2C 7S 7D 9C').score), 0, 'empate');
// botes secundarios: A all-in 100, B y C 300, D se retira con 50
const pots = buildPots([
  { id: 'A', amount: 100 }, { id: 'B', amount: 300 }, { id: 'C', amount: 300 }, { id: 'D', amount: 50, folded: true },
]);
assert.deepStrictEqual(pots, [{ amount: 350, eligible: ['A', 'B', 'C'] }, { amount: 400, eligible: ['B', 'C'] }]);
console.log('Evaluador y botes: OK');
