import { NextResponse } from "next/server";
import { fetchGoogleAdsCampaigns } from "@/lib/windsorCampaigns";
import { fetchMetaCampaigns } from "@/lib/windsorMeta";
import { fetchTiktokCampaigns } from "@/lib/windsorTiktok";
import { hasWindsorCredentials, resolveDateRange, DATE_RANGE_KEYS, type DateRangeKey, type ResolvedDateRange } from "@/lib/windsor";
import { fetchMediaPlanBudgetByCampaign, type MediaPlanTarget } from "@/lib/mediaPlan";
import { budgetKey, normAccountId } from "@/lib/matchKeys";
import { cachedWithFallback, hasDegradedWarning, staleWarning, CACHE_FRESH_MS, CACHE_MAX_STALE_MS } from "@/lib/cache";
import { MOCK_CAMPAIGNS } from "@/lib/mockCampaigns";
import { CONNECTED_PLATFORMS } from "@/lib/platforms";
import type { CampaignRow, CampaignsResponse, PlatformKey } from "@/lib/types";

export const dynamic = "force-dynamic";
// Ver app/api/ads/route.ts: las consultas lentas de Windsor necesitan más de 10s.
export const maxDuration = 30;

// Todas las plataformas que el selector de la vista Medios puede pedir —
// distinto de "cuáles ya tienen fetcher real" (eso se resuelve más abajo).
// OJO: esta lista es la que valida el query param; si solo tuviera "google"
// acá, pedir ?platform=meta caería siempre a "google" antes de llegar al
// branch que sí sabe manejar "todavía no conectado" (bug real, encontrado
// probando esto en vivo).
const ALL_PLATFORM_KEYS: PlatformKey[] = ["google", "meta", "tiktok", "linkedin"];

// De esas, cuáles ya tienen fetcher de campañas contra Windsor.ai real.
// CONNECTED_PLATFORMS: ver lib/platforms.ts

interface CampaignsResult {
  campaigns: CampaignRow[];
  warnings: string[];
  failed?: boolean;
}

function fetchCampaignsForPlatform(platform: PlatformKey, rangeKey: DateRangeKey): Promise<CampaignsResult> {
  switch (platform) {
    case "google":
      return fetchGoogleAdsCampaigns(rangeKey);
    case "meta":
      return fetchMetaCampaigns(rangeKey);
    case "tiktok":
      return fetchTiktokCampaigns(rangeKey);
    default:
      return Promise.resolve({ campaigns: [], warnings: [] });
  }
}

function parseRangeParam(request: Request): DateRangeKey {
  const raw = new URL(request.url).searchParams.get("range");
  return (DATE_RANGE_KEYS as string[]).includes(raw || "") ? (raw as DateRangeKey) : "month";
}

function parsePlatformParam(request: Request): PlatformKey {
  const raw = new URL(request.url).searchParams.get("platform") as PlatformKey | null;
  return raw && ALL_PLATFORM_KEYS.includes(raw) ? raw : "google";
}

function notConnectedResponse(platform: PlatformKey, range: ResolvedDateRange): CampaignsResponse {
  return {
    source: "mock",
    platform,
    campaigns: MOCK_CAMPAIGNS[platform] ?? [],
    warnings: [`Campañas de ${platform} todavía no están conectadas a Windsor.ai — mostrando datos de ejemplo.`],
    today: range.today,
    daysInPeriod: range.daysInPeriod,
  };
}

/** Texto de aviso por cada fila de la hoja (de esta plataforma) sin campaña correspondiente en Windsor. */
function unmatchedSheetWarnings(platform: PlatformKey, rows: MediaPlanTarget[], campaigns: CampaignRow[]): string[] {
  const keys = new Set(campaigns.map((c) => budgetKey(c.accountId, c.campaignName)));
  const out: string[] = [];
  for (const t of rows) {
    if (t.plataforma !== platform || keys.has(budgetKey(t.cuenta, t.campana))) continue;
    const sameAccount = campaigns.filter((c) => normAccountId(c.accountId) === normAccountId(t.cuenta));
    const head = `La hoja de proyectados tiene "${t.campana}" (cuenta ${t.cuenta}, ${Math.round(t.presupuesto).toLocaleString("es-AR")}) pero no coincide con ninguna campaña de Windsor.`;
    if (sameAccount.length === 0) {
      const accounts = [...new Set(campaigns.map((c) => c.accountId))].slice(0, 6).join(", ");
      out.push(`${head} Esa cuenta no tiene campañas en Windsor (cuentas que sí: ${accounts || "ninguna"}). Revisá el número de cuenta.`);
    } else {
      const names = sameAccount.slice(0, 5).map((c) => `"${c.campaignName}"`).join(", ");
      out.push(`${head} La cuenta existe, pero ninguna campaña se llama así. Nombres de esa cuenta: ${names}${sameAccount.length > 5 ? "…" : ""}. Copiá el nombre desde Pulso o Ads Manager.`);
    }
  }
  return out;
}

