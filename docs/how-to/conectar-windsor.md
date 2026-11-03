# Cómo conectar Windsor.ai (Google Ads)

Asume que ya tenés el proyecto corriendo (ver [tutorial de arranque](../tutorials/getting-started.md)) y que **ya conectaste la cuenta de Google Ads dentro de Windsor.ai** (en la UI de Windsor, no acá). Esta guía es sobre el lado del código: qué tocar para que `/api/spend` empiece a leer esos datos en vez de mock.

Esta es la vía **prioritaria** sobre la integración directa a Google Ads API (`lib/googleAds.ts` / [conectar Google Ads API](./conectar-google-ads.md)) — ver [Decisión de arquitectura de datos](../explanation/arquitectura-de-datos.md). Si `WINDSOR_API_KEY` está presente, `/api/spend` ni siquiera llega a mirar las credenciales de Google Ads directo.

## No hace falta mapear nada de antemano

Con solo `WINDSOR_API_KEY`, `/api/spend` trae **todas** las cuentas de Google Ads que Windsor.ai tenga conectadas y las muestra como filas propias — nombre real, gasto real, $0 incluido si corresponde. `lib/windsor.ts` las descubre en 3 capas, cada una cubre lo que la anterior no puede ver:

1. **El período elegido en el selector de fecha** (mes en curso por defecto) — spend y conversiones reales.
2. **Ventana ampliada, derivada de ese mismo período** (ver `discoveryWindowFor` en `lib/windsor.ts` — nunca una constante fija como "12 meses", corregido 2026-09-22 a pedido explícito: el selector de período es el que delimita toda ventana temporal del dashboard) — encuentra cuentas con actividad reciente pero nada en el período elegido (Windsor no manda una fila con spend $0, directamente omite la cuenta si no tuvo ningún evento en el rango pedido).
3. **Endpoint de cuentas conectadas** de Windsor.ai — encuentra cuentas que nunca tuvieron ni un solo evento (ej. sin campañas creadas todavía). Esta capa es metadata sin fecha, no depende del período elegido.

Las capas 2 y 3 solo aportan el nombre de la cuenta; si no tuvo actividad este mes, el gasto queda en $0. **En cuanto hay al menos una cuenta real, los 4 clientes mock (Norte Fintech, Andes Turismo, Terra Realty, MetroVoz) desaparecen de la vista** — dejan de aportar una vez que hay datos reales. Si Windsor no tiene ninguna cuenta conectada (o falla la consulta), se sigue mostrando el mock completo, para que la tabla nunca quede vacía.

## Presupuesto proyectado (media plan) — hoja de Google Sheets

Las cuentas reales aparecen con `$0` de objetivo y "Sin objetivo cargado" hasta que exista un presupuesto proyectado para cruzar. Eso sale de una **"Hoja maestra de proyectados"** en Google Sheets, conectada a Windsor.ai como una fuente más (connector `googlesheets`, no una herramienta nueva) — ver [`lib/mediaPlan.ts`](../../lib/mediaPlan.ts).

**Columnas que tiene que tener la hoja**, en la primera fila (Windsor las toma tal cual están escritas, sin normalizar):

| Columna | Formato | Ejemplo |
|---|---|---|
| `cliente` | texto libre — hoy es solo referencia humana en la hoja, no se cruza con nada | `norte` |
| `plataforma` | `google`, `meta`, `tiktok` o `linkedin` | `google` |
| `mes` | `2026-09` o `2026-09-01` (los 2 formatos sirven) | `2026-09` |
| `cuenta` | el `account_id` real tal cual aparece en Windsor.ai — es lo que cruza esta fila con la cuenta real del dashboard | `6551720043` |
| `campaña` (o `campana`) | **opcional** — escribila con tilde en la hoja; el dashboard prueba las dos grafías contra Windsor y usa la que acepte (ver nota abajo). Vacía = presupuesto de la CUENTA entera (como antes). Completa con el nombre exacto de campaña (copiado de Windsor/de la tabla de Campañas de Medios, no retipeado) = presupuesto específico de esa campaña, que se ve desglosado en la vista Finanzas | `TQN_AON_META_INTERACCION_RMARCA_MANUAL_LA_COMUNIDAD` |
| `presupuesto_proyectado` | número plano, sin `$` ni separador de miles | `1200000` |

