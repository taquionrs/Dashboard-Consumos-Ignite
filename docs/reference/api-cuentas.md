# API de Cuentas (`/api/cuentas`)

Pantalla `/cuentas`. La usa quien tiene la página **Finanzas** (lo exige `middleware.ts` y se vuelve a verificar en la ruta).

## `GET /api/cuentas?range=…[&from=…&to=…][&cuenta=<accountId>]`

`range` acepta los mismos valores que el resto de Pulso (`month`, `lastmonth`, `28d`, `custom` con `from` y `to`) y uno propio, `plan`: desde el inicio del plan cargado hasta hoy (tope de 366 días).

Responde el gasto real de **Meta** (vía Windsor) ordenado por marca, ocasión y objetivo (`resumen`), y la ejecución de cada línea del presupuesto (`ejecucion`: ejecutado, porcentaje y saldo). Nunca devuelve datos de ejemplo: si Windsor falla y no hay un resultado reciente, responde error.

## `PUT /api/cuentas`

Guarda el presupuesto del año: `{ inicio: "AAAA-MM-DD", lineas: [{ id?, nombre, monto, marcas[] }] }`. Queda en Upstash Redis (`pulso:cuentas:presupuesto`) con auditoría de quién lo cambió (`pulso:cuentas:presupuesto:audit`, las últimas 100).

## Cómo se clasifica

Se lee el nombre de la campaña (`lib/cuentasCore.ts`, `clasificarCampana`):

`TQN_<OCASIÓN>_META_<OBJETIVO>_…_<MARCA>`

- **Objetivo:** `CONS_AWA` = Awareness, `CONS_VIS` = Consideración, `CONV` o `CON` = Conversión.
- **Ocasión:** lo que va entre `TQN_` y `_META` (tabla `OCASIONES`; una ocasión nueva aparece con su nombre tal cual).
- **Marca:** EPA, Torpedo, Oreo, Kit Kat, Chomp, Sin Parar. Más de una marca, o `MULTI` en el nombre, = **Multimarca**.
- Lo que no se reconoce queda en «Sin clasificar» y se lista aparte.

Una campaña multimarca no se reparte entre sus marcas: para eso hace falta ver el link de cada anuncio (la planilla lo hace a mano). Está pendiente.

## Pendiente (próximos pasos)

Gasto fuera de plataformas (UGC, envíos, shooting), metas del plan de medios (impresiones, alcance, frecuencia), TikTok / YouTube / programmatic, y las visitas a Rappi y PedidosYa como resultado.
