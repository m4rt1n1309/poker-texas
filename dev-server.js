// Servidor para probar en la compu (npm run dev). En Vercel no se usa: allá
// "public/" se publica como página y "api/room.js" como función.
const express = require('express');
const path = require('path');
const os = require('os');
const handler = require('./api/room');
const store = require('./lib/store');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.all('/api/room', handler);
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Póker listo en http://localhost:${PORT} (salas guardadas en ${store.kind})`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  En tu red WiFi: http://${n.address}:${PORT}`);
    }
  }
});
