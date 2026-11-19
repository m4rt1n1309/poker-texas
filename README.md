# Póker con Amigos (Texas Hold'em)

Póker Texas Hold'em multijugador para jugar con amigos, cada uno desde su celular o compu, sin instalar nada. Salas con código, fichas, chat y tiempo por turno.

**Jugar:** https://poker-texas-eight.vercel.app

## Cómo funciona

No tiene un servidor prendido todo el tiempo:

- **Vercel** publica la página (`public/`) y la función `api/room.js`.
- **Upstash Redis** (plan gratis) guarda cada sala. Las cartas se reparten y se guardan ahí, y la función le manda a cada jugador **solo sus cartas**: nadie puede espiar las de los demás, ni siquiera el anfitrión.
- Cada celular consulta la sala una vez por segundo (cada 4 s si la pestaña está en segundo plano). En cada consulta se aplica lo que tenía que pasar: turnos vencidos, cartas de un all-in, mano siguiente.
- Si dos jugadores mandan algo al mismo tiempo, la sala tiene un número de versión y la jugada que llega segunda se reintenta: no se pisan.
- Las salas sin movimiento se borran solas a las 24 horas.

## Publicar en Vercel (una sola vez)

1. En [vercel.com](https://vercel.com): **Add New → Project** e importar el repo `poker-texas`. No hace falta cambiar nada (la configuración está en `vercel.json`). **Deploy**.
2. En el proyecto: **Storage → Create Database → Upstash (Redis)**, plan gratis, y conectarla al proyecto. Eso crea solas las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN`.
3. **Deployments → ⋯ → Redeploy** para que tome las variables.

Desde ahí, cada push a `main` se publica solo.

> Si la página dice "Falta conectar la base de datos", es que falta el paso 2 o el 3.

## Cómo se juega

1. Uno escribe su nombre y toca **Crear sala** (elige fichas iniciales, ciegas y tiempo por turno).
2. Comparte el código de 4 letras o el botón **🔗 Invitar**.
3. Los demás entran con el código. Con 2 o más, el anfitrión toca **▶ Empezar a jugar**.

- **⚙️ Anfitrión:** pausar, cambiar ciegas y tiempo, dar o quitar fichas, sacar jugadores.
- **🂠 Cartas:** cada jugador elige cartas *dibujadas* o *clásicas* (con figuras).
- **💬 Chat** en la sala.
- Si se acaba el tiempo, el jugador pasa (si puede) o se retira. A quien está desconectado se le dan solo 5 segundos.
- Si alguien cierra la página o se queda sin internet, al volver a abrirla vuelve a su asiento con sus fichas.
- Atajos en la compu: `F` retirarse, `C` o espacio pasar/igualar, `R` subir.

## Desarrollo

```sh
npm install
npm run dev        # http://localhost:3000 (las salas se guardan en memoria)
npm test           # reglas, manos, botes, partidas simuladas y Redis
node test/bots.js ABCD 3     # suma 3 bots a la sala ABCD para probar
```

Con `npm run dev` también se puede jugar en la misma red WiFi: la consola muestra la dirección `http://192.168.x.x:3000`.

## Archivos

- `api/room.js`: la función de Vercel (crear, entrar, jugar, chat, consultar).
- `lib/game.js`: reglas de la mesa (turnos, apuestas, botes, temporizador).
- `lib/store.js`: guarda las salas en Upstash Redis (o en memoria en la compu).
- `public/poker.js`: mazo y evaluador de manos (lo usan la función y la página).
- `public/`: la página (`index.html`, `client.js`, `style.css`).
- `public/deck/`: mazo clásico *SVG-cards* (David Bellot y otros, licencia LGPL 2.1, ver `public/deck/LICENSE`).
- `dev-server.js`: servidor para probar en la compu (Vercel no lo usa).
