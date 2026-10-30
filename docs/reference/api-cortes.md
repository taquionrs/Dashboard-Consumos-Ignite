# API — `/api/cortes`

Cortes de finanzas: una **foto congelada** del consumo de pauta de un período (por cuenta, plataforma y campaña), con el presupuesto y las [equivalencias con Superlum](../reference/variables-de-entorno.md#equivalencias-con-superlum-clientes-y-proyectos) de ese momento. Es lo que más adelante se envía a Superlum y al P&L. Pantalla: `/cortes`. Código: [`lib/cortesCore.ts`](../../lib/cortesCore.ts) (forma y reglas, puro), [`lib/cortes.ts`](../../lib/cortes.ts) (almacenamiento) y [`app/api/cortes/route.ts`](../../app/api/cortes/route.ts).

Los usa quien tiene la página **Finanzas**. Se guardan en la misma base Upstash que usuarios y equivalencias (`pulso:cortes` y `pulso:cortes:resumen`); no hace falta ninguna variable nueva.

## Endpoints

| Método | Qué hace |
|---|---|
| `GET /api/cortes` | `{ configured, cortes, hayMas }`: los resúmenes, más nuevos primero (hasta 100). |
| `GET /api/cortes?id=…` | `{ corte }`: el corte completo. 404 si no existe. |
| `POST /api/cortes` | Genera y guarda un corte nuevo. Cuerpo: `{ "preset": "month" }` o `{ "desde": "AAAA-MM-DD", "hasta": "AAAA-MM-DD" }`. |

Presets: `today`, `yesterday`, `7d`, `14d`, `28d`, `month`, `lastmonth` (los mismos que Finanzas). Con fechas propias: ambas inclusive, hasta 366 días, y una fecha futura se corta en hoy.

## Reglas

- **Un corte no se edita ni se borra.** Si hay que rehacer un período se genera otro; el más nuevo es el vigente.
- **Nunca con datos de ejemplo ni viejos.** Sin conexión a Windsor, o si Windsor no responde y solo hay una copia anterior en caché, `POST` responde error en vez de guardar una foto dudosa.
- **El dato que falta va `null`, nunca `0`** («sin presupuesto cargado» no es «presupuesto cero»).
- **El presupuesto de la hoja es del mes en curso.** Solo se compara con el consumo si el corte empieza el día 1 del mes en curso (mes a la fecha o mes completo). En cualquier otro período el corte lleva el consumo real y deja `presupuesto`, `remanente` y `ritmoPct` en `null`, con un aviso.
- `ritmoPct` = proyección a fin de mes sobre el presupuesto: `(real / días del corte × días del mes) / presupuesto`. 100 = justo en ritmo.
- `vinculo` sale de [/equivalencias](../../app/equivalencias/page.tsx) al momento de generar; una cuenta sin vincular lleva `null`.
- `totales.presupuestoManual` es el «Total presupuesto» que carga a mano Finanzas: un solo número, no depende del período.

## Forma del corte

```jsonc
{
  "id": "2026-10-01_2026-10-30_20261030120000_a1b2",
  "version": 1,
  "desde": "2026-10-01", "hasta": "2026-10-30", "dias": 30,
  "generadoEn": "…", "generadoPor": "mail@taquion.com.ar", "datosAl": "…", "fuente": "windsor",
  "presupuestoComparable": true,
  "totales": { "real": 0, "presupuesto": 0, "remanente": 0, "presupuestoManual": null, "cuentasSinVincular": 0 },
  "cuentas": [{
    "accountId": "1341176124575503", "nombre": "…",
    "presupuesto": 0, "real": 0, "remanente": 0, "ritmoPct": 100,
    "plataformas": [{ "plataforma": "meta", "pct": 100, "presupuesto": 0, "real": 0 }],
    "campanas": [{ "campaignId": "…", "campaignName": "…", "presupuesto": null, "real": 0 }],
    "vinculo": { "clienteId": "…", "clienteNombre": "…", "proyectoId": null, "proyectoNombre": null }
  }],
  "avisos": []
}
```