Si una cuenta tiene al menos una fila con `campaña` cargada para el mes, el presupuesto de la CUENTA (el que se ve en Finanzas a nivel cuenta y en los chips de arriba) pasa a ser la **suma de sus campañas** — la fila de cuenta (sin `campaña`), si también existe, se ignora a propósito para no mantener dos números que puedan desincronizarse.

⚠️ **Sobre la tilde de `campaña`**: el nombre real de esta columna, tal como lo expone el connector de Windsor, cambió de grafía dos veces en vivo sin que se tocara la hoja (primero pedía "campaña" con tilde y rechazaba "campana"; después, al revés). No se llegó a determinar la causa exacta del lado de Windsor. Por eso `fetchMediaPlanTargets()` en `lib/mediaPlan.ts` ya no asume una sola grafía: prueba `campaña` y, si Windsor la rechaza puntualmente por ese campo, reintenta con `campana`. Si en el futuro Windsor deja de aceptar las dos, el warning en pantalla ("Hoja de proyectados... falló la consulta") va a traer el detalle de ambos intentos.

Para conectarla, son **2 pasos** en Windsor.ai — los dos hacen falta, no alcanza con el primero:

1. **Add data → Google Sheets**: compartir la hoja como *Viewer* con el service account que muestra la pantalla → pegar el link de la hoja → **Add Account**.
2. **Preview and Destination**: revisar la preview de filas reales y **seleccionar explícitamente** las 6 columnas (`cliente`, `plataforma`, `mes`, `cuenta`, `campaña`, `presupuesto_proyectado`) en la lista de "Fields" → confirmar. Sin este paso, la hoja queda "agregada" pero Windsor sigue devolviendo 0 filas para esos campos — verificado en vivo 2026-09-21.

No hace falta ninguna variable de entorno nueva — usa la misma `WINDSOR_API_KEY`. La consulta en `lib/mediaPlan.ts` sí necesita `date_from`/`date_to` (un año hacia atrás) para traer algo — sin fecha, Windsor devuelve 0 filas aunque la hoja esté bien conectada; las filas de la hoja no tienen una noción de fecha propia, así que un rango amplio no filtra nada real, solo evita que la consulta vuelva vacía.

El presupuesto proyectado es el de los meses del período elegido: "Este mes" → el mes en curso; "Mes anterior" → ese mes (si la hoja todavía tiene sus filas); un rango propio que abarca dos meses suma los dos presupuestos mensuales completos (sin prorratear) y la pantalla avisa. Un mes cuenta si el período cubre al menos la mitad de sus días; los períodos cortos que cruzan un cambio de mes (ej. "7 días" el día 3) usan el mes en el que terminan. Reglas en `budgetMonthsFor` de `lib/mediaPlan.ts`.

Sin ninguna fila para una cuenta en esos meses, esa cuenta se queda en `$0` / "Sin objetivo cargado" — igual que antes, nunca se inventa un número.

Esas cuentas reales todavía no tienen presupuesto cargado (no hay media plan asociado) — "Presupuesto proyectado" sale en `$0` y el estado en "Sin objetivo cargado" hasta que exista ese dato (ver [estado y limitaciones](../explanation/estado-y-limitaciones.md)).

`WINDSOR_GOOGLE_ADS_ACCOUNT_MAP` queda como mecanismo **opcional** para el caso contrario: si ya sabés que una cuenta real corresponde a uno de los clientes mock, podés pisar el spend de ese cliente puntual en vez de que aparezca como fila nueva (`cliente_interno:account_id`, ver [referencia de variables de entorno](../reference/variables-de-entorno.md)).

