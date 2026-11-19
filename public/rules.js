/* Reglamento: "Cómo se juega". Lo usa client.js con window.buildRules(contenedor, cardEl). */
(() => {
  const HANDS = [
    ['Escalera real', 'A, K, Q, J y 10 del mismo palo. La mejor mano posible.', 'AS KS QS JS TS'],
    ['Escalera de color', 'Cinco cartas seguidas del mismo palo.', '9H 8H 7H 6H 5H'],
    ['Póker', 'Cuatro cartas del mismo número.', 'QC QD QH QS 7D'],
    ['Full', 'Un trío y un par.', 'KH KD KS 4C 4H'],
    ['Color', 'Cinco cartas del mismo palo, no seguidas.', 'AD JD 8D 6D 2D'],
    ['Escalera', 'Cinco cartas seguidas de distintos palos. El As puede ir arriba (10-J-Q-K-A) o abajo (A-2-3-4-5).', 'TC 9D 8S 7H 6C'],
    ['Trío', 'Tres cartas del mismo número.', '7C 7D 7S KH 2D'],
    ['Doble par', 'Dos pares distintos.', 'AH AC 9D 9S 5H'],
    ['Par', 'Dos cartas del mismo número.', 'JH JS 8C 4D 2S'],
    ['Carta alta', 'Nada de lo anterior: gana la carta más alta.', 'AC QD 9H 6S 3C'],
  ];

  const SECTIONS = [
    ['🎯 El objetivo', [
      'Ganar las fichas de los demás. En cada mano se juega por el <b>bote</b>: las fichas que apostaron todos.',
      'Se gana el bote de dos formas: teniendo la <b>mejor mano</b> al final, o haciendo que <b>todos los demás se retiren</b> (aunque tengas una mano mala: eso es un <i>farol</i>).',
    ]],
    ['🃏 Las cartas', [
      'Cada jugador recibe <b>2 cartas propias</b> que solo ve él.',
      'En el centro se ponen <b>5 cartas comunitarias</b> que sirven para todos.',
      'Tu mano es la <b>mejor combinación de 5 cartas</b> entre tus 2 y las 5 de la mesa (puedes usar las dos tuyas, una o ninguna).',
    ]],
    ['🔘 El repartidor y las ciegas', [
      'El botón <b>D</b> marca al repartidor; se mueve un lugar a la izquierda en cada mano.',
      'Los dos jugadores siguientes ponen fichas antes de ver las cartas, para que siempre haya algo en juego: la <b>ciega chica (CC)</b> y la <b>ciega grande (CG)</b>, que es el doble.',
      'Si solo quedan dos jugadores, el repartidor pone la ciega chica.',
    ]],
    ['🔄 Las cuatro rondas', [
      '<b>Preflop:</b> cada uno ve sus 2 cartas y se apuesta. Empieza el jugador a la izquierda de la ciega grande.',
      '<b>Flop:</b> se dan vuelta 3 cartas en la mesa y se apuesta de nuevo.',
      '<b>Turn:</b> se da vuelta la 4ª carta y se apuesta.',
      '<b>River:</b> se da vuelta la 5ª carta y se apuesta por última vez.',
      'Desde el flop, empieza a hablar el primer jugador que sigue en la mano a la izquierda del repartidor.',
    ]],
    ['🗣️ Qué puedes hacer en tu turno', [
      '<b>Pasar:</b> no apostar, si nadie apostó antes en esa ronda.',
      '<b>Apostar:</b> poner fichas cuando nadie apostó (como mínimo, la ciega grande).',
      '<b>Igualar:</b> poner lo mismo que la apuesta más alta para seguir jugando.',
      '<b>Subir:</b> poner más que la apuesta actual. La subida tiene que ser, como mínimo, igual a la subida anterior.',
      '<b>Retirarse:</b> abandonar la mano. Pierdes lo que ya pusiste, pero no arriesgas más.',
      '<b>All-in:</b> apostar todas tus fichas.',
      'La ronda termina cuando todos los que siguen jugando pusieron lo mismo (o están all-in).',
    ]],
    ['💰 All-in y botes secundarios', [
      'Si vas all-in con menos fichas que los demás, solo puedes ganar de cada rival lo mismo que pusiste tú: eso es el <b>bote principal</b>.',
      'Lo que los demás sigan apostando entre ellos va a un <b>bote secundario</b> que tú no puedes ganar. El juego los arma solo.',
      'Cuando ya nadie puede apostar más, las cartas que faltan se dan vuelta solas.',
    ]],
    ['🏆 El final de la mano (showdown)', [
      'Si después del river quedan dos o más jugadores, se muestran las cartas y gana la mejor mano según la tabla de abajo.',
      'Si dos manos son del mismo tipo, gana la de cartas más altas (por ejemplo, par de reyes le gana a par de damas). Si siguen empatadas, se miran las demás cartas (el <i>kicker</i>).',
      'Si son exactamente iguales, el bote se reparte.',
      'Los palos no tienen valor: ♠ ♥ ♦ ♣ valen lo mismo.',
    ]],
  ];

  const TABLE_RULES = [
    'Pueden jugar de <b>2 a 9 jugadores</b> por mesa, contando personas y bots.',
    'Cada uno tiene un <b>tiempo por turno</b> (lo elige el anfitrión). Si se acaba, pasa si puede o se retira. A quien se desconecta se le dan solo 5 segundos.',
    'Si te quedas sin fichas, puedes pedirle más al anfitrión: él puede darlas desde su panel.',
    'Los <b>🤖 bots</b> no ven tus cartas, pero mienten: a veces apuestan fuerte sin nada o se hacen los débiles con una gran mano. ¡No les creas todo lo que dicen en el chat!',
    'Si cierras la página, al volver a abrirla vuelves a tu asiento con tus fichas.',
    'Atajos en la compu: <b>F</b> retirarse, <b>C</b> o espacio pasar/igualar, <b>R</b> subir.',
  ];

  window.buildRules = (box, cardEl) => {
    const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
    box.append(el('h3', null, "📖 Cómo se juega al Texas Hold'em"));
    const wrap = el('div', 'rules');
    for (const [title, items] of SECTIONS) {
      wrap.append(el('h4', null, title));
      const ul = el('ul');
      for (const it of items) ul.append(el('li', null, it));
      wrap.append(ul);
    }
    wrap.append(el('h4', null, '📊 Las manos, de la mejor a la peor'));
    HANDS.forEach(([name, desc, cards], i) => {
      const row = el('div', 'rule-hand');
      row.append(el('div', 'rh-title', `<span class="rh-n">${i + 1}</span> <b>${name}</b>`));
      const cs = el('div', 'rh-cards');
      for (const c of cards.split(' ')) cs.append(cardEl(c));
      row.append(cs, el('div', 'rh-desc', desc));
      wrap.append(row);
    });
    wrap.append(el('h4', null, '⚙️ En esta mesa'));
    const ul = el('ul');
    for (const it of TABLE_RULES) ul.append(el('li', null, it));
    wrap.append(ul);
    box.append(wrap);
  };
})();
