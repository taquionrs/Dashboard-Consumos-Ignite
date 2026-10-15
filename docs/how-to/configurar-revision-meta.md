# Configurar la revisión de campañas de Meta

La revisión diaria de campañas lee la API de Meta (**solo lectura**) con el token de un usuario del sistema del Business Manager de Taquion, y avisa a Google Chat y a Medios → Alertas cuando detecta algo. Sin `META_ACCESS_TOKEN` está apagada y Pulso funciona igual que antes.

Qué detecta (umbrales en [`lib/metaAudit.ts`](../../lib/metaAudit.ts), `META_THRESHOLDS`):

- **Anuncio activo sin entrega:** activo hace más de 24 horas y sin una sola impresión en los últimos 3 días.
- **Sin el pixel de Taquion:** campaña de conversión en el sitio sin el pixel en el conjunto de anuncios o en el seguimiento del anuncio.
- **Gasta y no registra resultados:** campaña de conversión con 20.000 o más de gasto en 3 días y cero resultados.
- **Campaña nueva sin completar:** campaña de los últimos 7 días sin presupuesto o sin parámetros UTM.
- **Anuncio rechazado o con problemas.**
- **Cuenta publicitaria con problema de pago o restringida.**

## 1. Crear el usuario del sistema

En business.facebook.com → **Configuración del negocio**:

1. **Usuarios → Usuarios del sistema → Agregar**. Nombre: `Pulso Ignite - solo lectura`. Rol: **Empleado** (no Administrador).
2. Con el usuario seleccionado, **Asignar activos → Cuentas publicitarias**: marcar las cuentas que usa Pulso y darles **solo "Ver rendimiento"**. No activar "Administrar campañas".
3. **Generar token**: elegir la aplicación del negocio (si no hay, crear una de tipo "Empresa" en developers.facebook.com y asociarla al negocio), vencimiento "Nunca" si aparece, permiso **solo `ads_read`**. Copiar el token: Meta lo muestra una sola vez.

## 2. Cargar las variables en Vercel (Production)

| Variable | Qué es | Tipo |
|---|---|---|
| `META_ACCESS_TOKEN` | El token del paso anterior | **Sensitive** |
| `META_PIXEL_IDS` | ID(s) del pixel de Taquion (Administrador de eventos), separados por coma. Sin esto no se evalúa la alerta de pixel | Config |
| `META_AD_ACCOUNT_IDS` | Opcional: cuentas a revisar. Sin esto, todas las asignadas al usuario del sistema | Config |
| `META_REQUIRE_UTM` | Opcional: `0` apaga el chequeo de UTM | Config |
| `META_GRAPH_VERSION` | Opcional, por defecto `v23.0` | Config |

Después hay que redesplegar.

## 3. Probar

Con el header `Authorization: Bearer <CRON_SECRET>`:

- `GET /api/cron/calentar?soloMeta=1&dryRun=1` → corre la revisión y devuelve el mensaje que se mandaría, sin enviar ni guardar nada. Si algo falla, `metaReview.error` dice qué.
- `GET /api/cron/calentar?soloMeta=1` → la corre de verdad (avisa a Chat y registra).

## Cómo funciona en producción

- **Todos los días** (junto con el calentamiento de Windsor, ~7:30 hs de Argentina) se revisa Meta y se avisa **solo lo nuevo**: una alerta ya avisada no se repite en el chat durante 3 días (sigue visible en Medios → Alertas).
- **Martes y jueves** el resumen completo incluye una sección "Revisión de campañas · Meta" con todo lo abierto.
- Si una cuenta no se puede leer, se avisa en el mensaje; si no se puede leer ninguna, la sección figura como no disponible.
- El token va en el encabezado `Authorization` y nunca aparece en URLs, mensajes de error ni respuestas.
- Meta nombra de varias formas los resultados de conversión (`purchase`, `offsite_conversion.fb_pixel_purchase`, `lead`...): ver `RESULT_ACTION` en [`lib/metaGraph.ts`](../../lib/metaGraph.ts) si una campaña legítima figura como "sin resultados".
