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

## Calibración con la cuenta real (2026-10-15)

La primera prueba en seco contra la cuenta real de Taquion devolvió **2.014 alertas**, casi todas falsas, y se corrigió antes de avisar nada:

- Los anuncios con una advertencia menor ("Revisa 1 advertencia") eran miles, la mayoría de campañas pausadas o archivadas. Ahora solo cuentan los anuncios **realmente prendidos** (el anuncio, su conjunto y su campaña) y se agrupan en **un aviso por campaña**.
- El pixel solo se exige a campañas que optimizan **conversiones en el sitio** (ventas, o conjuntos con optimización por conversiones). Los leads con formulario, WhatsApp, tráfico e interacción no llevan pixel de conversión.
- Hay un **freno**: si una corrida detecta más de 40 alertas nuevas (`META_MAX_ALERTS`), no avisa ni registra nada y responde error. Mirá siempre el detalle con `?soloMeta=1&dryRun=1` antes de tocar el límite.

## Cómo funciona en producción

- **Martes y jueves (8:00 hs de Argentina)** el resumen incluye la sección "Revisión de campañas · Meta" con todo lo abierto, y queda registrado en Medios → Alertas. **Es el único momento en que la revisión avisa al canal**, como se planificó.
- El cron diario (~7:30) solo calienta Windsor y no manda mensajes. La revisión diaria, que avisa solo lo nuevo (no repite una alerta ya avisada durante 3 días), quedó disponible pero apagada: se activa con `META_DAILY_REVIEW=1`, o a mano con `?soloMeta=1`.
- Si una cuenta no se puede leer, se avisa en el mensaje; si no se puede leer ninguna, la sección figura como no disponible.
- El token va en el encabezado `Authorization` y nunca aparece en URLs, mensajes de error ni respuestas.
- Meta nombra de varias formas los resultados de conversión (`purchase`, `offsite_conversion.fb_pixel_purchase`, `lead`...): ver `RESULT_ACTION` en [`lib/metaGraph.ts`](../../lib/metaGraph.ts) si una campaña legítima figura como "sin resultados".
