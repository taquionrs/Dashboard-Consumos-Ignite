import type { AdRow } from "./types";
import { fetchWindsorRows, reasonMessage, type FetchAdsOptions } from "./windsorFetch";
import { resolveDateRange, discoveryWindowFor, type DateRangeKey } from "./windsor";

/**
 * Datos a nivel ANUNCIO para TikTok Ads (Medios) — mismo patrón que
 * lib/windsorAds.ts (Google Ads): capa núcleo + descubrimiento (ventana
 * derivada del período elegido, ver discoveryWindowFor en lib/windsor.ts),
 * agrupado por account/campaign/ad. Mismo timeout explícito de
 * LAYER_TIMEOUT_MS que Meta (ver lib/windsorAdsMeta.ts) por las dudas, sin
 * evidencia todavía de que TikTok tenga el mismo problema de cuelgue.
 *
 * `ad_id`/`ad_name` verificados contra windsor.ai/data-field/tiktok/
 * (2026-09-17) antes de escribir este archivo. A diferencia de Meta,
 * `campaign_name` sí existe con ese nombre exacto acá (ver
 * lib/windsorTiktok.ts) — no hace falta el field alternativo que usa Meta.
 *
 * Sin tiempo de reproducción/likes acá: esas métricas (average_video_play,
 * likes) están confirmadas a nivel CAMPAÑA (ver lib/windsorTiktok.ts), sin
 * confirmar todavía si Windsor las expone también agregadas por anuncio
 * individual — se suman en una futura iteración si hace falta.
 *
 * `video_thumbnail_url` — verificado en vivo 2026-09-28 contra la cuenta
 * real de Taquión: viene poblado en el 100% de los anuncios (todos son
 * video en esta cuenta). `image_url` también es un campo válido, pero vino
 * `null` en absolutamente todos los anuncios reales probados — esta cuenta
 * de TikTok no tiene ningún creativo de imagen estática. Convive bien con
 * spend/impressions/clicks en la misma consulta. Misma advertencia que Meta:
 * la URL viene firmada con vencimiento, no se puede cachear.
 *
 * SOLO SERVER-SIDE.
 */

const WINDSOR_BASE_URL = "https://connectors.windsor.ai";
const CONNECTOR = "tiktok";

const JOIN_FIELDS = "account_id,account_name,campaign_id,campaign_name,ad_id,ad_name,date";
const DISCOVERY_FIELDS = "account_id,account_name,campaign_id,campaign_name,ad_id,ad_name";
const CORE_FIELDS = `${JOIN_FIELDS},spend,conversions,impressions,clicks,video_thumbnail_url`;

// Seguidores ganados atribuidos a cada anuncio — capa aparte y no crítica: los
// nombres salen del catálogo público de Windsor (connectors.windsor.ai/<connector>/fields,
// 2026-10-01) pero NO se verificó todavía contra una respuesta real de la
// cuenta de Taquión si conviven con otras métricas en la misma consulta. Si
// Windsor la rechaza, los anuncios se muestran igual, sin esa métrica.
const FOLLOWERS_FIELDS = "account_id,campaign_id,ad_id,follows";

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
  followers: number;
  hasFollowers: boolean;
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
      followers: 0,
      hasFollowers: false,
      hasCore: false,
    };
    byAd.set(key, acc);
  }
  return acc;
}

// Timeout, reintento y límite de concurrencia: ver lib/windsorFetch.ts. La
// consulta de anuncios de TikTok tarda ~9s en producción (2026-09-30).
function fetchLayer(fields: string, dateFrom: string, dateTo: string, timeoutMs?: number): Promise<any[]> {
  return fetchWindsorRows(CONNECTOR, fields, dateFrom, dateTo, timeoutMs);
}

export async function fetchTiktokAds(rangeKey: DateRangeKey = "month", opts: FetchAdsOptions = {}): Promise<{ ads: AdRow[]; warnings: string[]; failed?: boolean }> {
  const warnings: string[] = [];
  if (!process.env.WINDSOR_API_KEY) return { ads: [], warnings };

  const range = opts.range ?? resolveDateRange(rangeKey);
  const byAd = new Map<string, Accum>();

  // Núcleo y descubrimiento son independientes: en paralelo, el tiempo total
  // es el de la más lenta y no la suma.
  const discovery = discoveryWindowFor(range);
  const [coreRes, discoveryRes, followersRes] = await Promise.allSettled([
    fetchLayer(CORE_FIELDS, range.dateFrom, range.dateTo, opts.timeoutMs),
    opts.skipDiscovery ? Promise.resolve<any[]>([]) : fetchLayer(DISCOVERY_FIELDS, discovery.dateFrom, discovery.dateTo, opts.timeoutMs),
    opts.skipFollowers ? Promise.resolve<any[]>([]) : fetchLayer(FOLLOWERS_FIELDS, range.dateFrom, range.dateTo, opts.timeoutMs),
  ]);

  if (coreRes.status === "rejected") {
    warnings.push(`Windsor.ai (TikTok Ads, anuncios): falló la consulta principal. Detalle: ${reasonMessage(coreRes)}`);
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
    if (!acc.thumbnailUrl && row.video_thumbnail_url) acc.thumbnailUrl = String(row.video_thumbnail_url);
  }

  // Descubrimiento — ventana derivada del período elegido (ver
  // discoveryWindowFor en lib/windsor.ts): anuncios sin actividad en el período.
  if (discoveryRes.status === "rejected") {
    warnings.push(
      `Windsor.ai (TikTok Ads, anuncios): no se pudo consultar el histórico ampliado para descubrir anuncios sin actividad. Detalle: ${reasonMessage(discoveryRes)}`
    );
  } else {
    for (const row of discoveryRes.value) {
      const acc = getOrCreate(byAd, row);
      if (acc) acc.hasCore = true;
    }
  }

  // Seguidores por anuncio. Si la capa falla, el resultado se considera incompleto: no se guarda en
  // la caché como bueno y la pantalla avisa (antes quedaba sin la métrica, en silencio, hasta 6 horas).
  const followersLoaded = !opts.skipFollowers && followersRes.status === "fulfilled";
  if (followersRes.status === "rejected") {
    warnings.push(
      `Windsor.ai (TikTok Ads, anuncios): falló la consulta de seguidores por anuncio, esa métrica no se muestra por ahora. Detalle: ${reasonMessage(followersRes)}`
    );
  } else {
    for (const row of followersRes.value) {
      const acc = getOrCreate(byAd, row);
      if (!acc) continue;
      acc.hasFollowers = true;
      acc.followers += Number(row.follows ?? 0);
    }
  }

  if (byAd.size === 0) {
    warnings.push(`Windsor.ai (TikTok Ads, anuncios): no se encontró ningún anuncio conectado, ni con actividad ni sin ella, en la ventana de descubrimiento del período elegido.`);
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
      // Capa OK: un anuncio sin fila de seguidores ganó 0 (Windsor omite las filas en cero).
      // Capa caída u omitida: sin dato (la pantalla avisa), nunca un 0 inventado.
      followers: followersLoaded ? acc.followers : undefined,
    }));

  return { ads, warnings };
}
