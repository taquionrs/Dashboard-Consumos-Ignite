# API — `GET /api/spend`

Única ruta de API del proyecto. Devuelve el dataset completo que consume `Dashboard.tsx`. El filtrado por cliente/plataforma ocurre client-side; el rango de fecha, en cambio, sí es un parámetro de query real (ver abajo) porque determina qué le pedimos a Windsor.ai.

`export const dynamic = "force-dynamic"` — nunca se cachea, cada request recalcula.

## Parámetros de consulta (Query Params)

| Param | Valores | Default | Descripción |
|---|---|---|---|
| `range` | `today \| yesterday \| 7d \| 14d \| 28d \| month \| lastmonth` | `month` | Rango de fecha a consultar. Cualquier valor no reconocido cae a `month`. Ver `resolveDateRange` en [`lib/windsor.ts`](../../lib/windsor.ts) para el cálculo exacto de cada uno. Solo tiene efecto cuando `source` termina siendo `"windsor"` — el fallback de Google Ads directo (`lib/googleAds.ts`) todavía no soporta rangos, siempre consulta "mes en curso" sin importar este parámetro. |
| `range=custom` + `from` + `to` | `from`/`to` en `AAAA-MM-DD`, ambas inclusive | — | Rango propio. Se valida en [`lib/rangeParam.ts`](../../lib/rangeParam.ts): fechas reales, desde ≤ hasta, hasta como máximo 366 días; un `to` futuro se corta en hoy. Si algo está mal responde **400** con el motivo. Lo usan también `/api/campaigns`, `/api/ads` y `/api/platform-comparison`. El presupuesto proyectado que devuelve es siempre el del mes en curso. |

## Respuesta

Tipo `SpendResponse` (definido en [`lib/types.ts`](../../lib/types.ts)):

| Campo | Tipo | Descripción |
|---|---|---|
| `source` | `"mock" \| "google-ads" \| "windsor"` | De dónde salieron los datos. `"windsor"` si `hasWindsorCredentials()` devuelve `true` (prioridad); si no, `"google-ads"` si `hasGoogleAdsCredentials()` devuelve `true`; si no, `"mock"`. También cae a `"mock"` si la consulta real que corresponda falló. |
| `today` | `number` | "Día actual" dentro del rango elegido — con `range=month` es el día del mes; con cualquier otro rango (una ventana fija, ya 100% transcurrida) es igual a `daysInMonth`. En mock siempre `8`, sin importar `range` (el mock no varía por rango todavía). |
| `daysInMonth` | `number` | Largo total del período elegido (30/31 para `month`, 7/14/28 para esos rangos, etc. — pese al nombre, no es literalmente "días del mes" fuera de `range=month`). En mock siempre `30`. |
| `clients` | `ClientData[]` | Ver abajo. |
| `warnings` | `string[]` \| `undefined` | Presente solo si algo falló parcialmente (ej. Google Ads no respondió para un cliente puntual) — la respuesta sigue siendo 200 igual, el fallback ya ocurrió server-side. |

### `ClientData`

| Campo | Tipo | Descripción |
|---|---|---|
| `key` | `string` | Identificador interno (`"norte"`, `"andes"`, etc.) |
| `name` | `string` | Nombre para mostrar |
| `vertical` | `string` | Industria/vertical del cliente |
| `budget` | `number` | Presupuesto mensual, en ARS |
| `spend8` | `number` | Invertido acumulado a la fecha de corte (`today`), en ARS. El nombre es historico (viene de cuando `today` era siempre 8) — representa "spend to date", no literalmente "día 8". |
| `mix` | `Partial<Record<PlatformKey, number>>` | % de allocation por plataforma. Debería sumar ~100 entre las plataformas presentes. |
| `cpl` | `Partial<Record<PlatformKey, PlatformCpl>>` | Costo por resultado, por plataforma — ver abajo. |
| `health` | `HealthIssue[]` | Alertas técnicas activas para ese cliente. |
| `accountId` | `string?` | `account_id` real de Windsor.ai — solo en cuentas reales (no en clientes mock), para cruzar con `campaigns`. |
| `campaigns` | `FinanceCampaignRow[]?` | Desglose por campaña de esa cuenta — ver abajo. Ausente/vacío en clientes mock (no hay fetcher de campañas para el mock). |