## Pasos

1. Copiá `.env.example` a `.env.local` si todavía no lo hiciste:
   ```bash
   cp .env.example .env.local
   ```
2. Completá `WINDSOR_API_KEY` (Windsor.ai UI → Account → API Key). En producción ya está cargada en Vercel desde `marketing@taquion.com.ar` — para desarrollo local, copiala también a `.env.local`.
3. Reiniciá el servidor de desarrollo:
   ```bash
   npm run dev
   ```
4. Listo — no hace falta ningún otro paso. `WINDSOR_GOOGLE_ADS_ACCOUNT_MAP` es opcional (ver arriba).

## Verificar que funcionó

- El banner superior debería cambiar de "Datos de ejemplo" a "Google Ads conectado vía Windsor.ai".
- El pie de página debería decir "Google Ads vía Windsor.ai (en vivo)".
- Deberías ver una fila nueva por cada cuenta real conectada en Windsor.ai, con su nombre real.
- Si algo falla, vas a ver un banner de advertencia amarillo con el mensaje de error específico (la app cae a mock, no se rompe entera).

**El dato real es siempre el que devuelve Windsor.ai, $0 incluido — sin excepción y sin fallback a mock ni avisos por cada cero.** La tabla de Finanzas muestra 4 cosas puntuales por cliente×plataforma (a pedido explícito del usuario, ver historial de `specs/003-dashboard-consumos.md`), todas derivadas del par `budget`/`spend8` — no de `cpl`, que es otra métrica (costo por resultado) que esta tabla ya no muestra:

- **Presupuesto proyectado** — `budget`. `$0` sin media plan cargado para esa cuenta.
- **Real** — `spend8`, el gasto real acumulado a la fecha de corte, siempre el mismo concepto sin importar el tipo de fila (cuenta real nueva o cliente mock).
- **Ritmo de consumo** — `spend8 / budget`, en %.
- **Remanente** — `budget - spend8` (negativo si se pasó del presupuesto).

Sin presupuesto cargado, el estado queda en "Sin objetivo cargado" en vez de fabricar un pacing con `budget = 0`.

## Si algo no funciona

Las 3 capas de descubrimiento (período elegido, ventana ampliada derivada de ese período, endpoint de cuentas conectadas) ya están verificadas contra la cuenta real de Taquión (2026-09-10) — ver la nota al principio de [`lib/windsor.ts`](../../lib/windsor.ts). Si de todas formas una cuenta no aparece, revisá el banner de warning: cada una de las 3 capas avisa explícitamente si falla, en vez de fallar en silencio. Para inspeccionar una respuesta real a mano:

```
https://connectors.windsor.ai/google_ads?api_key=TU_KEY&fields=account_id,account_name,date,spend&date_from=2026-09-01&date_to=2026-09-10
https://onboard.windsor.ai/api/common/ds-accounts?datasource=google_ads&api_key=TU_KEY
```

## Estado por plataforma

El orden de prioridad confirmado es Google Ads → Meta → TikTok → YouTube → LinkedIn (ver [specs/003-dashboard-consumos.md](../../../specs/003-dashboard-consumos.md) en `SDD-TAQUION`). `lib/windsor.ts` ya trae las 3 primeras — cada una es una entrada en `PLATFORM_SOURCES` (`platformKey`, `connector` de Windsor, `label`, su env var de mapeo opcional). Para sumar una plataforma nueva: agregar su entrada ahí (confirmando primero el nombre del connector contra la documentación pública de Windsor, no asumirlo) y, si hace falta, su `WINDSOR_<PLATAFORMA>_ACCOUNT_MAP` en `.env.example`.

YouTube y LinkedIn todavía no entran en el plan Basic de Windsor (3 fuentes, ya llenas con Google Ads + Meta Ads + TikTok Ads) — necesitan un upgrade de plan antes de poder conectarse. Ver el detalle de plan y prioridades en la spec.
