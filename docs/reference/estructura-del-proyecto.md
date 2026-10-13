# Estructura del proyecto

```
middleware.ts                       # Login con SSO y permisos por página en cada pedido, salvo /api/cron/notify — ver configurar-sso-cloudflare.md
app/
  layout.tsx                      # Shell raíz: fuente, metadata, importa globals.css
  page.tsx                        # Ruta "/" — renderiza <Dashboard /> (vista Finanzas)
  globals.css                     # Design tokens (ver design-tokens.md) + todos los estilos
  medios/
    page.tsx                      # Ruta "/medios" — <MediosView />, tabla de Campañas
    anuncios/page.tsx              # Ruta "/medios/anuncios" — <AnunciosView />
    comparacion/page.tsx           # Ruta "/medios/comparacion" — <ComparacionView />
  components/
    Dashboard.tsx                  # Vista Finanzas — KPIs, gráfico, tabla por cliente×plataforma
    MediosView.tsx                 # Vista Medios/Ignite — tabla de Campañas
    AnunciosView.tsx                # Vista Medios/Ignite — grilla de Anuncios
    ComparacionView.tsx              # Vista Medios/Ignite — comparación agregada por plataforma
    SessionLinks.tsx                 # Encabezado: links a las secciones habilitadas (Finanzas, Medios, Usuarios) + cuenta y "Salir"
    MediosNav.tsx                    # Pestañas de Medios: solo las páginas habilitadas
    UsuariosView.tsx                 # Gestión de usuarios (solo administradores)
  usuarios/page.tsx                 # Ruta "/usuarios" — <UsuariosView />
  auth/login|callback|logout/route.ts  # Login OIDC con Cloudflare Zero Trust (ver lib/oidc.ts)
  api/
    spend/route.ts                 # GET /api/spend — ver api-spend.md (Finanzas)
    campaigns/route.ts               # GET /api/campaigns — ver api-medios.md (Medios, nivel campaña)
    ads/route.ts                     # GET /api/ads — ver api-medios.md (Medios, nivel anuncio)
    platform-comparison/route.ts      # GET /api/platform-comparison — ver api-medios.md
    finance-budget/route.ts           # GET/POST /api/finance-budget — Total presupuesto manual (Finanzas), ver lib/financeBudget.ts
lib/
  access.ts                         # Páginas, permisos y sesión (sin dependencias: lo usan también los componentes)
  auth.ts                           # Configuración del login, cookies firmadas de sesión, administradores fijos
  oidc.ts                           # Cliente OIDC (Authorization Code + PKCE) y validación del ID token
  users.ts                          # Registro de usuarios y auditoría (Upstash Redis)
  redis.ts                          # Cliente REST de Upstash, compartido con alertLog.ts
  types.ts                          # Tipos compartidos (PlatformKey, ClientData, CampaignRow, AdRow, ...)
  mockData.ts                        # Dataset de ejemplo de Finanzas — los 4 clientes ficticios
  mockCampaigns.ts                    # Dataset de ejemplo de Campañas (Medios), por plataforma
  mockAds.ts                          # Dataset de ejemplo de Anuncios (Medios), por plataforma
  windsor.ts                          # Fetcher de cuentas (Finanzas) + discoveryWindowFor + fetchPlatformComparison
  windsorCampaigns.ts / windsorMeta.ts / windsorTiktok.ts   # Fetchers de campaña, uno por plataforma
  windsorAds.ts / windsorAdsMeta.ts / windsorAdsTiktok.ts   # Fetchers de anuncio, uno por plataforma
  financeCampaigns.ts                  # Desglose de campañas por cuenta para Finanzas (reagrupa los de arriba)
  mediaPlan.ts                         # Lee la hoja de proyectados (Google Sheets vía Windsor)
  financeBudget.ts                     # Lee/escribe el Total presupuesto manual en Vercel Global Config (ver variables-de-entorno.md)
  googleAds.ts                         # Integración directa a Google Ads API (fallback, ver conectar-google-ads.md)
docs/                                  # Esta documentación
.claude/launch.json                     # Config para levantar el dev server desde Claude Code
.env.example                            # Plantilla de variables de entorno (ver variables-de-entorno.md)
```

## Las 2 vistas del dashboard

El proyecto sirve **2 perfiles de usuario** distintos, cada uno con sus propios componentes de cliente — no es un único dashboard con un toggle interno:

