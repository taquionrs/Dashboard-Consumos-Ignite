import { NextResponse } from "next/server";
import { fetchPlatformComparison, hasWindsorCredentials, resolveDateRange, DATE_RANGE_KEYS, type DateRangeKey } from "@/lib/windsor";
import { cachedWithFallback, hasDegradedWarning, staleWarning, CACHE_FRESH_MS, CACHE_MAX_STALE_MS } from "@/lib/cache";
import type { PlatformComparisonResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
// Ver app/api/ads/route.ts: las consultas lentas de Windsor necesitan más de 10s.
export const maxDuration = 90; // ver WINDSOR_TIMEOUT_MS en lib/windsorFetch.ts

function parseRangeParam(request: Request): DateRangeKey {
  const raw = new URL(request.url).searchParams.get("range");
  return (DATE_RANGE_KEYS as string[]).includes(raw || "") ? (raw as DateRangeKey) : "month";
}

// Mismos números que el artboard "Comparación" del wireframe — para que el
// mock y el mockup coincidan.
const MOCK_PLATFORMS: PlatformComparisonResponse["platforms"] = [
  { platformKey: "google", label: "Google Ads", spend: 120400, conversions: 135, cpl: 892 },
  { platformKey: "meta", label: "Meta Ads", spend: 27000, conversions: 38, cpl: 711 },
  { platformKey: "tiktok", label: "TikTok Ads", spend: 67800, conversions: 44, cpl: 1541 },
];

export async function GET(request: Request) {
  const rangeKey = parseRangeParam(request);

  if (!hasWindsorCredentials()) {
    const body: PlatformComparisonResponse = { source: "mock", platforms: MOCK_PLATFORMS };
    return NextResponse.json(body);
  }

  // Con credenciales, un fallo de Windsor NUNCA se disfraza de mock: o se
  // sirve el último resultado bueno (con aviso) o se responde un error claro.
  try {
    const result = await cachedWithFallback<Awaited<ReturnType<typeof fetchPlatformComparison>>>({
      key: `platform-comparison:${rangeKey}`,
      freshMs: CACHE_FRESH_MS,
      maxStaleMs: CACHE_MAX_STALE_MS,
      load: () => fetchPlatformComparison(resolveDateRange(rangeKey)),
      isClean: (r) => r.platforms.some((p) => p.accountCount > 0) && !hasDegradedWarning(r.warnings),
      describe: (r) => r.warnings.join(" | "),
    });

    const { platforms, warnings: fetchWarnings } = result.value;
    const warnings = result.stale ? [staleWarning(result.ageMs, result.refreshError)] : fetchWarnings;
    // Real en cuanto se encontró al menos una cuenta en alguna plataforma —
    // el gasto/conversiones de cada una se muestran tal cual, $0 incluido,
    // sin caer a mock por plataforma individual (ver lib/windsor.ts).
    // Sin ninguna cuenta y sin warnings = Windsor no tiene nada conectado.
    const hasAnyAccount = platforms.some((p) => p.accountCount > 0);
    const body: PlatformComparisonResponse = {
      source: hasAnyAccount ? "windsor" : "mock",
      platforms: hasAnyAccount ? platforms.map(({ platformKey, label, spend, conversions, cpl }) => ({ platformKey, label, spend, conversions, cpl })) : MOCK_PLATFORMS,
      warnings: warnings.length ? warnings : undefined,
    };
    return NextResponse.json(body);
  } catch (err: any) {
    return NextResponse.json(
      { error: `No se pudo obtener la comparación de plataformas desde Windsor.ai. ${err?.message || err}` },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
