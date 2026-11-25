# API de Cuentas (`/api/cuentas`)

Pantalla `/cuentas`. La usa quien tiene la página **Finanzas** (lo exige `middleware.ts` y se vuelve a verificar en la ruta).

## `GET /api/cuentas?range=…[&from=…&to=…][&cuenta=<accountId>]`

`range` acepta los mismos valores que el resto de Pulso (`month`, `lastmonth`, `28d`, `custom` con `from` y `to`) y uno propio, `plan`: desde el inicio del plan cargado hasta hoy (tope de 366 días).

Responde el gasto real de **Meta** (vía Windsor) ordenado por marca, ocasión y objetivo (`resumen`), y la ejecución de cada línea del presupuesto (`ejecucion`: ejecutado, porcentaje y saldo). Nunca devuelve datos de ejemplo: si Windsor falla y no hay un resultado reciente, responde error.

## `PUT /api/cuentas`

Guarda el presupuesto del año: `{ inicio: "AAAA-MM-DD", lineas: [{ id?, nombre, monto, marcas[] }] }`. Queda en Upstash Redis (`pulso:cuentas:presupuesto`) con auditoría de quién lo cambió (`pulso:cuentas:presupuesto:audit`, las últimas 100).

## Metas del plan de medios

Cada línea del presupuesto puede llevar `metas: { impresiones?, alcance?, cpm? }`. `GET` devuelve por línea lo medido en las plataformas (`plataformas`: gasto, impresiones, alcance y CPM, sin lo cargado a mano) y la pantalla lo compara con la meta. El alcance es la suma del alcance de cada campaña, así que sobrestima el alcance único. El alcance de 3 o más contactos y la frecuencia única no se calculan.

## `POST` / `PUT` / `DELETE /api/cuentas/gastos`

Gastos fuera de las plataformas (UGC, envíos, shooting, influencers, otros). Cada uno es `{ fecha, lineaId, categoria, detalle, campana?, monto }` y cuenta contra una línea del presupuesto (por eso el presupuesto tiene que estar cargado). `PUT` lleva además `id`; `DELETE` usa `?id=`. Se guardan en Upstash Redis (`pulso:cuentas:gastos`) con auditoría (`pulso:cuentas:gastos:audit`, las últimas 200). La lista del período vuelve dentro de `GET /api/cuentas` (`gastos` y `gastosPorCampana`), y su suma entra en el ejecutado de cada línea (`aMano` muestra la parte cargada a mano).

## Cómo se clasifica

Se lee el nombre de la campaña (`lib/cuentasCore.ts`, `clasificarCampana`):

`TQN_<OCASIÓN>_META_<OBJETIVO>_…_<MARCA>`

- **Objetivo:** `CONS_AWA` = Awareness, `CONS_VIS` = Consideración, `CONV` o `CON` = Conversión.
- **Ocasión:** lo que va entre `TQN_` y `_META` (tabla `OCASIONES`; una ocasión nueva aparece con su nombre tal cual).
- **Marca:** EPA, Torpedo, Oreo, Kit Kat, Chomp, Sin Parar. Más de una marca, o `MULTI` en el nombre, = **Multimarca**.
- Lo que no se reconoce queda en «Sin clasificar» y se lista aparte.

Una campaña multimarca no se reparte entre sus marcas: para eso hace falta ver el link de cada anuncio (la planilla lo hace a mano). Está pendiente.

## Pendiente (próximos pasos)

TikTok / YouTube / programmatic, y las visitas a Rappi y PedidosYa como resultado.
