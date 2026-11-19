// Agrega bots a una sala para probar: node test/bots.js CODIGO [cantidad] [url]
// Juegan igual que un celular: consultan /api/room cada segundo y mandan sus jugadas.
const [code, n = 3, base = 'http://localhost:3000'] = process.argv.slice(2);
if (!code) { console.log('Uso: node test/bots.js CODIGO [cantidad] [url]'); process.exit(1); }
const names = ['Lucía', 'Pedro', 'Sofi', 'Nico', 'Caro', 'Juan', 'Vale', 'Tomi'];

async function post(body) {
  const r = await fetch(`${base}/api/room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function bot(i) {
  const token = `bot-${code}-${i}-token`;
  const res = await post({ op: 'join', code, token, name: names[i] });
  if (res.error) return console.log(names[i], res.error);
  console.log(names[i], 'entró a la sala', code);
  let acted = null;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await (await fetch(`${base}/api/room?code=${code}&token=${token}`)).json().catch(() => ({}));
    if (st.gone || st.error) return console.log(names[i], 'salió:', st.error || 'ya no está en la sala');
    const a = st.actions;
    if (!a) continue;
    const key = `${st.handNo}-${st.stage}-${a.currentBet}`;
    if (acted === key) continue;
    acted = key;
    const type = a.canCheck ? 'check' : Math.random() < 0.2 ? 'fold' : 'call';
    await post({ op: 'action', code, token, type });
  }
}
for (let i = 0; i < Number(n); i++) bot(i);
