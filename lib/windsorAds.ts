import type { AdRow } from "./types";
import { fetchWindsorRows, reasonMessage, type FetchAdsOptions } from "./windsorFetch";
import { resolveDateRange, discoveryWindowFor, type RangeInput } from "./windsor";

/**
 * Datos a nivel ANUNCIO (no campaña) para la vista Medios — ver Artifact
 * "Pulso Ignite — Perfil Medios", artboard "Anuncios". Mismo patrón que
 * lib/windsorCampaigns.ts, un nivel más profundo: agrega account/campaign +
 * ad_id/ad_name. Arranca solo con Google Ads.
 *
 * `ad_id`/`ad_name` verificados como campos existentes contra la
 * documentación pública de Windsor (windsor.ai/data-field/google_ads/,
 * 2026-09-17) antes de escribir este archivo — mismo cuidado que ya costó
 * un HTTP 400 a nivel campaña. Sin verificar todavía en una respuesta real
 * si conviven en el mismo reporte que spend/conversions/impressions/clicks
 * (si Windsor devuelve "no report in common", hace falta separarlos en una
 * capa aparte, igual que se hizo con search_budget_lost_impression_share).
 *
 * Sin métricas de cuota de subasta/calidad acá: esas son del reporte de
 * campaña de Google Ads, no existen a nivel anuncio individual.
 *
 * Miniatura del creativo — verificado en vivo 2026-09-28 contra la cuenta
 * real de Taquión que los anuncios reales de Google acá NO son de texto
 * (RSA): son `VIDEO_RESPONSIVE_AD`/`DEMAND_GEN_VIDEO_RESPONSIVE_AD`, formato
 * video de YouTube/Discover. Windsor no tiene un campo de thumbnail propio
 * para Google (a diferencia de Meta/TikTok) — pero sí expone `video_id`
 * (el ID real de YouTube), con el que se arma la miniatura del lado de acá:
 * `https://img.youtube.com/vi/<video_id>/hqdefault.jpg`, una URL pública de
 * YouTube sin firma ni vencimiento (más simple que Meta/TikTok, que sí
 * vencen). `video_id` pertenece al recurso `VIDEO` de Google Ads, que la API
 * rechaza si se pide junto con account_id/campaign_id/ad_id/ad_name/spend en
 * la misma consulta ("Cannot select fields from ... resource, since the
 * resource is incompatible with the resource in FROM clause") — verificado
 * el error real en vivo. Por eso va en una capa aparte (VIDEO_FIELDS, ver
 * fetchVideoLayer más abajo), igual que las métricas de cuota de
 * subasta/calidad en lib/windsorCampaigns.ts. Un mismo ad_id puede traer
 * varios video_id (Demand Gen rota varios videos bajo un mismo anuncio) —
 * se usa el primero que llega para la miniatura/preview, pero se cuentan
 * todos en `videoVariantCount` para que la UI avise "+N variantes" en vez
 * de mostrar un solo video en silencio como si fuera el único.
 *
 * SOLO SERVER-SIDE.
 */

const WINDSOR_BASE_URL = "https://connectors.windsor.ai";
const CONNECTOR = "google_ads";

const JOIN_FIELDS = "account_id,account_name,campaign_id,campaign_name,ad_id,ad_name,date";
const DISCOVERY_FIELDS = "account_id,account_name,campaign_id,campaign_name,ad_id,ad_name";
const CORE_FIELDS = `${JOIN_FIELDS},spend,conversions,impressions,clicks`;
// Recurso VIDEO — incompatible con los campos de arriba en la misma
// consulta (ver nota al principio del archivo). Sin "date" ni "account_name"/
// "campaign_name": la combinación mínima verificada en vivo que funciona.
const VIDEO_FIELDS = "account_id,campaign_id,ad_id,ad_name,video_id";

function youtubeThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

interface Accum {
  accountId: string;
  accountName: string;
  campaignId: string;
  campaignName: string;
  adId: string;
  adName: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  thumbnailUrl?: string;
  youtubeVideoId?: string;
  videoIds: Set<string>;
  hasCore: boolean;
}

function getOrCreate(byAd: Map<string, Accum>, row: any): Accum | null {
  const accountId = String(row.account_id ?? "");
  const campaignId = String(row.campaign_id ?? "");
  const adId = String(row.ad_id ?? "");
  if (!accountId || !campaignId || !adId) return null;
  const key = `${accountId}:${campaignId}:${adId}`;
  let acc = byAd.get(key);
  if (!acc) {
    acc = {
      accountId,
      accountName: String(row.account_name ?? accountId),
      campaignId,
      campaignName: String(row.campaign_name ?? campaignId),
      adId,
      adName: String(row.ad_name ?? adId),
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: 0,
      thumbnailUrl: undefined,
      youtubeVideoId: undefined,
      videoIds: new Set(),
      hasCore: false,
    };
    byAd.set(key, acc);
  }
  return acc;
}

