# Activar el registro de alertas (Medios → Alertas)

La pantalla **Medios → Alertas** guarda cada alerta que envía el cron (martes y jueves, 8:00 hs) para que el analista o el gerente de Medios las revise. Para guardarlas hace falta una base: **Upstash Redis**, desde el Storage de Vercel. Es gratis para este uso y se crea en un par de minutos.

**Mientras no esté activado**, el resumen se sigue enviando igual al espacio IGNITE; solo no queda registro, y la pantalla muestra estas instrucciones.

## Pasos

1. En Vercel, abrí el proyecto `dashboard-consumos-ignite` → pestaña **Storage**.
2. **Create Database** → elegí **Upstash Redis** (plan gratuito, la región más cercana).
3. Cuando te pregunte, **conectala a este proyecto** en los entornos **Production** y **Preview**.
4. Vercel agrega solo las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN` (no hay que copiarlas a mano). Si aparecen con los nombres `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, también funcionan.
5. Hacé un **Redeploy** de producción (las variables nuevas solo aplican a deploys nuevos).

## Verificar

- Abrí `/medios/alertas`: si la pantalla muestra "Registradas 0" (y no las instrucciones), el almacenamiento está activo.
- Después del próximo envío del cron (o de un envío manual con la ruta `/api/cron/notify` y el `CRON_SECRET`), el envío y sus alertas aparecen en la pantalla.
- La respuesta del envío manual incluye `"log": {"ok": true}` cuando quedó registrado, o el motivo si no.

## Qué se guarda

- **Cada envío**: fecha, canales con su resultado, el texto exacto de los mensajes enviados, y los datos que no se pudieron obtener. Se guarda aunque no haya habido alertas, y aunque el envío haya fallado.
- **Cada alerta**: tipo, gravedad, qué cuenta/campaña/anuncio, el detalle, y su estado de moderación con el historial completo.
- Las pruebas con `?dryRun=1` **no** se registran.

## Moderación

Cada alerta puede quedar **Pendiente**, **Revisada** o **Descartada**. Descartar exige escribir el motivo. Todos los cambios (quién, cuándo, nota) quedan en el historial de la alerta; nada se borra.

Solo modera quien tiene habilitada la página Medios · Alertas, y "quién modera" es la cuenta con la que se inició sesión en el SSO (ver [configurar el login con SSO](./configurar-sso-cloudflare.md)).

## Cuánto ocupa

Una alerta pesa poco más de 1 KB. Con 2 envíos por semana, el plan gratuito alcanza para años.