### `FinanceCampaignRow`

Desglose por campaña de la vista Finanzas (a pedido explícito: "todas las campañas por cuenta con su proyectado por campaña específico, declarado en la sheet madre") — ver [`lib/financeCampaigns.ts`](../../lib/financeCampaigns.ts). Reutiliza los mismos fetchers de campaña de Medios (Google/Meta/TikTok), reagrupados por cuenta en vez de por plataforma. A propósito NO incluye métricas de performance (CPM, CTR, Alcance, etc. — esas son de Medios), solo lo que Finanzas necesita:

| Campo | Tipo | Descripción |
|---|---|---|
| `campaignId` | `string` | ID real de campaña en Windsor.ai |
| `campaignName` | `string` | Nombre real de campaña |
| `spend` | `number` | Real, ARS |
| `budget` | `number` | Presupuesto proyectado de la hoja madre para esa campaña puntual (columna `campaña`, con tilde — ver [`lib/mediaPlan.ts`](../../lib/mediaPlan.ts)); `0` si no hay fila cargada — nunca se inventa. |

### `PlatformCpl`

| Campo | Tipo | Descripción |
|---|---|---|
| `target` | `number` | CPL/CPME objetivo (del media plan) |
| `real` | `number` | CPL/CPME real |
| `label` | `string?` | Por defecto se asume "CPL"; usar `"CPME"` para clientes de comunidad (costo por miembro efectivo, no por lead) |
| `prevPeriodDeltaPct` | `number?` | % de cambio del pacing vs. el período anterior. Ilustrativo — no hay histórico real conectado todavía (ver [estado y limitaciones](../explanation/estado-y-limitaciones.md)). |

### Filtro "Solo con actividad" y desglose por campaña (`Dashboard.tsx`)

El filtro "Solo con actividad" (`spend8 > 0`, activado por defecto) oculta cuentas sin gasto real en el período elegido — mismo criterio y misma barra lateral que en Medios/Ignite, acá a nivel cliente. Se aplica también a las campañas anidadas: si `c.campaigns` trae filas en `$0`, no se muestran al filtro estar activado, aunque la cuenta sí tenga actividad.

El desglose por campaña (`c.campaigns`, cuando existe) se muestra **siempre**, sin un botón de expandir — no hay estado de "colapsado" por fila.

### `HealthIssue`

| Campo | Tipo | Descripción |
|---|---|---|
| `platform` | `string` | Plataforma afectada |
| `text` | `string` | Descripción del problema |
| `sev` | `"warning" \| "serious" \| "critical"` | Severidad — determina el color de la franja en el panel de alertas |

## Ejemplo de respuesta (mock)

```json
{
  "source": "mock",
  "today": 8,
  "daysInMonth": 30,
  "clients": [
    {
      "key": "norte",
      "name": "Norte Fintech",
      "vertical": "Banca & Fintech",
      "budget": 18000000,
      "spend8": 6100000,
      "mix": { "meta": 40, "google": 36, "linkedin": 14, "tiktok": 10 },
      "cpl": {
        "meta": { "target": 850, "real": 910, "prevPeriodDeltaPct": 18 }
      },
      "health": [
        { "platform": "linkedin", "text": "Insight Tag sin eventos hace 4 días", "sev": "serious" }
      ]
    }
  ]
}
```

## Comportamiento de fallback

`GET /api/spend` **nunca devuelve un error al cliente** por falta o falla de credenciales — ver la lógica completa en [`app/api/spend/route.ts`](../../app/api/spend/route.ts):

1. Si `hasWindsorCredentials()` es `true` → intenta Windsor.ai (`lib/windsor.ts`). Si tira una excepción no controlada, cae a mock completo con un `warnings` explicando el error.
2. Si no, y `hasGoogleAdsCredentials()` es `true` → intenta Google Ads directo (`lib/googleAds.ts`), con el mismo fallback a mock ante excepción no controlada.
3. Si ninguna de las dos tiene credenciales → devuelve mock directamente.
4. Dentro de una consulta que sí funciona, si falla para un cliente puntual (sin mapeo, cuenta no encontrada, etc.) → ese cliente devuelve su valor mock, el resto sigue siendo real, y se agrega un warning por cliente afectado.
