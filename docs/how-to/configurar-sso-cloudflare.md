# Configurar el login con SSO (Cloudflare Zero Trust) y los usuarios

Al terminar esta guía, para entrar a Pulso hay que iniciar sesión con una cuenta **@taquion.com.ar** a través de Cloudflare Zero Trust, y cada persona ve **solo las páginas que un administrador le habilitó** en la pantalla **Usuarios** de Pulso. La única ruta que no pasa por el login es `/api/cron/notify`, el resumen automático, que sigue protegido por `CRON_SECRET`.

Es el mismo esquema que el Tablero de Seguimiento Táctico (`tablero-frigor`).

> ⚠️ **Orden de los pasos.** El código cierra Pulso apenas se deploya. En producción, si faltan las variables `OIDC_*` y `SESSION_SECRET`, no entra nadie (503). Por eso conviene hacer los pasos 1 a 4 **antes** de mergear el cambio.

## Cómo funciona

```
Navegador ──► pulso.taquion.com.ar ──► middleware.ts (cada pedido)
                 1. ¿cookie de sesión de Pulso válida?  ── no ──► /auth/login ──► Cloudflare Zero Trust
                                                                  (OIDC + PKCE; política: emails @taquion.com.ar;
                                                                   login con Google Workspace o código por email)
                                                                  ◄── /auth/callback: valida el ID token y crea la sesión
                 2. ¿la cuenta está en el registro de usuarios?  ── no ──► "Sin acceso a Pulso"
                 3. ¿tiene habilitada ESTA página?  ── no ──► lleva a una página que sí tiene / 403 en /api/*
                 4. pantalla o datos

Cron ──► /api/cron/notify ──► sin login; la ruta exige Authorization: Bearer <CRON_SECRET>
```

- **Cloudflare** decide quién puede iniciar sesión: cualquier cuenta `@taquion.com.ar`.
- **Pulso** decide qué ve cada uno: el registro de usuarios (Upstash Redis) que se administra en `/usuarios`.
- Cada página habilita también sus rutas de datos. Con "Medios · Anuncios", por ejemplo, la persona usa `/medios/anuncios` y `/api/ads`, y nada más.

| Página | Pantalla | Rutas de datos |
|---|---|---|
| Finanzas | `/` | `/api/spend`, `/api/finance-budget` |
| Medios · Campañas | `/medios` | `/api/campaigns` |
| Medios · Anuncios | `/medios/anuncios` | `/api/ads` |
| Medios · Comparación | `/medios/comparacion` | `/api/platform-comparison` |
| Medios · Alertas | `/medios/alertas` | `/api/alerts`, `/api/alerts/<id>` |
| Usuarios (solo administradores) | `/usuarios` | `/api/users` |

## 1. Subdominio `pulso.taquion.com.ar` (DNS en Netlify)

El DNS de `taquion.com.ar` está en **Netlify DNS** (Netlify → *Domains* → `taquion.com.ar`). Los pasos dependen de dónde se hostea Pulso.

### Si Pulso pasa a Netlify