- **Finanzas** (`/`, `Dashboard.tsx`): pacing de presupuesto por cliente×plataforma — Presupuesto proyectado, Real, Ritmo de consumo, Remanente, Estado. Desglose por campaña siempre visible al lado de cada cuenta (no hay botón de expandir).
- **Medios/Ignite** (`/medios`, `/medios/anuncios`, `/medios/comparacion`): métricas de performance para el equipo de medios — Campañas (una fila por campaña, con métricas específicas de cada plataforma), Anuncios (agrupados por campaña, para comparar variantes creativas) y Comparación de plataformas (agregado).

Los dos leen de fuentes de datos superpuestas (mismos fetchers de Windsor a nivel campaña, reagrupados distinto) pero son árboles de componentes independientes — no comparten estado ni un layout común más allá de `app/layout.tsx` y `globals.css`.

### Filtros y selectores que se repiten en las 3 vistas del lado de Medios

- **"Solo con actividad"**: oculta cuentas/campañas/anuncios sin actividad real en el período elegido. El criterio varía según qué dato existe a ese nivel — `spend > 0` en Finanzas y Campañas, `impressions > 0` en Anuncios (no expone `spend` a nivel anuncio). Activado por defecto en las 3 vistas.
- **Selector de cuentas** (barra lateral, clase `.sidebar`/`.client-list`): igual patrón que el selector de "Clientes" de Finanzas, acá a nivel cuenta — presente en Campañas y Anuncios.
- **Selector de plataformas**: en Campañas es **multi-selección** (se pueden dejar varias plataformas prendidas a la vez; con más de una activa, la tabla las combina en una sola vista con columna "Plataforma" y solo las métricas comunes). En Anuncios sigue siendo selección única.

## Por qué hay un componente de cliente por vista, no uno solo

Cada vista (`Dashboard.tsx`, `MediosView.tsx`, `AnunciosView.tsx`, `ComparacionView.tsx`) es un árbol de componentes separado, sin componentes compartidos entre ellos — helpers como `fmtCompact`/`fmtMoney` o el bloque de `DATE_PRESETS` están **duplicados a propósito** en cada archivo en vez de extraídos a un módulo común. Es una decisión deliberada de simplicidad para el tamaño actual del proyecto: evita una capa de abstracción compartida antes de que haya evidencia real de que hace falta. Si en algún momento se repite un tercer selector de fecha o un tercer "Solo con actividad" con lógica más compleja, extraerlos sería un refactor razonable — no se hizo preventivamente.

## Flujo de datos

```
lib/mockData.ts ──────────────┐
lib/windsor.ts ────────────────┼─→ app/api/spend/route.ts ──────────→ (fetch) ──→ Dashboard.tsx
lib/googleAds.ts ──────────────┘        │
                                          └─ decide mock vs. windsor vs. google-ads directo

lib/mockCampaigns.ts ──────────┐
lib/windsorCampaigns.ts ────────┼─→ app/api/campaigns/route.ts ──→ (fetch) ──→ MediosView.tsx
lib/windsorMeta.ts ─────────────┤        │
lib/windsorTiktok.ts ───────────┤        └─ cruza budget vía lib/mediaPlan.ts (fetchMediaPlanBudgetByCampaign)
lib/mediaPlan.ts ───────────────┘

lib/mockAds.ts ─────────────────┐
lib/windsorAds.ts ───────────────┼─→ app/api/ads/route.ts ──→ (fetch) ──→ AnunciosView.tsx
lib/windsorAdsMeta.ts ───────────┤
lib/windsorAdsTiktok.ts ─────────┘

lib/windsor.ts (fetchPlatformComparison) ──→ app/api/platform-comparison/route.ts ──→ (fetch) ──→ ComparacionView.tsx

lib/financeBudget.ts (Vercel Global Config) ──→ app/api/finance-budget/route.ts ──→ (fetch) ──→ Dashboard.tsx
```

Ningún componente de cliente importa un fetcher (`windsor*.ts`, `mediaPlan.ts`, `mockData.ts`, etc.) directamente — todo pasa por `fetch("/api/...")` dentro de un `useEffect`. Esto es importante: **las credenciales (`WINDSOR_API_KEY`, las de Google Ads) nunca llegan al navegador**, solo se usan server-side dentro de las API routes. Los archivos `lib/windsor*.ts` y `lib/mediaPlan.ts` tienen el comentario `SOLO SERVER-SIDE` en su cabecera para dejarlo explícito.
