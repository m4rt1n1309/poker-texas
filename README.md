# Póker con Amigos (Texas Hold'em)

Póker Texas Hold'em multijugador para jugar con amigos, cada uno desde su celular o compu, sin instalar nada. Salas con código, fichas, chat, tiempo por turno y **bots que mienten**.

**Jugar:** https://poker-con-amigos.vercel.app

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

- **🤖 Practicar contra bots:** desde el inicio, arma una mesa con 3 bots (fácil, normal y difícil) y empieza sola.
- **⚙️ Anfitrión:** pausar, cambiar ciegas y tiempo, agregar bots, dar o quitar fichas, sacar jugadores.
- **🂠 Cartas:** cada jugador elige cartas *dibujadas* o *clásicas* (con figuras).
- **💬 Chat** en la sala.
- Si se acaba el tiempo, el jugador pasa (si puede) o se retira. A quien está desconectado se le dan solo 5 segundos.
- Si alguien cierra la página o se queda sin internet, al volver a abrirla vuelve a su asiento con sus fichas.
- Atajos en la compu: `F` retirarse, `C` o espacio pasar/igualar, `R` subir.

## Los bots

Juegan en el servidor (en la función de Vercel), así que no ven las cartas de nadie y siguen
jugando aunque el anfitrión cierre la página. En su turno:

1. Calculan qué tan buena es su mano simulando cientos de finales posibles contra manos al azar.
2. La comparan con lo que cuesta seguir (lo que hay que poner contra lo que hay en el bote).
3. **Mienten:** a veces apuestan fuerte sin tener nada (farol) y siguen mintiendo en las calles
   siguientes; otras veces, con una mano enorme, solo pasan o igualan para hacerse los débiles.
   En el chat también pueden decir cosas que no son verdad ("Qué mano fea me tocó 😩" con un póker de ases).
4. Los **difíciles** además se fijan en cada rival: contra el que nunca se retira mienten menos y
   apuestan más fuerte con buena mano; contra el que se asusta fácil, mienten más.

| Nivel | Cómo juega |
|---|---|
| Fácil | Se equivoca al leer su mano, paga de más y casi no miente. |
| Normal | Juega bien y miente de vez en cuando. |
| Difícil | Calcula con más precisión, miente más y se adapta a cada rival. |

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
- `lib/bots.js`: cómo piensan y mienten los bots.
- `lib/store.js`: guarda las salas en Upstash Redis (o en memoria en la compu).
- `public/poker.js`: mazo y evaluador de manos (lo usan la función y la página).
- `public/`: la página (`index.html`, `client.js`, `style.css`).
- `public/deck/`: mazo clásico *SVG-cards* (David Bellot y otros, licencia LGPL 2.1, ver `public/deck/LICENSE`).
- `dev-server.js`: servidor para probar en la compu (Vercel no lo usa).
