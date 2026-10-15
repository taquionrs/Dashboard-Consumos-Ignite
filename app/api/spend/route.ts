import { NextResponse } from "next/server";
import { MOCK_CLIENTS, MOCK_TODAY, MOCK_DAYS_IN_MONTH } from "@/lib/mockData";
import { fetchGoogleAdsSpend, hasGoogleAdsCredentials } from "@/lib/googleAds";
import { fetchWindsorSpend, hasWindsorCredentials, resolveDateRange, DATE_RANGE_KEYS, type DateRangeKey } from "@/lib/windsor";
import { fetchCampaignsByAccount } from "@/lib/financeCampaigns";
import { cachedWithFallback, hasDegradedWarning, staleWarning, CACHE_FRESH_MS, CACHE_MAX_STALE_MS } from "@/lib/cache";
import type { SpendResponse } from "@/lib/types";

export const dynamic = "force-dynamic"; // la caché es la de lib/cache.ts (explícita, con TTL), no la del framework
// Ver app/api/ads/route.ts: las consultas lentas de Windsor necesitan más de 10s.
export const maxDuration = 90; // ver WINDSOR_TIMEOUT_MS en lib/windsorFetch.ts

function mockResponse(warnings?: string[]): SpendResponse {
  return {
    source: "mock",
    today: MOCK_TODAY,
    daysInMonth: MOCK_DAYS_IN_MONTH,
    clients: MOCK_CLIENTS,
    warnings,
  };
}

function parseRangeParam(request: Request): DateRangeKey {
  const raw = new URL(request.url).searchParams.get("range");
  return (DATE_RANGE_KEYS as string[]).includes(raw || "") ? (raw as DateRangeKey) : "month";
}

export async function GET(request: Request) {
  // Prioridad: Windsor.ai (capa de ingesta elegida, ver
  // docs/explanation/arquitectura-de-datos.md) > Google Ads API directo
  // (paso intermedio, ver lib/googleAds.ts) > mock. Cada nivel cae al
  // siguiente solo si FALTA configuración. Con Windsor configurado, una falla
  // en la consulta ya no cae a mock: se sirve el último dato bueno o se
  // responde 502 (ver docs/explanation/estado-y-limitaciones.md).
  const rangeKey = parseRangeParam(request);

  if (hasWindsorCredentials()) {
    // Con credenciales, un fallo de Windsor NUNCA se disfraza de clientes
    // ficticios: o se sirve el último resultado bueno (con aviso) o se
    // responde un error claro.
    try {
      const range = resolveDateRange(rangeKey);
      const result = await cachedWithFallback<SpendResponse>({
        key: `spend:${rangeKey}`,
        freshMs: CACHE_FRESH_MS,
        maxStaleMs: CACHE_MAX_STALE_MS,
        load: async () => {
          // Cuentas (presupuesto/real ya existentes) + desglose por campaña
          // (lib/financeCampaigns.ts, a pedido explícito del usuario) en
          // paralelo — son 2 fuentes independientes que se mezclan acá, no
          // una depende de la otra.
          const [{ clients, warnings: spendWarnings }, { byAccount: campaignsByAccount, warnings: campaignWarnings }] =
            await Promise.all([fetchWindsorSpend(MOCK_CLIENTS, range), fetchCampaignsByAccount(rangeKey)]);
          const warnings = [...spendWarnings, ...campaignWarnings];
          return {
            source: "windsor",
            today: range.today,
            daysInMonth: range.daysInPeriod,
            clients: clients.map((c) => (c.accountId ? { ...c, campaigns: campaignsByAccount.get(c.accountId) ?? [] } : c)),
            warnings: warnings.length ? warnings : undefined,
          } satisfies SpendResponse;
        },
        isClean: (r) => r.clients.length > 0 && !hasDegradedWarning(r.warnings),
        describe: (r) => (r.warnings ?? []).join(" | "),
      });

      if (!result.stale) return NextResponse.json(result.value);
      return NextResponse.json({ ...result.value, warnings: [staleWarning(result.ageMs, result.refreshError)] });
    } catch (err: any) {
      return NextResponse.json(
        { error: `No se pudo obtener el consumo desde Windsor.ai. ${err?.message || err}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  if (hasGoogleAdsCredentials()) {
    // lib/googleAds.ts todavía no soporta rangos de fecha (siempre consulta
    // "mes en curso" vía GAQL) — el selector de fecha no tiene efecto en
    // este fallback. No es una limitación nueva: este camino es un paso
    // intermedio sin uso activo en producción (ver docs/how-to/conectar-google-ads.md).
    try {
      const { clients, warnings } = await fetchGoogleAdsSpend(MOCK_CLIENTS);
      const now = new Date();
      const body: SpendResponse = {
        source: "google-ads",
        today: now.getDate(),
        daysInMonth: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
        clients,
        warnings: warnings.length ? warnings : undefined,
      };
      return NextResponse.json(body);
    } catch (err: any) {
      return NextResponse.json(
        mockResponse([`Error inesperado consultando Google Ads, se usó mock: ${err?.message || err}`])
      );
    }
  }

  return NextResponse.json(mockResponse());
}
