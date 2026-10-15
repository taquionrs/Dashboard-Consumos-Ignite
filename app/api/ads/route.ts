import { NextResponse } from "next/server";
import { fetchGoogleAdsAds } from "@/lib/windsorAds";
import { fetchMetaAds } from "@/lib/windsorAdsMeta";
import { fetchTiktokAds } from "@/lib/windsorAdsTiktok";
import { hasWindsorCredentials, DATE_RANGE_KEYS, type DateRangeKey } from "@/lib/windsor";
import { cachedWithFallback, hasDegradedWarning, staleWarning, CACHE_FRESH_MS, CACHE_MAX_STALE_MS } from "@/lib/cache";
import { MOCK_ADS } from "@/lib/mockAds";
import { CONNECTED_PLATFORMS } from "@/lib/platforms";
import type { AdRow, AdsResponse, PlatformKey } from "@/lib/types";

export const dynamic = "force-dynamic";
// Meta y TikTok a nivel anuncio tardan ~9s (medido 2026-09-30); el límite por
// defecto de una función de Vercel (10s) los cortaba en el borde.
export const maxDuration = 90; // ver WINDSOR_TIMEOUT_MS en lib/windsorFetch.ts

// Mismo criterio que app/api/campaigns/route.ts: ALL_PLATFORM_KEYS valida el
// query param, CONNECTED_PLATFORMS dice cuáles ya tienen fetcher real.
const ALL_PLATFORM_KEYS: PlatformKey[] = ["google", "meta", "tiktok", "linkedin"];
// CONNECTED_PLATFORMS: ver lib/platforms.ts

interface AdsResult {
  ads: AdRow[];
  warnings: string[];
  failed?: boolean;
}

function fetchAdsForPlatform(platform: PlatformKey, rangeKey: DateRangeKey): Promise<AdsResult> {
  switch (platform) {
    case "google":
      return fetchGoogleAdsAds(rangeKey);
    case "meta":
      return fetchMetaAds(rangeKey);
    case "tiktok":
      return fetchTiktokAds(rangeKey);
    default:
      return Promise.resolve({ ads: [], warnings: [] });
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

function notConnectedResponse(platform: PlatformKey): AdsResponse {
  return {
    source: "mock",
    platform,
    ads: MOCK_ADS[platform] ?? [],
    warnings: [`Anuncios de ${platform} todavía no están conectados a Windsor.ai — mostrando datos de ejemplo.`],
  };
}

export async function GET(request: Request) {
  const platform = parsePlatformParam(request);
  const rangeKey = parseRangeParam(request);

  // Plataforma sin fetcher real (LinkedIn): mock explícito y rotulado.
  if (!CONNECTED_PLATFORMS.includes(platform)) {
    return NextResponse.json(notConnectedResponse(platform));
  }

  // Sin API key (desarrollo local): mock completo, documentado en el README.
  if (!hasWindsorCredentials()) {
    const body: AdsResponse = { source: "mock", platform, ads: MOCK_ADS[platform] ?? [] };
    return NextResponse.json(body);
  }

  // Con credenciales, un fallo de Windsor NUNCA se disfraza de mock: o se
  // sirve el último resultado bueno (con aviso) o se responde un error claro.
  try {
    const result = await cachedWithFallback<AdsResult>({
      key: `ads:${platform}:${rangeKey}`,
      freshMs: CACHE_FRESH_MS,
      maxStaleMs: CACHE_MAX_STALE_MS,
      load: async () => {
        const r = await fetchAdsForPlatform(platform, rangeKey);
        if (r.failed) throw new Error(r.warnings.join(" | ") || "Windsor.ai no respondió");
        return r;
      },
      isClean: (r) => r.ads.length > 0 && !hasDegradedWarning(r.warnings),
      describe: (r) => r.warnings.join(" | "),
    });

    const warnings = result.stale ? [staleWarning(result.ageMs, result.refreshError)] : result.value.warnings;
    const body: AdsResponse = {
      source: "windsor",
      platform,
      ads: result.value.ads,
      warnings: warnings.length ? warnings : undefined,
    };
    return NextResponse.json(body);
  } catch (err: any) {
    return NextResponse.json(
      { error: `No se pudieron obtener los anuncios de ${platform} desde Windsor.ai. ${err?.message || err}` },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