export async function GET(request: Request) {
  const platform = parsePlatformParam(request);
  const rangeKey = parseRangeParam(request);
  // Se resuelve una sola vez — lo necesitan tanto los fetchers de campaña
  // (vía rangeKey) como el presupuesto diario recomendado del lado del
  // cliente (today/daysInPeriod), igual que ya hace SpendResponse para
  // Finanzas.
  const range = resolveDateRange(rangeKey);

  // Plataforma sin fetcher real todavía (LinkedIn): mock explícito con
  // warning, sin importar si hay API key configurada o no.
  if (!CONNECTED_PLATFORMS.includes(platform)) {
    return NextResponse.json(notConnectedResponse(platform, range));
  }

  if (!hasWindsorCredentials()) {
    const body: CampaignsResponse = {
      source: "mock",
      platform,
      campaigns: MOCK_CAMPAIGNS[platform] ?? [],
      today: range.today,
      daysInPeriod: range.daysInPeriod,
    };
    return NextResponse.json(body);
  }

  // Con credenciales, un fallo de Windsor NUNCA se disfraza de mock: o se
  // sirve el último resultado bueno (con aviso) o se responde un error claro.
  try {
    const result = await cachedWithFallback<CampaignsResult>({
      key: `campaigns:${platform}:${rangeKey}`,
      freshMs: CACHE_FRESH_MS,
      maxStaleMs: CACHE_MAX_STALE_MS,
      load: async () => {
        // Presupuesto proyectado por campaña (hoja madre) en paralelo — cruce
        // aparte de los datos de Windsor, no vive en los fetchers de campaña
        // (esos son solo de Windsor). Mismo mecanismo que ya usa
        // lib/financeCampaigns.ts para Finanzas.
        const [{ campaigns, warnings, failed }, budgets] = await Promise.all([
          fetchCampaignsForPlatform(platform, rangeKey),
          fetchMediaPlanBudgetByCampaign(),
        ]);
        if (failed) throw new Error(warnings.join(" | ") || "Windsor.ai no respondió");
        const withBudget = campaigns.map((c) => ({ ...c, budget: budgets.byCampaign.get(budgetKey(c.accountId, c.campaignName)) ?? 0 }));
        const allWarnings = budgets.warning ? [...warnings, budgets.warning] : [...warnings];
        // Filas de la hoja de ESTA plataforma que no cruzaron con ninguna campaña: se avisa cuáles y por qué
        // (antes quedaban en "Sin objetivo cargado" sin ninguna pista). Solo con "Este mes", que es el mes del presupuesto.
        if (rangeKey === "month") allWarnings.push(...unmatchedSheetWarnings(platform, budgets.rows, withBudget));
        return { campaigns: withBudget, warnings: allWarnings };
      },
      isClean: (r) => r.campaigns.length > 0 && !hasDegradedWarning(r.warnings),
      describe: (r) => r.warnings.join(" | "),
    });

    const warnings = result.stale ? [staleWarning(result.ageMs, result.refreshError)] : result.value.warnings;
    const body: CampaignsResponse = {
      source: "windsor",
      platform,
      campaigns: result.value.campaigns,
      warnings: warnings.length ? warnings : undefined,
      today: range.today,
      daysInPeriod: range.daysInPeriod,
    };
    return NextResponse.json(body);
  } catch (err: any) {
    return NextResponse.json(
      { error: `No se pudieron obtener las campañas de ${platform} desde Windsor.ai. ${err?.message || err}` },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
