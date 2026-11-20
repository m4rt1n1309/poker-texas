/* Cliente del póker: lobby, mesa, acciones, chat y temporizador */
(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- preferencias guardadas ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  let token = store.get('poker_token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    store.set('poker_token', token);
  }
  let cardStyle = store.get('poker_cards', 'drawn'); // 'drawn' | 'classic'
  let view = store.get('poker_view', 'mesa'); // 'mesa' | 'fp' (primera persona)
  let currentRoom = null;
  let state = null;
  let deadline = null;
  let wasMyTurn = false;
  let unread = 0;

  $('nameInput').value = store.get('poker_name', '');
  const urlCode = new URLSearchParams(location.search).get('sala');
  if (urlCode) $('codeInput').value = urlCode.toUpperCase();

  // ---------- cartas ----------
  const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const SUIT_FILE = { S: 'spade', H: 'heart', D: 'diamond', C: 'club' };
  const RANK_TXT = { T: '10' };
  const RANK_FILE = { A: '1', T: '10', J: 'jack', Q: 'queen', K: 'king' };

  function cardEl(code, extra = '') {
    const el = document.createElement('div');
    el.className = `card ${cardStyle} ${extra}`;
    if (code === 'empty') { el.className = 'card empty'; return el; }
    if (!code) {
      el.classList.add('back');
      if (cardStyle === 'classic') el.innerHTML = '<img src="deck/back-red.png" alt="">';
      return el;
    }
    const r = code[0], s = code[1];
    el.dataset.code = code;
    if (cardStyle === 'classic') {
      const img = document.createElement('img');
      img.src = `deck/${SUIT_FILE[s]}_${RANK_FILE[r] || r}.png`;
      img.alt = code;
      el.appendChild(img);
      return el;
    }
    const rt = RANK_TXT[r] || r, sym = SUIT_SYM[s];
    if (s === 'H' || s === 'D') el.classList.add('red');
    const face = 'JQK'.includes(r);
    if (face) el.classList.add('face');
    el.innerHTML = `<div class="corner">${rt}<small>${sym}</small></div>
      <div class="pip">${face ? rt + sym : sym}</div>
      <div class="corner br">${rt}<small>${sym}</small></div>`;
    return el;
  }

  // ---------- fichas de colores (como en el casino: cada color vale distinto) ----------
  const CHIPS = [
    { v: 5000, c: '#e46a1f', s: '#fff' }, { v: 1000, c: '#e8b931', s: '#5a3a00' },
    { v: 500, c: '#7b3fc4', s: '#fff' }, { v: 100, c: '#1c1c1c', s: '#fff' },
    { v: 25, c: '#1f9d55', s: '#fff' }, { v: 5, c: '#d7263d', s: '#fff' }, { v: 1, c: '#f1f1f1', s: '#3a7bd5' },
  ];
  function chipBreakdown(amount) {
    const out = [];
    let left = Math.round(amount);
    for (const ch of CHIPS) {
      const n = Math.floor(left / ch.v);
      if (n) { out.push({ ...ch, n }); left -= n * ch.v; }
    }
    return out;
  }
  function paintChip(el, ch) {
    el.style.setProperty('--c', ch.c);
    el.style.setProperty('--s', ch.s);
    return el;
  }
  // pilitas de fichas para un monto (las de más valor primero)
  function chipStacks(amount, maxStacks = 3, maxPer = 6) {
    const wrap = document.createElement('span');
    wrap.className = 'stacks';
    for (const ch of chipBreakdown(amount).slice(0, maxStacks)) {
      const st = document.createElement('span');
      st.className = 'stack';
      st.title = `${ch.n} × ${fmt(ch.v)}`;
      const k = Math.min(ch.n, maxPer);
      for (let i = 0; i < k; i++) {
        const c = paintChip(document.createElement('span'), ch);
        c.className = 'chip';
        c.style.bottom = i * 3 + 'px';
        st.append(c);
      }
      st.style.height = 14 + (k - 1) * 3 + 'px';
      wrap.append(st);
    }
    return wrap;
  }

  // ---------- utilidades de interfaz ----------
  function toast(msg, ms = 2500) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  function openModal(build) {
    const body = $('modalBody');
    body.innerHTML = '';
    build(body);
    $('modal').classList.remove('hidden');
  }
  function closeModal() {
    $('modal').classList.add('hidden');
    $('modal').querySelector('.modal-box').classList.remove('wide');
  }
  $('modalClose').onclick = closeModal;
  $('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };

  const h = (tag, props = {}, ...children) => {
    const el = document.createElement(tag);
    Object.assign(el, props);
    for (const c of children) el.append(c);
    return el;
  };
  const fmt = (n) => Number(n).toLocaleString('es-AR');

  function showScreen(name) {
    $('lobby').classList.toggle('hidden', name !== 'lobby');
    $('game').classList.toggle('hidden', name !== 'game');
  }

  // ---------- conexión con /api/room ----------
  // No hay conexión permanente: cada celular consulta la sala cada segundo y manda sus jugadas.
  let seq = 0, appliedSeq = 0, pollTimer = null, pollGen = 0, lastChatId = 0, offline = false;

  async function call(body) {
    const url = body ? '/api/room' : `/api/room?code=${currentRoom}&token=${encodeURIComponent(token)}`;
    const opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, token }) }
      : {};
    const mySeq = ++seq;
    const res = await fetch(url, { cache: 'no-store', ...opts });
    const data = await res.json().catch(() => ({ error: 'Respuesta inválida del servidor.' }));
    if (offline) { offline = false; toast('Conexión recuperada'); }
    return { status: res.status, data, mySeq };
  }

  // Manda una operación (jugada, chat, etc.) y muestra la mesa que devuelve
  async function send(op, data = {}) {
    if (!currentRoom) return;
    try {
      const { status, data: res, mySeq } = await call({ op, code: currentRoom, ...data });
      if (status === 404) return exitRoom('La sala ya no existe.');
      if (res.error) toast(res.error);
      if (status === 200) applyState(res, mySeq);
    } catch {
      toast('Sin conexión, revisa tu internet.');
    }
  }

  async function poll(gen) {
    if (gen !== pollGen || !currentRoom) return;
    try {
      const { status, data, mySeq } = await call();
      if (gen !== pollGen) return;
      if (status === 404) return exitRoom('La sala ya no existe.');
      if (status === 200) applyState(data, mySeq);
      else if (data.error) toast(data.error);
    } catch {
      if (!offline) { offline = true; toast('Sin conexión, reintentando…', 4000); }
    }
    if (gen === pollGen && currentRoom) pollTimer = setTimeout(() => poll(gen), document.hidden ? 4000 : 1000);
  }
  function startPolling() {
    clearTimeout(pollTimer);
    poll(++pollGen);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && currentRoom) startPolling(); });

  // ---------- lobby ----------
  function getName() {
    const n = $('nameInput').value.trim();
    if (!n) { $('lobbyError').textContent = 'Escribe tu nombre primero.'; $('nameInput').focus(); return null; }
    store.set('poker_name', n);
    return n;
  }

  async function enter(body) {
    $('lobbyError').textContent = 'Conectando…';
    try {
      const { status, data, mySeq } = await call(body);
      if (status !== 200) throw new Error(data.error || 'No se pudo entrar.');
      $('lobbyError').textContent = '';
      currentRoom = data.code;
      store.set('poker_room', data.code);
      history.replaceState(null, '', `?sala=${data.code}`);
      lastChatId = 0;
      $('chatLog').innerHTML = '';
      showScreen('game');
      applyState(data, mySeq);
      startPolling();
    } catch (e) {
      store.del('poker_room');
      $('lobbyError').textContent = e.message === 'Failed to fetch' ? 'Sin conexión, revisa tu internet.' : e.message;
    }
  }

  $('createBtn').onclick = () => {
    const name = getName();
    if (!name) return;
    enter({
      op: 'create', name,
      settings: { startChips: $('setChips').value, bigBlind: $('setBB').value, turnTime: $('setTime').value },
    });
  };
  // Sala propia con 3 bots (uno de cada nivel) que empieza sola
  $('practiceBtn').onclick = async () => {
    const name = getName();
    if (!name) return;
    await enter({
      op: 'create', name,
      settings: { startChips: $('setChips').value, bigBlind: $('setBB').value, turnTime: $('setTime').value },
    });
    if (!currentRoom) return;
    for (const level of ['facil', 'normal', 'dificil']) await send('addBot', { level });
    await send('start');
  };
  $('joinBtn').onclick = () => {
    const name = getName();
    if (!name) return;
    const code = $('codeInput').value.trim().toUpperCase();
    if (code.length !== 4) { $('lobbyError').textContent = 'El código tiene 4 letras.'; return; }
    enter({ op: 'join', code, name });
  };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

  function exitRoom(msg) {
    currentRoom = null;
    state = null;
    pollGen++;
    clearTimeout(pollTimer);
    store.del('poker_room');
    history.replaceState(null, '', location.pathname);
    closeModal();
    showScreen('lobby');
    $('lobbyError').textContent = msg || '';
  }

  // ---------- barra superior ----------
  // en pantallas chicas los botones van en un menú ☰ para que la mesa y las apuestas entren sin scrollear
  const setMenu = (open) => {
    $('topMenu').classList.toggle('open', open);
    $('menuBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  $('menuBtn').onclick = (e) => { e.stopPropagation(); setMenu(!$('topMenu').classList.contains('open')); };
  $('topMenu').addEventListener('click', (e) => { if (e.target.closest('button') && e.target.closest('button').id !== 'soundBtn') setMenu(false); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#topMenu')) setMenu(false); });

  $('shareBtn').onclick = async () => {
    const url = `${location.origin}/?sala=${currentRoom}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Póker con Amigos', text: `¡Vení a jugar! Sala ${currentRoom}`, url }); return; } catch {}
    }
    try { await navigator.clipboard.writeText(url); toast('Enlace copiado: ' + url, 4000); }
    catch { toast(url, 8000); }
  };

  $('leaveBtn').onclick = () => openModal((b) => {
    b.append(h('h3', { textContent: '¿Salir de la sala?' }),
      h('p', { textContent: 'Si estás en una mano, te retiras. Perderás tus fichas en esta sala.' }));
    const yes = h('button', { className: 'btn danger', textContent: 'Sí, salir' });
    yes.onclick = () => {
      send('leave');
      exitRoom();
    };
    b.append(yes);
  });

  $('optionsBtn').onclick = () => openModal((b) => {
    b.append(h('h3', { textContent: 'Estilo de cartas' }));
    const pick = h('div', { className: 'style-pick' });
    for (const [style, label] of [['drawn', 'Dibujadas'], ['classic', 'Clásicas']]) {
      const prev = cardStyle;
      cardStyle = style;
      const cards = h('div', { className: 'cards' }, cardEl('AS'), cardEl('KH'), cardEl('QD'), cardEl(null));
      cardStyle = prev;
      const btn = h('button', { className: style === cardStyle ? 'sel' : '' }, cards, label);
      btn.onclick = () => {
        cardStyle = style;
        store.set('poker_cards', style);
        closeModal();
        render();
      };
      pick.append(btn);
    }
    b.append(pick);
    b.append(h('h3', { textContent: 'Vista de la mesa' }));
    const vpick = h('div', { className: 'style-pick view-pick' });
    for (const [v, ico, label] of [['mesa', '🔝', 'Desde arriba'], ['fp', '🙌', 'Primera persona']]) {
      const btn = h('button', { className: v === view ? 'sel' : '' }, h('div', { className: 'vp-ico', textContent: ico }), label);
      btn.onclick = () => {
        view = v;
        store.set('poker_view', v);
        closeModal();
        render();
      };
      vpick.append(btn);
    }
    b.append(vpick, h('p', { className: 'sys', textContent: 'En primera persona ves tus cartas en tus manos, como sentado a la mesa. Cada jugador elige lo que prefiera; no cambia nada para los demás.' }));
  });

  $('hostBtn').onclick = () => openModal(buildHostPanel);
  const showRules = () => {
    openModal((b) => window.buildRules(b, cardEl));
    $('modal').querySelector('.modal-box').classList.add('wide');
  };
  $('rulesBtn').onclick = showRules;
  $('rulesLobbyBtn').onclick = showRules;

  $('rankBtn').onclick = () => openModal((b) => {
    const list = (state && state.ranking) || [];
    b.append(h('h3', { textContent: '📊 Ranking de la sala' }));
    if (!list.length) { b.append(h('p', { textContent: 'Todavía no hay datos.' })); return; }
    const medals = ['🥇', '🥈', '🥉'];
    const table = h('table', { className: 'ranking' });
    table.append(h('tr', {}, ...['', 'Jugador', 'Ganancia', 'Manos', 'Mayor bote', 'Mejor jugada'].map((t) => h('th', { textContent: t }))));
    list.forEach((r, i) => {
      const net = h('td', { className: r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : '', textContent: (r.net > 0 ? '+' : '') + fmt(r.net) });
      const tr = h('tr', { className: r.isYou ? 'you' : '' },
        h('td', { textContent: medals[i] || `${i + 1}` }),
        h('td', { textContent: r.name + (r.here ? '' : ' (se fue)') }),
        net,
        h('td', { textContent: `${r.handsWon}/${r.played}` }),
        h('td', { textContent: r.biggestPot ? fmt(r.biggestPot) : '—' }),
        h('td', { textContent: r.best || '—' }));
      table.append(tr);
    });
    b.append(h('div', { className: 'ranking-wrap' }, table),
      h('p', { className: 'sys', textContent: 'Ganancia = fichas que tiene ahora menos las que recibió (al entrar o de regalo del anfitrión). "Manos" = ganadas / jugadas. El ranking dura lo que dure la sala: se borra después de 7 días sin jugar.' }));
  });

  function buildHostPanel(b) {
    if (!state) return;
    const s = state.settings;
    b.append(h('h3', { textContent: 'Panel del anfitrión' }));

    const startBtn = h('button', {
      className: `btn ${state.running ? 'danger' : 'gold'}`,
      textContent: state.running ? '⏸ Pausar después de esta mano' : '▶ Empezar a jugar',
    });
    startBtn.onclick = () => { send(state.running ? 'pause' : 'start'); closeModal(); };
    b.append(startBtn);

    b.append(h('h4', { textContent: 'Reglas (se aplican en la próxima mano)' }));
    const bb = h('input', { type: 'number', value: s.bigBlind, min: 2 });
    const tt = h('select');
    for (const [v, t] of [[15, '15 s'], [30, '30 s'], [45, '45 s'], [60, '1 min'], [120, '2 min'], [0, 'Sin límite']]) {
      tt.append(h('option', { value: v, textContent: t, selected: v === s.turnTime }));
    }
    const sc = h('input', { type: 'number', value: s.startChips, min: 10 });
    const sp = h('select');
    for (const [v, t] of [['lenta', 'Lenta (4-5 s)'], ['normal', 'Normal (2-3 s)'], ['rapida', 'Rápida (1 s)']]) {
      sp.append(h('option', { value: v, textContent: t, selected: v === (s.botSpeed || 'normal') }));
    }
    b.append(
      h('label', {}, 'Ciega grande (la chica es la mitad)', bb),
      h('label', {}, 'Tiempo por turno', tt),
      h('label', {}, 'Fichas iniciales para nuevos jugadores', sc),
      h('label', {}, 'Velocidad de los bots', sp),
    );
    const save = h('button', { className: 'btn primary', textContent: 'Guardar reglas' });
    save.onclick = () => {
      send('settings', { bigBlind: bb.value, turnTime: tt.value, startChips: sc.value, botSpeed: sp.value });
      toast('Reglas guardadas');
    };
    b.append(save);

    b.append(h('h4', { textContent: 'Bots' }));
    const lvl = h('select');
    for (const [v, t] of [['facil', 'Fácil'], ['normal', 'Normal'], ['dificil', 'Difícil']]) {
      lvl.append(h('option', { value: v, textContent: t, selected: v === 'normal' }));
    }
    const addBot = h('button', { className: 'btn primary', textContent: '🤖 Agregar bot' });
    addBot.onclick = async () => {
      await send('addBot', { level: lvl.value });
      openModal(buildHostPanel); // se vuelve a armar para que aparezca en la lista
    };
    b.append(h('div', { className: 'player-row' }, lvl, addBot),
      h('p', { className: 'sys', textContent: 'Los bots no ven tus cartas, y a veces mienten: apuestan fuerte sin nada o se hacen los débiles con una gran mano. Para sacar uno, toca ✕ en la lista.' }));

    b.append(h('h4', { textContent: 'Jugadores (dar o quitar fichas)' }));
    for (const p of state.seats.filter(Boolean)) {
      const amt = h('input', { type: 'number', value: s.startChips });
      const give = h('button', { className: 'btn small primary', textContent: '+ Dar' });
      give.onclick = () => send('chips', { seat: p.seat, amount: Number(amt.value) });
      const take = h('button', { className: 'btn small', textContent: '− Quitar' });
      take.onclick = () => send('chips', { seat: p.seat, amount: -Number(amt.value) });
      const row = h('div', { className: 'player-row' },
        h('span', { className: 'pn', textContent: `${p.name}${p.bot ? ` (${p.bot})` : ''} · ${fmt(p.chips)}` }), amt, give, take);
      if (!p.isYou) {
        const kick = h('button', { className: 'btn small danger', textContent: '✕', title: 'Sacar de la sala' });
        kick.onclick = () => { send('kick', { seat: p.seat }); closeModal(); };
        row.append(kick);
      }
      b.append(row);
    }
  }

  // ---------- chat ----------
  function addMsg(m) {
    const log = $('chatLog');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const div = document.createElement('div');
    if (m.system) { div.className = 'msg sys'; div.textContent = m.text; }
    else {
      div.className = 'msg';
      div.append(h('b', { textContent: m.from + ': ' }), document.createTextNode(m.text));
    }
    log.append(div);
    while (log.children.length > 150) log.firstChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  // el servidor manda los últimos mensajes con número: se agregan solo los nuevos
  function updateChat(list) {
    const first = lastChatId === 0;
    for (const m of list) {
      if (m.id <= lastChatId) continue;
      lastChatId = m.id;
      addMsg(m);
      if (!first && !m.system && state && m.from !== (state.seats[state.yourSeat] || {}).name) sound.play('msg');
      if (!first && !m.system && !$('chat').classList.contains('open') && getComputedStyle($('chatToggle')).display !== 'none') {
        unread++;
        $('unread').textContent = unread;
        $('unread').classList.remove('hidden');
      }
    }
    if (first) $('chatLog').scrollTop = $('chatLog').scrollHeight;
  }
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const t = $('chatInput').value.trim();
    if (t) send('chat', { text: t });
    $('chatInput').value = '';
  };
  $('chatToggle').onclick = () => {
    $('chat').classList.add('open');
    unread = 0;
    $('unread').classList.add('hidden');
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
  };
  $('chatClose').onclick = () => $('chat').classList.remove('open');

  // ---------- acciones ----------
  const play = (type, amount) => {
    if (!state || !state.actions) return;
    $('actionBar').classList.add('hidden'); // evita doble toque mientras llega la respuesta
    send('action', { type, amount });
  };
  $('foldBtn').onclick = () => play('fold');
  $('checkBtn').onclick = () => play(state.actions.canCheck ? 'check' : 'call');
  $('raiseBtn').onclick = () => play('raise', Number($('raiseInput').value));
  $('allinBtn').onclick = () => play('allin');
  $('raiseSlider').oninput = () => { $('raiseInput').value = $('raiseSlider').value; updateRaiseLabel(); };
  $('raiseInput').oninput = () => { $('raiseSlider').value = $('raiseInput').value; updateRaiseLabel(); };
  document.querySelectorAll('[data-quick]').forEach((btn) => {
    btn.onclick = () => {
      const a = state && state.actions;
      if (!a) return;
      const potAfterCall = state.pot + a.toCall;
      let v = a.minRaiseTo;
      if (btn.dataset.quick === 'half') v = a.currentBet + Math.floor(potAfterCall / 2);
      if (btn.dataset.quick === 'pot') v = a.currentBet + potAfterCall;
      v = Math.max(a.minRaiseTo, Math.min(a.maxRaiseTo, v));
      $('raiseInput').value = v;
      $('raiseSlider').value = v;
      updateRaiseLabel();
    };
  });
  function updateRaiseLabel() {
    const a = state && state.actions;
    if (!a) return;
    const v = Number($('raiseInput').value);
    const verb = a.currentBet === 0 ? 'Apostar' : 'Subir a';
    $('raiseBtn').textContent = v >= a.maxRaiseTo ? `All-in ${fmt(a.maxRaiseTo)}` : `${verb} ${fmt(v)}`;
  }

  // atajos de teclado en computadora
  document.addEventListener('keydown', (e) => {
    if (!state || !state.actions || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'f') $('foldBtn').click();
    if (e.key === 'c' || e.key === ' ') { e.preventDefault(); $('checkBtn').click(); }
    if (e.key === 'r') $('raiseBtn').click();
  });

  // ---------- sonidos (se generan en el momento, no hay archivos de audio) ----------
  const sound = {
    on: store.get('poker_sound', '1') === '1',
    ctx: null,
    ac() {
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch { return null; }
      return this.ctx;
    },
    tone(c, freq, dur, { type = 'sine', vol = 0.07, delay = 0, to = null } = {}) {
      const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur + 0.02);
    },
    noise(c, dur, { vol = 0.06, delay = 0, freq = 2000 } = {}) {
      const t = c.currentTime + delay;
      const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq; g.gain.value = vol;
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start(t);
    },
    play(name) {
      if (!this.on) return;
      const c = this.ac();
      if (!c) return;
      const chip = (delay) => { this.tone(c, 2200 + Math.random() * 600, 0.05, { type: 'triangle', vol: 0.05, delay }); this.noise(c, 0.04, { vol: 0.04, delay, freq: 5000 }); };
      switch (name) {
        case 'chip': chip(0); chip(0.06); break;
        case 'chips': for (let i = 0; i < 5; i++) chip(i * 0.05); break;
        case 'check': this.tone(c, 160, 0.07, { type: 'square', vol: 0.05 }); this.tone(c, 150, 0.07, { type: 'square', vol: 0.05, delay: 0.12 }); break;
        case 'fold': this.noise(c, 0.22, { vol: 0.07, freq: 900 }); break;
        case 'deal': this.noise(c, 0.07, { vol: 0.06, freq: 3500 }); break;
        case 'allin': this.tone(c, 220, 0.45, { type: 'sawtooth', vol: 0.04, to: 880 }); for (let i = 0; i < 6; i++) chip(0.3 + i * 0.04); break;
        case 'win': [523, 659, 784, 1047].forEach((f, i) => this.tone(c, f, 0.25, { type: 'triangle', vol: 0.07, delay: i * 0.1 })); break;
        case 'turn': this.tone(c, 880, 0.12, { vol: 0.08 }); this.tone(c, 1175, 0.16, { vol: 0.08, delay: 0.13 }); break;
        case 'msg': this.tone(c, 1320, 0.06, { vol: 0.03 }); break;
      }
    },
  };
  const updateSoundBtn = () => { $('soundIco').textContent = sound.on ? '🔊' : '🔇'; };
  updateSoundBtn();
  $('soundBtn').onclick = () => {
    sound.on = !sound.on;
    store.set('poker_sound', sound.on ? '1' : '0');
    updateSoundBtn();
    if (sound.on) sound.play('chip');
  };

  // aviso cuando es tu turno
  function beep() {
    sound.play('turn');
    if (navigator.vibrate) navigator.vibrate(150);
  }

  // ---------- animaciones: qué cambió desde la última vez ----------
  const bubbles = {}; // asiento -> { text, kind, until, fresh }
  const actionKeys = {};
  const kindOf = (a) => /All-in/.test(a) ? 'allin' : /Sube|Apuesta/.test(a) ? 'raise' : /Iguala|Ciega/.test(a) ? 'call' : /Pasa/.test(a) ? 'check' : /retira/.test(a) ? 'fold' : 'call';

  function detectEvents(prev, s) {
    const ev = [];
    if (!prev || prev.code !== s.code) {
      s.seats.forEach((p) => { if (p) actionKeys[p.seat] = `${s.handNo}|${s.stage}|${p.lastAction}|${p.bet}`; });
      return ev;
    }
    if (s.handNo !== prev.handNo && s.stage !== 'waiting') ev.push({ type: 'sound', name: 'deal' });
    if (s.board.length > prev.board.length && s.handNo === prev.handNo) ev.push({ type: 'sound', name: 'deal' });
    s.seats.forEach((p) => {
      if (!p) return;
      const key = `${s.handNo}|${s.stage}|${p.lastAction}|${p.bet}`;
      const old = actionKeys[p.seat];
      actionKeys[p.seat] = key;
      if (!p.lastAction || key === old) return;
      const kind = kindOf(p.lastAction);
      bubbles[p.seat] = { text: p.lastAction, kind, until: Date.now() + 2800, fresh: true };
      ev.push({ type: 'sound', name: kind === 'raise' ? 'chips' : kind });
      const before = prev.seats[p.seat];
      if (before && s.handNo === prev.handNo && p.bet > before.bet) ev.push({ type: 'bet', seat: p.seat, amount: p.bet - before.bet });
    });
    if (s.stage === 'showdown' && s.results && !(prev.stage === 'showdown' && prev.handNo === s.handNo)) {
      ev.push({ type: 'sound', name: 'win' });
      s.seats.forEach((p) => { if (p && p.won) ev.push({ type: 'win', seat: p.seat, amount: p.won }); });
    }
    return ev;
  }

  // fichas que vuelan entre dos puntos de la mesa (en % del tamaño de la mesa)
  function flyChips(from, to, n, amount) {
    const table = $('table');
    const kinds = chipBreakdown(amount || 1);
    for (let i = 0; i < n; i++) {
      const c = paintChip(h('div', { className: 'chip-fly' }), kinds[i % kinds.length]);
      c.style.left = from.x + (Math.random() * 3 - 1.5) + '%';
      c.style.top = from.y + (Math.random() * 3 - 1.5) + '%';
      c.style.transitionDelay = i * 70 + 'ms';
      table.append(c);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        c.style.left = to.x + '%';
        c.style.top = to.y + '%';
      }));
      setTimeout(() => c.classList.add('gone'), 700 + i * 70);
      setTimeout(() => c.remove(), 1100 + i * 70);
    }
  }
  function potPoint() {
    const t = $('table').getBoundingClientRect(), r = $('pot').getBoundingClientRect();
    if (!t.width || !r.width) return { x: 50, y: 40 };
    return { x: ((r.left + r.width / 2 - t.left) / t.width) * 100, y: ((r.top + r.height / 2 - t.top) / t.height) * 100 };
  }
  function runEvents(ev) {
    const pos = render.posBySeat || {};
    let played = 0;
    for (const e of ev) {
      if (e.type === 'sound' && played < 2) { sound.play(e.name); played++; }
      if (e.type === 'bet' && pos[e.seat]) flyChips({ x: pos[e.seat].x, y: pos[e.seat].y }, { x: pos[e.seat].bx, y: pos[e.seat].by }, 3, e.amount);
      if (e.type === 'win' && pos[e.seat]) flyChips(potPoint(), { x: pos[e.seat].x, y: pos[e.seat].y }, 8, e.amount);
    }
  }

  // ---------- render ----------
  function applyState(s, mySeq) {
    if (mySeq < appliedSeq) return; // llegó tarde una respuesta vieja
    appliedSeq = mySeq;
    if (s.gone) return exitRoom('Ya no estás en esta sala.');
    if (!s.seats) return;
    const prev = state;
    state = s;
    updateChat(s.chat || []);
    const events = detectEvents(prev, s);
    deadline = s.turnRemaining != null ? Date.now() + s.turnRemaining : null;
    const myTurn = s.toActSeat >= 0 && s.toActSeat === s.yourSeat;
    if (myTurn && !wasMyTurn) beep();
    wasMyTurn = myTurn;
    render();
    runEvents(events);
  }

  const STAGE_TXT = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: '' };

  // fp: yo no estoy en la ronda (soy las manos de abajo) y los demás se reparten por los costados y arriba
  function seatPositions(n, fp) {
    const portrait = window.innerWidth / window.innerHeight < 1;
    const rx = portrait ? 40 : 45, ry = portrait ? 41 : 37;
    return Array.from({ length: n }, (_, i) => {
      if (fp && i === 0) return { x: 50, y: 92, bx: 50, by: 70 };
      const deg = fp ? 145 + (i * 250) / n : 90 + (i * 360) / n;
      const ang = (deg * Math.PI) / 180;
      return {
        x: 50 + rx * Math.cos(ang), y: 53 + ry * Math.sin(ang),
        bx: 50 + rx * 0.58 * Math.cos(ang), by: 55 + ry * 0.55 * Math.sin(ang),
      };
    });
  }

  // solo se anima el reparto de cartas que no estaban antes en pantalla
  let seen = new Set(), nowSeen = new Set();
  function dealCls(key) {
    nowSeen.add(key);
    return seen.has(key) ? '' : ' deal';
  }

  // ---------- primera persona: dos manos que sostienen mis cartas ----------
  // dibujo de una mano derecha (la izquierda es la misma en espejo): la carta va entre los dedos (atrás) y el pulgar (adelante)
  const HAND_BACK = `<svg class="fp-svg" viewBox="0 0 150 230" aria-hidden="true">
    <path class="skin-dark" d="M70 205 C66 170 80 120 104 104 L124 112 C136 140 134 185 128 230 L74 230 Z"/>
    <ellipse class="skin-dark" cx="113" cy="66" rx="12" ry="9" transform="rotate(-15 113 66)"/>
    <ellipse class="skin-dark" cx="117" cy="86" rx="13" ry="10" transform="rotate(-8 117 86)"/>
    <ellipse class="skin-dark" cx="117" cy="106" rx="12" ry="10"/>
    <ellipse class="skin-dark" cx="113" cy="125" rx="10" ry="9" transform="rotate(10 113 125)"/>
  </svg>`;
  const HAND_FRONT = `<svg class="fp-svg front" viewBox="0 0 150 230" aria-hidden="true">
    <path class="skin" d="M66 186 C52 160 40 132 44 114 C46 102 58 98 66 106 C76 122 90 148 104 166 Z"/>
    <path class="skin" d="M58 230 C58 200 62 168 76 152 C92 136 118 134 132 146 C142 162 140 200 134 230 Z"/>
    <path class="nail" d="M46 112 C46 104 54 100 60 106 C62 112 58 120 52 121 C48 120 46 116 46 112 Z"/>
    <path class="crease" d="M78 160 C86 152 98 150 108 152"/>
    <rect class="sleeve" x="52" y="204" width="90" height="30" rx="6"/>
    <rect class="cuff" x="52" y="202" width="90" height="7" rx="3"/>
  </svg>`;
  function handsRig(cardEls) {
    const wrap = h('div', { className: 'fp-hands' + (cardEls.length ? '' : ' empty') });
    ['left', 'right'].forEach((side, i) => {
      const rig = h('div', { className: `fp-hand ${side}` });
      rig.innerHTML = HAND_BACK;
      const slot = h('div', { className: 'fp-slot' });
      if (cardEls[i]) slot.append(cardEls[i]);
      rig.append(slot);
      rig.insertAdjacentHTML('beforeend', HAND_FRONT);
      wrap.append(rig);
    });
    return wrap;
  }

  function render() {
    const s = state;
    if (!s) return;
    nowSeen = new Set();
    $('roomCode').textContent = s.code;
    $('hostBtn').classList.toggle('hidden', !s.isHost);

    // cartas ganadoras (para resaltarlas)
    const winning = new Set();
    if (s.stage === 'showdown') for (const p of s.seats) if (p && p.won && p.bestCards) p.bestCards.forEach((c) => winning.add(c));

    // mesa
    const board = $('board');
    board.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const c = s.board[i];
      let cls = '';
      if (c && winning.size) cls = winning.has(c) ? 'highlight' : 'dim';
      board.append(c ? cardEl(c, cls + dealCls(`${s.handNo}-b${i}-${c}`)) : cardEl('empty'));
    }
    const potEl = $('pot');
    potEl.innerHTML = '';
    if (s.pot) potEl.append(chipStacks(s.pot, 4, 8), h('span', { textContent: `Bote: ${fmt(s.pot)}` }));

    let status = '';
    if (s.stage === 'waiting') status = s.running ? 'Preparando la mano…' : 'Esperando que el anfitrión empiece';
    else if (s.stage === 'showdown' && s.results) status = s.results.map((r) => `${r.name} gana ${fmt(r.amount)}${r.hand ? ' con ' + r.hand : ''}`).join(' · ');
    else {
      const actor = s.seats[s.toActSeat];
      status = `${STAGE_TXT[s.stage]}${actor ? ' · turno de ' + actor.name : ''}`;
    }
    $('status').textContent = status;

    // asientos (yo siempre abajo)
    const seatsEl = $('seats');
    seatsEl.innerHTML = '';
    const players = s.seats.filter(Boolean);
    const mySeat = s.yourSeat >= 0 ? s.yourSeat : 0;
    players.sort((a, b) => ((a.seat - mySeat + 9) % 9) - ((b.seat - mySeat + 9) % 9));
    const fp = view === 'fp' && s.yourSeat >= 0;
    $('table').classList.toggle('fp', fp);
    const pos = seatPositions(players.length, fp);
    render.posBySeat = {};
    players.forEach((p, i) => { render.posBySeat[p.seat] = pos[i]; });

    players.forEach((p, i) => {
      const el = h('div', { className: 'seat' });
      el.style.left = pos[i].x + '%';
      el.style.top = pos[i].y + '%';
      if (p.isYou) el.classList.add('me');
      if (p.seat === s.toActSeat) el.classList.add('turn');
      if (p.folded) el.classList.add('folded');
      if (!p.connected) el.classList.add('offline');
      if (p.won) el.classList.add('winner');

      const handCards = [];
      p.cards.forEach((c, ci) => {
        let cls = '';
        if (c && winning.size && p.won) cls = winning.has(c) ? 'highlight' : '';
        const key = `${s.handNo}-${p.seat}-${ci}-${c || 'x'}`;
        // en el showdown las cartas de los demás se dan vuelta; si no, se reparten
        const anim = dealCls(key) && (c && !p.isYou && s.stage === 'showdown' ? ' flip' : ' deal');
        handCards.push(cardEl(c, cls + (anim || '')));
      });
      if (fp && p.isYou) {
        el.classList.add('fp-me');
        el.append(handsRig(handCards));
      } else {
        el.append(h('div', { className: 'cards' }, ...handCards));
      }

      const plate = h('div', { className: 'plate' });
      plate.append(h('div', { className: 'name', textContent: (p.isHost ? '👑 ' : '') + p.name }));
      plate.append(h('div', { className: 'chips', textContent: p.chips > 0 || p.inHand ? fmt(p.chips) : 'Sin fichas' }));
      let act = p.allIn && s.stage !== 'showdown' ? 'ALL-IN' : (p.lastAction || '');
      if (p.handName) act = p.handName;
      if (!p.inHand && s.stage !== 'waiting' && p.chips > 0) act = 'Espera la próxima';
      if (p.thinking) plate.append(h('div', { className: 'action thinking', textContent: '🤔 pensando' }));
      else plate.append(h('div', { className: p.handName ? 'hand-name' : 'action', textContent: act }));
      const bub = bubbles[p.seat];
      if (bub && bub.until > Date.now() && !p.thinking) {
        el.append(h('div', { className: `bubble b-${bub.kind}${bub.fresh ? ' pop' : ''}`, textContent: bub.text }));
        bub.fresh = false;
      }
      if (p.seat === s.toActSeat && deadline) plate.append(h('div', { className: 'tbar' }, h('div')));
      if (p.seat === s.dealerSeat && s.stage !== 'waiting') plate.append(h('div', { className: 'dealer-btn', textContent: 'D' }));
      else if (p.seat === s.sbSeat && s.stage !== 'waiting') plate.append(h('div', { className: 'blind-btn', textContent: 'CC' }));
      else if (p.seat === s.bbSeat && s.stage !== 'waiting') plate.append(h('div', { className: 'blind-btn', textContent: 'CG' }));
      if (p.won) plate.append(h('div', { className: 'won', textContent: '+' + fmt(p.won) }));
      el.append(plate);
      seatsEl.append(el);

      if (p.bet > 0) {
        const bet = h('div', { className: 'bet' }, chipStacks(p.bet), fmt(p.bet));
        bet.style.left = pos[i].bx + '%';
        bet.style.top = pos[i].by + '%';
        seatsEl.append(bet);
      }
    });

    // mi mano
    const me = s.seats[s.yourSeat];
    let info = '';
    if (me && me.inHand && me.cards[0] && !me.folded) {
      const all = [...me.cards, ...s.board];
      if (all.length >= 5) info = 'Tienes: ' + Poker.bestHand(all).name;
      else if (me.cards[0][0] === me.cards[1][0]) info = 'Tienes: Par en mano';
      else if (me.cards[0][1] === me.cards[1][1]) info = 'Tienes: cartas del mismo palo';
    }
    $('handInfo').textContent = info;
    seen = nowSeen;

    // botones de acción
    const a = s.actions;
    $('actionBar').classList.toggle('hidden', !a);
    if (a) {
      $('checkBtn').textContent = a.canCheck ? 'Pasar' : (a.toCall >= me.chips ? `All-in ${fmt(a.toCall)}` : `Igualar ${fmt(a.toCall)}`);
      $('raiseRow').classList.toggle('hidden', !a.canRaise || a.maxRaiseTo <= a.minRaiseTo && a.toCall >= me.chips);
      $('raiseBtn').classList.toggle('hidden', !a.canRaise || a.toCall >= me.chips);
      const slider = $('raiseSlider'), input = $('raiseInput');
      slider.min = input.min = a.minRaiseTo;
      slider.max = input.max = a.maxRaiseTo;
      slider.step = Math.max(1, Math.floor(s.settings.smallBlind));
      if (!render.lastTurnKey || render.lastTurnKey !== `${s.handNo}-${s.stage}-${a.currentBet}`) {
        input.value = slider.value = a.minRaiseTo;
        render.lastTurnKey = `${s.handNo}-${s.stage}-${a.currentBet}`;
      }
      updateRaiseLabel();
    }

    // barra inferior cuando no es mi turno
    const wait = $('waitBar');
    wait.innerHTML = '';
    if (!a) {
      if (!s.running && s.isHost) {
        const n = players.filter((p) => p.chips > 0).length;
        const btn = h('button', { className: 'btn gold', textContent: n < 2 ? 'Esperando jugadores…' : '▶ Empezar a jugar', disabled: n < 2 });
        btn.onclick = () => send('start');
        const bot = h('button', { className: 'btn', textContent: '🤖 + Bot' });
        bot.onclick = () => send('addBot', { level: 'normal' });
        wait.append(btn, bot);
        if (n < 2) wait.append(h('span', { textContent: 'Comparte el código con tus amigos, o suma bots para jugar ya.' }));
      } else if (!s.running) {
        wait.append('Esperando a que el anfitrión empiece la partida…');
      } else if (me && me.chips === 0 && !me.inHand) {
        wait.append('Te quedaste sin fichas. Pídele más al anfitrión en el chat.');
      }
    }
  }

  // animación del temporizador
  function tick() {
    if (state && deadline) {
      const left = Math.max(0, deadline - Date.now());
      const frac = state.turnTotal ? left / state.turnTotal : 0;
      document.querySelectorAll('.seat.turn .tbar div').forEach((d) => { d.style.width = (frac * 100) + '%'; });
      const mt = $('myTimer');
      mt.firstElementChild.style.width = (frac * 100) + '%';
      mt.classList.toggle('low', left < 8000);
      $('myTimerText').textContent = Math.ceil(left / 1000) + ' s';
    } else {
      $('myTimer').firstElementChild.style.width = '100%';
      $('myTimerText').textContent = state && state.actions ? 'Sin límite' : '';
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.addEventListener('resize', () => render());

  // Al recargar la página vuelve a la sala en la que estaba
  // (si llegó con un enlace a otra sala, no vuelve a la anterior).
  const saved = store.get('poker_room');
  const savedName = store.get('poker_name', '');
  if (saved && savedName && (!urlCode || urlCode.toUpperCase() === saved)) enter({ op: 'join', code: saved, name: savedName });
})();