1. Netlify → el proyecto de Pulso → **Domain management → Add a domain** → `pulso.taquion.com.ar` → *Verify* → *Add domain*.
2. Como la zona ya está en Netlify DNS, Netlify crea el registro solo, del tipo `NETLIFY`, igual que `tablero-frigor.taquion.com.ar`. También emite el certificado HTTPS (Let's Encrypt) en unos minutos.

### Si Pulso sigue en Vercel

1. Vercel → proyecto → **Settings → Domains** → *Add* → `pulso.taquion.com.ar`. Vercel muestra el registro que necesita (normalmente un `CNAME` a `cname.vercel-dns.com`).
2. Netlify → **Domains → taquion.com.ar → DNS settings → Add new record**:
   - *Record type*: `CNAME`
   - *Name*: `pulso`
   - *Value*: el que indicó Vercel (p. ej. `cname.vercel-dns.com`)
   - *TTL*: 3600
3. Volvé a Vercel y esperá *Valid Configuration*: Vercel emite el certificado solo.

## 2. Aplicación SaaS en Cloudflare Zero Trust (equipo `quiet-lab-fdf2`)

> ✅ **Ya está creado** (9/10/2026): política **Pulso - Acceso** y aplicación SaaS OIDC **Pulso**, con la configuración de abajo. ID de cliente `2275004eaf1333a979c228724d81c9085769ec78799020c3848f27f39563f440`. Estos pasos quedan como referencia por si hay que rehacerlo.

1. **Política reutilizable** (Zero Trust → *Controles de Access → Políticas → Agregar una política*):
   - Nombre: `Pulso - Acceso`
   - Acción: **Allow**
   - Incluir: **Emails que terminan en** → `@taquion.com.ar`
   - Duración de la sesión: 24 h (la misma que "Equipo Taquion")
2. **Aplicación** (Zero Trust → *Controles de Access → Aplicaciones → Crear nueva aplicación* → **SaaS**):
   - Aplicación: `Pulso` (el nombre aparece en la pantalla de login)
   - Protocolo de autenticación: **OIDC**
   - Alcances: `openid`, `email`, `profile`
   - Direcciones URL de redirección: `https://pulso.taquion.com.ar/auth/callback` y `https://dashboard-consumos-ignite.vercel.app/auth/callback` (la segunda permite probar antes de tener el subdominio)
   - **Clave de prueba para intercambio de código (PKCE)**: activada. "Permita PKCE sin secreto de cliente" queda **desactivada**, porque Pulso usa secreto de cliente.
   - Políticas: `Pulso - Acceso`
   - Autenticación: **Google Workspace** y **One-time PIN**, los mismos que el tablero de Frigor
3. Al guardar, copiá el **ID de cliente**, el **Secreto de cliente** (solo se ve una vez; si se pierde, *Restablecer secreto*) y el **Emisor**, que tiene la forma `https://quiet-lab-fdf2.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>`.

## 3. Upstash Redis (registro de usuarios)

Pulso guarda los usuarios en la misma base Upstash del registro de alertas (claves `pulso:users` y `pulso:users:audit`). Si `KV_REST_API_URL` y `KV_REST_API_TOKEN` ya están cargadas, no hay que hacer nada. Si no, ver [activar el registro de alertas](./activar-registro-de-alertas.md).

## 4. Variables de entorno

Se cargan en el hosting (Vercel → *Settings → Environment Variables*, o Netlify → *Project configuration → Environment variables*). Los secretos van como *Sensitive*/*Secret*. Detalle en [variables de entorno](../reference/variables-de-entorno.md#login-con-sso-y-usuarios).

| Variable | Valor |
|---|---|
| `OIDC_ISSUER` | El Emisor del paso 2 |
| `OIDC_CLIENT_ID` | El ID de cliente del paso 2 |
| `OIDC_CLIENT_SECRET` | El Secreto de cliente del paso 2 (secreto) |
| `SESSION_SECRET` | Clave aleatoria de 32+ caracteres (secreto), ver abajo |
| `ADMIN_EMAILS` | Administradores fijos, separados por coma (p. ej. quien coordina Pulso) |
| `PULSO_PUBLIC_URL` | `https://pulso.taquion.com.ar` (mientras no exista el subdominio: `https://dashboard-consumos-ignite.vercel.app`) |
| `ALLOWED_EMAIL_DOMAINS` | Opcional; por omisión `taquion.com.ar` |
| `SESSION_HOURS` | Opcional; de 1 a 24, por omisión 12 |

Para generar `SESSION_SECRET` en Windows (PowerShell):

```powershell
$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

## 5. Verificar

1. Abrir `https://pulso.taquion.com.ar` debe llevarte al login de Cloudflare. Al entrar con un administrador fijo, ves todas las páginas y el link **Usuarios**.
2. En `/usuarios`, dá de alta a alguien con el perfil *Finanzas*. Esa persona entra a `/`; si intenta abrir `/medios`, vuelve a `/`, y `/api/campaigns` le responde 403.
3. Una cuenta `@taquion.com.ar` sin alta ve "Sin acceso a Pulso".
4. Cualquier otra URL del deploy (`*.vercel.app` o `*.netlify.app`) redirige a `PULSO_PUBLIC_URL`, y sus `/api/*` responden 401 sin sesión.
5. Resumen automático: `GET https://pulso.taquion.com.ar/api/cron/notify?dryRun=1` con `Authorization: Bearer <CRON_SECRET>` responde 200 sin enviar nada.

## Usuarios: altas, bajas y administradores

Todo se hace desde **Pulso → Usuarios** (`/usuarios`), visible solo para administradores:

- **Alta:** email `@taquion.com.ar`, perfil (*Finanzas* o *Medios/Ignite*, que tildan sus páginas) o páginas sueltas, y opcionalmente *Administrador*. No hace falta tocar Cloudflare.
- **Cambio y baja:** se aplican en segundos (hasta 10 s), sin que la persona tenga que volver a entrar.
- **Administradores fijos** (`ADMIN_EMAILS`): ven todo y no se pueden quitar ni cambiar desde la pantalla, así nunca se pierde el acceso de administración.
- **Nadie puede cambiar ni quitar su propio acceso.**
- **Auditoría:** cada alta, cambio y baja queda registrada con quién la hizo, y se ve al pie de la pantalla.
- **Cortar todas las sesiones a la vez:** cambiar `SESSION_SECRET` y redeployar.

## Desarrollo local

`npm run dev` funciona sin Cloudflare: si no están las variables `OIDC_*`/`SESSION_SECRET`, se entra como `PULSO_DEV_EMAIL` (por omisión `dev@taquion.com.ar`) con las páginas de `PULSO_DEV_PAGES` (por omisión todas, más administrador). Para probar un acceso parcial, poné en `.env.local` algo como `PULSO_DEV_PAGES=anuncios,alertas`. Esto **nunca** aplica en producción (`NODE_ENV=production`).

## Agregar una página o una ruta nueva

Las páginas y sus rutas de datos están en `PAGES`, en [`lib/access.ts`](../../lib/access.ts). Una ruta `/api/*` que no figure ahí responde **403 a todos**, para que ninguna ruta nueva quede expuesta por olvido. Al crear una ruta, sumala a `apis` de la página que la usa. Si es una pantalla nueva, agregala a `PAGES`, y aparece sola en `/usuarios`.

### Rutas de cron o de calentamiento

Las únicas rutas que no pasan por el login son las de `CRON_PATHS`, en [`lib/access.ts`](../../lib/access.ts) (hoy solo `/api/cron/notify`). Para agregar una ruta que llame un cron de `vercel.json` (por ejemplo, una de calentamiento antes del resumen):

1. Crearla y hacer que exija `Authorization: Bearer <CRON_SECRET>`, igual que [`app/api/cron/notify/route.ts`](../../app/api/cron/notify/route.ts). Sin la variable configurada tiene que responder 503, nunca abrirse.
2. Sumarla a `CRON_PATHS`.

Es una lista explícita a propósito: una ruta nueva bajo `/api/cron/` no queda abierta por estar ahí.
