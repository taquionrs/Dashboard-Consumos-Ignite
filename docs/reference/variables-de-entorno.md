# Variables de entorno

Plantilla completa en [`.env.example`](../../.env.example). Copiala a `.env.local` para desarrollo local; en producción se cargan en Vercel (Project Settings → Environment Variables — ver [cómo deployar](../how-to/deploy-a-vercel.md)).

**Ninguna de estas variables es obligatoria para correr el proyecto en local** — si faltan, `/api/spend` usa el dataset de ejemplo automáticamente (ver [comportamiento de fallback](./api-spend.md#comportamiento-de-fallback)). En **producción** sí son obligatorias las del [login con SSO](#login-con-sso-y-usuarios): sin ellas Pulso no deja entrar a nadie.

## Login con SSO y usuarios

Para entrar a Pulso hay que iniciar sesión con Cloudflare Zero Trust (aplicación SaaS OIDC), y cada persona ve solo las páginas que le habilitó un administrador en `/usuarios`. Paso a paso en [configurar el login con SSO](../how-to/configurar-sso-cloudflare.md); el código está en [`middleware.ts`](../../middleware.ts), [`lib/auth.ts`](../../lib/auth.ts), [`lib/oidc.ts`](../../lib/oidc.ts) y [`lib/users.ts`](../../lib/users.ts).

| Variable | Obligatoria | Descripción |
|---|---|---|
| `OIDC_ISSUER` | Sí, en producción | Emisor de la aplicación OIDC de Cloudflare: `https://quiet-lab-fdf2.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>`. |
| `OIDC_CLIENT_ID` | Sí, en producción | ID de cliente de esa aplicación. |
| `OIDC_CLIENT_SECRET` | Sí, en producción | Secreto de cliente. **Es una credencial**: solo en el hosting, como *Sensitive*. |
| `SESSION_SECRET` | Sí, en producción | Clave aleatoria de 32+ caracteres que firma la cookie de sesión. Cambiarla cierra todas las sesiones. **Es una credencial.** |
| `ADMIN_EMAILS` | Sí, para poder administrar | Administradores fijos, separados por coma: ven todo y no se pueden quitar desde `/usuarios`. |
| `PULSO_PUBLIC_URL` | Recomendada | `https://pulso.taquion.com.ar`. Es la URL de vuelta del login, y quien abre una pantalla por otro dominio (`*.vercel.app`, `*.netlify.app`) es redirigido acá. |
| `ALLOWED_EMAIL_DOMAINS` | No | Dominios que pueden entrar y darse de alta, separados por coma. Por omisión `taquion.com.ar` (lo mismo que deja pasar la política de Cloudflare). |
| `SESSION_HOURS` | No | Duración de la sesión de Pulso, de 1 a 24 horas. Por omisión 12. |
| `PULSO_DEV_EMAIL` / `PULSO_DEV_PAGES` | No — solo desarrollo local | Sin las variables `OIDC_*` y fuera de producción, `npm run dev` entra con este usuario y estas páginas (por omisión `dev@taquion.com.ar`, todas las páginas y administrador; ej. `PULSO_DEV_PAGES=anuncios,alertas`). Se ignoran en producción. |

El registro de usuarios usa la misma base Upstash del [registro de alertas](#registro-de-alertas-upstash-redis) (`KV_REST_API_URL`/`KV_REST_API_TOKEN`). Sin ella solo entran los administradores fijos.

Sin `OIDC_*`/`SESSION_SECRET` en producción, todas las pantallas y rutas `/api/*` responden **503**: el sitio nunca se abre por omisión. La única ruta que no pasa por el login es `/api/cron/notify` (ver [Resumen diario](#resumen-diario-al-equipo-google-chat-yo-email)).

## Google Ads API

Las 5 variables siguientes tienen que estar **todas** presentes para que `hasGoogleAdsCredentials()` devuelva `true` — ver [cómo conectar Google Ads](../how-to/conectar-google-ads.md) para el detalle de dónde conseguir cada una.

| Variable | Obligatoria si usás Google Ads real | Descripción |
|---|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Sí | Token de Google Ads UI → Centro de API. Verificar nivel de acceso (Test vs. Basic/Standard). |
| `GOOGLE_ADS_CLIENT_ID` | Sí | Cliente OAuth2, de Google Cloud Console |
| `GOOGLE_ADS_CLIENT_SECRET` | Sí | Idem |
| `GOOGLE_ADS_REFRESH_TOKEN` | Sí | Obtenido una vez vía consentimiento OAuth2 — no confundir con el access token temporal del API Explorer |
| `GOOGLE_ADS_CUSTOMER_MAP` | Sí | Mapeo `cliente_interno:customer_id`, separado por comas. Ejemplo: `norte:1234567890,andes:2345678901` |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | No | Solo si operás con una cuenta MCC/administradora |

## Windsor.ai (prioridad sobre Google Ads directo)

Ver [cómo conectar Windsor.ai](../how-to/conectar-windsor.md) para el paso a paso.

| Variable | Obligatoria si usás Windsor.ai | Descripción |
|---|---|---|
| `WINDSOR_API_KEY` | Sí | API key simple (no OAuth) — Windsor.ai UI → Account → API Key. Ya cargada en Vercel (Production/Preview/Development) desde `marketing@taquion.com.ar`; para desarrollo local copiala también a `.env.local`. Si está presente, tiene prioridad sobre las variables de Google Ads directo. Con solo esta variable, ya se traen **todas** las cuentas de Google Ads, Meta Ads y TikTok Ads conectadas en Windsor.ai como filas propias. |
| `WINDSOR_GOOGLE_ADS_ACCOUNT_MAP` | No — opcional | Solo para pisar el spend de un cliente mock puntual con una cuenta real específica de Google Ads (`cliente_interno:account_id`, separado por comas). Sin esto, cada cuenta real igual aparece en la tabla, como fila nueva con su nombre real. Ejemplo: `norte:1234567890`. |
| `WINDSOR_META_ACCOUNT_MAP` | No — opcional | Igual que la anterior, para cuentas de Meta Ads. |
| `WINDSOR_TIKTOK_ACCOUNT_MAP` | No — opcional | Igual que la anterior, para cuentas de TikTok Ads. |

Implementado en [`lib/windsor.ts`](../../lib/windsor.ts) — ver la nota al principio del archivo sobre qué está verificado contra la documentación pública de Windsor.ai y qué está asumido sin probar contra una cuenta real.

## Vercel Global Config — "Total presupuesto" manual (Finanzas)

Primera pieza de persistencia propia del proyecto (ver [`lib/financeBudget.ts`](../../lib/financeBudget.ts) y [estado y limitaciones](../explanation/estado-y-limitaciones.md)) — un solo valor, cargado a mano por el gerente de Finanzas, guardado en un Vercel Global Config (antes llamado "Edge Config"). 2 variables, con 2 orígenes y 2 tipos de token completamente distintos:

| Variable | Obligatoria | Descripción |
|---|---|---|
| `GLOBAL_CONFIG` | Sí, para leer | Connection string de **lectura** (`https://global-config.vercel.com/<id>?token=...`). Se agrega sola a Vercel al conectar el Global Config al proyecto desde su dashboard — no se genera a mano ni se copia de ningún otro lado. |
| `VERCEL_API_TOKEN` | Sí, para escribir (guardar un valor nuevo) | Token de **cuenta** de Vercel (Account Settings → Tokens), usado contra la Vercel REST API normal (`api.vercel.com`) para el `PATCH` que actualiza el ítem. **No es el mismo token que `GLOBAL_CONFIG`** — el de `GLOBAL_CONFIG` es de solo lectura, no sirve para escribir aunque tenga forma parecida. |

Sin `GLOBAL_CONFIG`, el chip muestra "Cargar" (nunca se fabrica un número). Sin `VERCEL_API_TOKEN`, se puede ver el valor pero no guardar uno nuevo — el botón de guardar muestra el error correspondiente en vez de fallar en silencio.

El ID del Global Config (`ecfg_...`) y el del team de Vercel (`team_...`) están hardcodeados en `lib/financeBudget.ts` — no son secretos (identificadores, no credenciales), mismo criterio que `WINDSOR_BASE_URL` en `lib/windsor.ts`.

## Supabase (planeado, no implementado)

Todavía no existen estas variables — se van a necesitar cuando se cree el proyecto Supabase (ver [Decisión de arquitectura de datos](../explanation/arquitectura-de-datos.md)):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side únicamente, nunca con prefijo `NEXT_PUBLIC_`)

<!-- TODO(humano): confirmar los nombres exactos de variable una vez creado el proyecto Supabase — estos son los nombres convencionales del SDK de Supabase, no verificados contra un proyecto real todavía. -->

## Resumen diario al equipo (Google Chat y/o email)

Lo envía [`app/api/cron/notify`](../../app/api/cron/notify/route.ts), disparado por el cron de [`vercel.json`](../../vercel.json) (**martes y jueves a las 8:00 hs de Argentina**: `0 11 * * 2,4` en UTC, porque Argentina es UTC−3 todo el año; en el plan Hobby Vercel lo ejecuta en algún momento dentro de esa hora, es decir entre las 8:00 y las 8:59). El contenido y los umbrales están en [`lib/notifications.ts`](../../lib/notifications.ts) (`THRESHOLDS`).

| Variable | Obligatoria | Descripción |
|---|---|---|
| `CRON_SECRET` | Sí | Secreto largo y aleatorio. Vercel lo manda como `Authorization: Bearer …` al invocar el cron. **Sin esta variable la ruta responde 503 y no hace nada** — es la única ruta sin login con SSO, no puede quedar abierta. |
| `RESEND_API_KEY` | Solo para el canal de email | API key de [Resend](https://resend.com). |
| `NOTIFY_FROM` | Solo para el canal de email | Remitente, ej. `Pulso Ignite <pulso@taquion.com.ar>`. El dominio tiene que estar verificado en Resend. |
| `NOTIFY_TO` | Solo para el canal de email | Destinatarios separados por coma. |

Probar sin enviar nada: `GET /api/cron/notify?dryRun=1` con el header `Authorization: Bearer <CRON_SECRET>` devuelve el resumen sin enviar nada. Sin ningún canal configurado responde 503 indicando qué cargar.

### Canal Google Chat (webhook de un Espacio)

El resumen se envía a **todos los canales configurados**: Google Chat, email, o ambos. Con solo `GOOGLE_CHAT_WEBHOOK_URL` y `CRON_SECRET` alcanza; las variables de email son opcionales.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `GOOGLE_CHAT_WEBHOOK_URL` | Sí, para usar Google Chat | URL del webhook entrante del Espacio. Tiene que ser un **Espacio con nombre** (los chats grupales sin nombre no admiten webhooks) y el administrador de Google Workspace tiene que permitir webhooks. Debe empezar con `https://chat.googleapis.com/v1/spaces/`; cualquier otro destino se rechaza. **Es una credencial** (lleva `key` y `token`): con ella cualquiera puede escribir en el espacio. Cargarla solo en Vercel, como *Sensitive*; si se expone, borrar el webhook en el Espacio y crear uno nuevo. |

Sin ningún canal configurado, `/api/cron/notify` responde 503 indicando qué cargar. Con `?dryRun=1` devuelve el resumen en los formatos de Chat y de email sin enviar nada.

## Registro de alertas (Upstash Redis)

Guarda las alertas enviadas por el cron para la pantalla **Medios → Alertas**. Se crea desde Vercel → Storage → Upstash Redis y se conecta al proyecto: Vercel agrega las variables solo. Paso a paso: [activar el registro de alertas](../how-to/activar-registro-de-alertas.md).

| Variable | Obligatoria | Descripción |
|---|---|---|
| `KV_REST_API_URL` y `KV_REST_API_TOKEN` | No — opcional | URL y token REST de la base. También se aceptan los nombres `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. **El token es una credencial**: no va en el repo ni en un chat. Sin estas variables el resumen se envía igual, pero no se registra nada y la pantalla Alertas explica cómo activarlo. |