// Timeout, reintento y límite de concurrencia: ver lib/windsorFetch.ts.
function fetchLayer(fields: string, dateFrom: string, dateTo: string, timeoutMs?: number): Promise<any[]> {
  return fetchWindsorRows(CONNECTOR, fields, dateFrom, dateTo, timeoutMs);
}

export async function fetchGoogleAdsAds(rangeKey: RangeInput = "month", opts: FetchAdsOptions = {}): Promise<{ ads: AdRow[]; warnings: string[]; failed?: boolean }> {
  const warnings: string[] = [];
  if (!process.env.WINDSOR_API_KEY) return { ads: [], warnings };

  const range = opts.range ?? resolveDateRange(rangeKey);
  const byAd = new Map<string, Accum>();

  // Las 3 capas (núcleo, descubrimiento, miniatura) son independientes entre
  // sí: se piden en paralelo, el tiempo total es el de la más lenta y no la
  // suma. Antes iban en serie (hasta 3 x timeout).
  const discovery = discoveryWindowFor(range);
  const [coreRes, discoveryRes, videoRes] = await Promise.allSettled([
    fetchLayer(CORE_FIELDS, range.dateFrom, range.dateTo, opts.timeoutMs),
    opts.skipDiscovery ? Promise.resolve<any[]>([]) : fetchLayer(DISCOVERY_FIELDS, discovery.dateFrom, discovery.dateTo, opts.timeoutMs),
    opts.skipDiscovery ? Promise.resolve<any[]>([]) : fetchLayer(VIDEO_FIELDS, discovery.dateFrom, discovery.dateTo, opts.timeoutMs),
  ]);

  // Capa 1 — núcleo. Si esta falla, no hay nada que mostrar: se corta acá.
  if (coreRes.status === "rejected") {
    warnings.push(`Windsor.ai (Google Ads, anuncios): falló la consulta principal. Detalle: ${reasonMessage(coreRes)}`);
    return { ads: [], warnings, failed: true };
  }
  for (const row of coreRes.value) {
    const acc = getOrCreate(byAd, row);
    if (!acc) continue;
    acc.hasCore = true;
    acc.impressions += Number(row.impressions ?? 0);
    acc.clicks += Number(row.clicks ?? 0);
    acc.spend += Number(row.spend ?? 0);
    acc.conversions += Number(row.conversions ?? 0);
  }

  // Descubrimiento — solo identificadores. Un anuncio pausado/sin actividad
  // en el período elegido no vendría en la capa 1 (Windsor omite la fila en
  // vez de mandarla en $0), y desaparecería en vez de mostrar $0 real.
  if (discoveryRes.status === "rejected") {
    warnings.push(
      `Windsor.ai (Google Ads, anuncios): no se pudo consultar el histórico ampliado para descubrir anuncios sin actividad. Detalle: ${reasonMessage(discoveryRes)}`
    );
  } else {
    for (const row of discoveryRes.value) {
      const acc = getOrCreate(byAd, row);
      if (acc) acc.hasCore = true;
    }
  }

  // Miniatura del creativo — capa aparte por el conflicto de recurso VIDEO
  // (ver nota al principio del archivo). No fatal: si falla, los anuncios
  // igual se muestran, solo sin miniatura (la UI ya contempla ese caso).
  if (videoRes.status === "rejected") {
    warnings.push(
      `Windsor.ai (Google Ads, anuncios): no se pudo traer la miniatura de los anuncios de video. Detalle: ${reasonMessage(videoRes)}`
    );
  } else {
    for (const row of videoRes.value) {
      const acc = getOrCreate(byAd, row);
      if (!acc) continue;
      const videoId = row.video_id ? String(row.video_id) : "";
      if (!videoId) continue;
      acc.videoIds.add(videoId);
      if (!acc.thumbnailUrl) {
        acc.thumbnailUrl = youtubeThumbnailUrl(videoId);
        acc.youtubeVideoId = videoId;
      }
    }
  }

  if (byAd.size === 0) {
    warnings.push(`Windsor.ai (Google Ads, anuncios): no se encontró ningún anuncio conectado, ni con actividad ni sin ella, en la ventana de descubrimiento del período elegido.`);
    return { ads: [], warnings };
  }

  const ads: AdRow[] = [...byAd.values()]
    .filter((acc) => acc.hasCore)
    .map((acc) => ({
      accountId: acc.accountId,
      accountName: acc.accountName,
      campaignId: acc.campaignId,
      campaignName: acc.campaignName,
      adId: acc.adId,
      adName: acc.adName,
      impressions: acc.impressions,
      clicks: acc.clicks,
      spend: acc.spend,
      cpm: acc.impressions > 0 ? (acc.spend / acc.impressions) * 1000 : 0,
      ctr: acc.impressions > 0 ? (acc.clicks / acc.impressions) * 100 : 0,
      cpl: acc.conversions > 0 ? acc.spend / acc.conversions : 0,
      conversions: acc.conversions,
      thumbnailUrl: acc.thumbnailUrl,
      youtubeVideoId: acc.youtubeVideoId,
      videoVariantCount: acc.videoIds.size > 1 ? acc.videoIds.size : undefined,
    }));

  return { ads, warnings };
}
