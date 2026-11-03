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

## Enviar un corte a Superlum — `POST /api/cortes/<id>/enviar`

Manda un corte guardado a Superlum (`/api/integrations/pulso/corte`), que lo valida y lo reenvía al backend financiero, donde queda como **pauta real por cuenta y mes**. En esta etapa **no cambia los números del P&L**. Contrato completo en `docs/integracion-pulso-cortes.md` del repo `superlum-prod`. Botón «Enviar» / «Reenviar» en `/cortes`.

- Para quien tiene la página **Finanzas**. Código: [`lib/enviarCorte.ts`](../../lib/enviarCorte.ts) (firma y lectura de la respuesta) y [`app/api/cortes/[id]/enviar/route.ts`](../../app/api/cortes/[id]/enviar/route.ts).
- El cuerpo es `{ "evento": "corte.pulso", "enviadoEl": "<ahora>", "corte": { …el corte guardado… } }` y va firmado con `x-pulso-signature: sha256=<HMAC-SHA256 del cuerpo exacto, con PULSO_SHARED_SECRET>`. La hora se pone al enviar: Superlum rechaza un pedido de más de 10 minutos.
- **Reenviar es seguro:** el backend reconoce el corte por su identificador y no duplica nada. Un corte más nuevo de la misma cuenta y mes reemplaza al anterior; uno más viejo se omite.
- El resultado del último envío (también si Superlum lo rechaza) se guarda aparte —`pulso:cortes:envios` en Upstash; el corte no se modifica— y se ve en la columna «Envío a Superlum»: cuántas cuentas guardó el backend y cuáles omitió, con el motivo.
- Antes de enviar, la pantalla avisa (sin impedirlo) si el corte **cruza meses** (el backend lo omite: el P&L es mensual), si no tiene cuentas o si hay cuentas **sin vincular** en Equivalencias.

Respuesta: `{ "ok": true|false, "envio": { enviadoEn, enviadoPor, ok, status, mensaje, aplicadas, omitidas[], advertencias[], reemplaza } }` con estado 200 aunque Superlum lo rechace (el motivo viaja en `envio`). Un error propio de Pulso responde 4xx/5xx con `{ "error": "…" }`:

| Estado | Cuándo |
|---|---|
| 400 | identificador de corte inválido |
| 403 | no tiene la página Finanzas |
| 404 | el corte no existe |
| 503 | falta Upstash, falta `PULSO_SHARED_SECRET` (32+ caracteres) o `SUPERLUM_PULSO_URL` no es https |
