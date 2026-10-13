import type { AdRow } from "./types";
import { fetchWindsorRows, reasonMessage, type FetchAdsOptions } from "./windsorFetch";
import { resolveDateRange, discoveryWindowFor, type DateRangeKey } from "./windsor";

/**
 * Datos a nivel ANUNCIO para Meta Ads (Medios) — mismo patrón que
 * lib/windsorAds.ts (Google Ads): capa núcleo + descubrimiento (ventana
 * derivada del período elegido, ver discoveryWindowFor en lib/windsor.ts),
 * agrupado por account/campaign/ad.
 *
 * Timeout explícito de LAYER_TIMEOUT_MS por layer — verificado en vivo
 * 2026-09-21: esta consulta se quedó colgada indefinidamente en el preview
 * (probable causa: a nivel anuncio hay muchas más filas por cuenta que a
 * nivel campaña, una por creatividad).
 *
 * `ad_id`/`ad_name` verificados contra windsor.ai/data-field/facebook/
 * (2026-09-17) antes de escribir este archivo. Mismo cuidado que ya costó
 * un bug real a nivel campaña (lib/windsorMeta.ts): acá también el nombre
 * de CAMPAÑA es el campo `campaign`, no `campaign_name` — confirmado en esa
 * misma pasada. `ad_name` sí se llama así (no hay variante rara para ads).
 *
 * Sin cuota de subasta/calidad ni rankings acá tampoco — esas métricas
 * (quality_ranking, engagement_rate_ranking, conversion_rate_ranking, %
 * video visto) SÍ son de nivel anuncio en el modelo de Meta (a diferencia de
 * Google), así que en teoría podrían sumarse acá en una futura iteración —
 * quedan afuera de esta primera versión para no repetir el mismo patrón de
 * "campo nuevo, otra capa, otro riesgo de incompatibilidad" sin haber
 * verificado antes que el núcleo (spend/impresiones/clicks por anuncio)
 * funciona solo.
 *
 * `thumbnail_url` — verificado en vivo 2026-09-28 contra la cuenta real de
 * Taquión: viene poblado en el 100% de los anuncios (imagen estática, video,
 * lo que sea), a diferencia de `image_url` (también válido, pero viene
 * `null` en los anuncios de video). Por eso se usa `thumbnail_url` como
 * miniatura del creativo, no `image_url`. Convive bien con
 * spend/impressions/clicks en la misma consulta (no hace falta una capa
 * aparte, a diferencia de Google Ads — ver lib/windsorAds.ts). La URL viene
 * firmada por Facebook CDN con vencimiento (parámetro `oe=`) — no se puede
 * cachear ni guardar de un día para el otro, hay que pedirla fresca en cada
 * consulta (ya es lo que hace este archivo).
 *
 * SOLO SERVER-SIDE.
 */

const WINDSOR_BASE_URL = "https://connectors.windsor.ai";
const CONNECTOR = "facebook";

const JOIN_FIELDS = "account_id,account_name,campaign_id,campaign,ad_id,ad_name,date";
const DISCOVERY_FIELDS = "account_id,account_name,campaign_id,campaign,ad_id,ad_name";
const CORE_FIELDS = `${JOIN_FIELDS},spend,conversions,impressions,clicks,thumbnail_url`;

// Seguidores ganados atribuidos a cada anuncio — capa aparte y no crítica: los
// nombres salen del catálogo público de Windsor (connectors.windsor.ai/<connector>/fields,
// 2026-10-01) pero NO se verificó todavía contra una respuesta real de la
// cuenta de Taquión si conviven con otras métricas en la misma consulta. Si
// Windsor la rechaza, los anuncios se muestran igual, sin esa métrica.
const FOLLOWERS_FIELDS = "account_id,campaign_id,ad_id,instagram_profile_follow,actions_like";

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
      // "campaign" es el nombre real del campo en el connector "facebook" — ver nota arriba.
      campaignName: String(row.campaign ?? campaignId),
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
// consulta de anuncios de Meta tarda ~9s en producción (2026-09-30).
function fetchLayer(fields: string, dateFrom: string, dateTo: string, timeoutMs?: number): Promise<any[]> {
  return fetchWindsorRows(CONNECTOR, fields, dateFrom, dateTo, timeoutMs);
}

export async function fetchMetaAds(rangeKey: DateRangeKey = "month", opts: FetchAdsOptions = {}): Promise<{ ads: AdRow[]; warnings: string[]; failed?: boolean }> {
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
    warnings.push(`Windsor.ai (Meta Ads, anuncios): falló la consulta principal. Detalle: ${reasonMessage(coreRes)}`);
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
    if (!acc.thumbnailUrl && row.thumbnail_url) acc.thumbnailUrl = String(row.thumbnail_url);
  }

  // Descubrimiento — ventana derivada del período elegido (ver
  // discoveryWindowFor en lib/windsor.ts): anuncios sin actividad en el período.
  if (discoveryRes.status === "rejected") {
    warnings.push(
      `Windsor.ai (Meta Ads, anuncios): no se pudo consultar el histórico ampliado para descubrir anuncios sin actividad. Detalle: ${reasonMessage(discoveryRes)}`
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
      `Windsor.ai (Meta Ads, anuncios): falló la consulta de seguidores por anuncio, esa métrica no se muestra por ahora. Detalle: ${reasonMessage(followersRes)}`
    );
  } else {
    for (const row of followersRes.value) {
      const acc = getOrCreate(byAd, row);
      if (!acc) continue;
      acc.hasFollowers = true;
      acc.followers += Number(row.instagram_profile_follow ?? 0) + Number(row.actions_like ?? 0);
    }
  }

  if (byAd.size === 0) {
    warnings.push(`Windsor.ai (Meta Ads, anuncios): no se encontró ningún anuncio conectado, ni con actividad ni sin ella, en la ventana de descubrimiento del período elegido.`);
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
