/**
 * Lectura (SOLO LECTURA) de la API de Meta (Graph API) con el token de un usuario del sistema del Business
 * Manager de Taquion: es la fuente de las alertas de calidad de campañas (anuncio activo sin entrega, sin pixel,
 * gasta sin resultados, campaña nueva sin completar, rechazados y cuentas con problema).
 *
 * Por qué no sale de Windsor: Windsor solo devuelve anuncios que tuvieron impresiones, y no expone el pixel
 * de seguimiento de cada anuncio. La API de Meta sí lista todo lo que está activo, haya entregado o no.
 *
 * Variables de entorno (ver docs/reference/variables-de-entorno.md):
 * - META_ACCESS_TOKEN — token del usuario del sistema, permiso `ads_read` solamente. **Es una credencial**:
 *   solo en Vercel, como Sensitive. Va en el encabezado Authorization (nunca en la URL ni en los errores).
 * - META_PIXEL_IDS — IDs del pixel de Taquion, separados por coma. Sin esto no se evalúa la alerta de pixel.
 * - META_AD_ACCOUNT_IDS — opcional: cuentas a revisar (con o sin "act_"), separadas por coma. Sin esto se
 *   revisan todas las cuentas asignadas al usuario del sistema.
 * - META_GRAPH_VERSION — opcional, por defecto v23.0.
 * - META_REQUIRE_UTM — opcional: "0" apaga el chequeo de parámetros UTM en campañas nuevas.
 *
 * Nada de acá escribe en Meta: solo hay GET.
 *
 * SOLO SERVER-SIDE.
 */

const GRAPH = "https://graph.facebook.com";
const TIMEOUT_MS = 25000;
const MAX_PAGES = 10;
const ACCOUNT_CONCURRENCY = 3;

export interface MetaConfig {
  token: string;
  version: string;
  accountIds: string[] | null;
  pixelIds: string[];
  requireUtm: boolean;
}

export function readMetaConfig(): MetaConfig | null {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  if (!token) return null;
  const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const accountIds = list(process.env.META_AD_ACCOUNT_IDS).map((s) => s.replace(/^act_/i, "").replace(/\D/g, "")).filter(Boolean);
  return {
    token,
    version: process.env.META_GRAPH_VERSION?.trim() || "v23.0",
    accountIds: accountIds.length ? accountIds : null,
    pixelIds: list(process.env.META_PIXEL_IDS).map((s) => s.replace(/\D/g, "")).filter(Boolean),
    requireUtm: process.env.META_REQUIRE_UTM?.trim() !== "0",
  };
}

// ------------------------------------------------------------------ datos

export interface MetaAccount {
  id: string;
  name: string;
  /** account_status de Meta: 1 = activa. */
  status: number;
  disableReason?: number;
  currency?: string;
}

export interface MetaAd {
  id: string;
  name: string;
  effectiveStatus: string;
  createdTime: string;
  accountId: string;
  accountName: string;
  campaignId: string;
  campaignName: string;
  campaignObjective: string;
  campaignCreatedTime: string;
  campaignHasBudget: boolean;
  adsetId: string;
  adsetName: string;
  adsetOptimizationGoal: string;
  adsetDestinationType: string;
  adsetPixelId: string;
  adsetStartTime: string;
  adsetEndTime: string;
  adsetHasBudget: boolean;
  /** Pixeles del seguimiento de conversiones del anuncio (tracking_specs). */
  trackingPixelIds: string[];
  /** Motivos que informa Meta cuando el anuncio tiene problemas o fue rechazado. */
  issues: string[];
  /** Hay un enlace de destino con parámetros UTM (en la URL o en los parámetros del anuncio). */
  hasUtm: boolean;
  /** Hay un enlace de destino al que agregarle UTM. */
  hasLink: boolean;
}

export interface MetaInsight {
  adId: string;
  campaignId: string;
  spend: number;
  impressions: number;
  clicks: number;
  /** Suma de los resultados de conversión (compras, leads, registros, mensajes...). */
  results: number;
}

export interface MetaAuditData {
  accounts: MetaAccount[];
  ads: MetaAd[];
  insights: MetaInsight[];
  /** Ventana de las métricas (YYYY-MM-DD, ambas inclusive). */
  window: { since: string; until: string };
  /** Cuentas que no se pudieron leer, con el motivo (se muestran, no se ocultan). */
  partialErrors: string[];
}

// ------------------------------------------------------------------ HTTP

class MetaApiError extends Error {
  code?: number;
  status?: number;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80003, 80004]);

async function graphOnce(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    const e = new MetaApiError(`Meta API: ${String(body?.error?.message ?? `HTTP ${res.status}`).slice(0, 200)}`);
    e.code = body?.error?.code;
    e.status = res.status;
    throw e;
  }
  return body;
}

async function graphGet(cfg: MetaConfig, urlOrPath: string, params?: Record<string, string>): Promise<any> {
  const url = urlOrPath.startsWith("http")
    ? urlOrPath
    : `${GRAPH}/${cfg.version}/${urlOrPath}?${new URLSearchParams(params ?? {}).toString()}`;
  try {
    return await graphOnce(url, cfg.token);
  } catch (err: any) {
    const retryable = (err instanceof MetaApiError && (RATE_LIMIT_CODES.has(err.code ?? -1) || (err.status ?? 0) >= 500)) || err?.name === "TimeoutError";
    if (!retryable) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return graphOnce(url, cfg.token);
  }
}

/** Todas las páginas de un edge (hasta MAX_PAGES). */
async function graphList(cfg: MetaConfig, path: string, params: Record<string, string>): Promise<any[]> {
  const out: any[] = [];
  let body = await graphGet(cfg, path, params);
  for (let page = 0; ; page++) {
    out.push(...(Array.isArray(body?.data) ? body.data : []));
    const next = body?.paging?.next;
    if (!next || page + 1 >= MAX_PAGES) break;
    body = await graphGet(cfg, next);
  }
  return out;
}

// ------------------------------------------------------------------ lectura

const TZ = "America/Argentina/Buenos_Aires";
const artDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });

const ACCOUNT_FIELDS = "account_id,name,account_status,disable_reason,currency";

const AD_FIELDS = [
  "id", "name", "effective_status", "created_time", "tracking_specs", "issues_info",
  "creative{url_tags,object_story_spec,asset_feed_spec}",
  "adset{id,name,optimization_goal,destination_type,promoted_object,start_time,end_time,daily_budget,lifetime_budget}",
  "campaign{id,name,objective,created_time,daily_budget,lifetime_budget}",
].join(",");

// Estados que interesan: lo que está (o debería estar) corriendo y lo que tiene problemas.
const AD_STATUSES = ["ACTIVE", "WITH_ISSUES", "DISAPPROVED", "PENDING_REVIEW", "PENDING_BILLING_INFO", "IN_PROCESS"];

// Resultados de conversión: lo que cuenta como "resultado" en una campaña de ventas o de leads. Meta nombra las
// acciones de varias formas ("purchase", "offsite_conversion.fb_pixel_purchase", "onsite_conversion.lead_grouped"...):
// se busca el nombre del resultado en cualquier parte del tipo de acción.
const RESULT_ACTION = /purchase|lead|complete_registration|submit_application|contact|schedule|subscribe|start_trial|fb_pixel_custom|conversation_started|messaging_first_reply/;

function trackingPixels(specs: any): string[] {
  const out = new Set<string>();
  for (const spec of Array.isArray(specs) ? specs : []) {
    const px = spec?.["fb_pixel"];
    for (const id of Array.isArray(px) ? px : px ? [px] : []) out.add(String(id));
  }
  return [...out];
}

function linksOf(creative: any): string[] {
  const links: string[] = [];
  const oss = creative?.object_story_spec;
  if (oss?.link_data?.link) links.push(String(oss.link_data.link));
  if (oss?.video_data?.call_to_action?.value?.link) links.push(String(oss.video_data.call_to_action.value.link));
  for (const child of Array.isArray(oss?.link_data?.child_attachments) ? oss.link_data.child_attachments : []) if (child?.link) links.push(String(child.link));
  for (const l of Array.isArray(creative?.asset_feed_spec?.link_urls) ? creative.asset_feed_spec.link_urls : []) if (l?.website_url) links.push(String(l.website_url));
  return links;
}

function toAd(raw: any, account: MetaAccount): MetaAd | null {
  const adset = raw?.adset ?? {};
  const campaign = raw?.campaign ?? {};
  if (!raw?.id || !campaign?.id || !adset?.id) return null;
  const links = linksOf(raw.creative);
  const urlTags = String(raw.creative?.url_tags ?? "");
  const issues: string[] = [];
  for (const i of Array.isArray(raw.issues_info) ? raw.issues_info : []) {
    const text = String(i?.error_summary ?? i?.error_message ?? "").trim();
    if (text) issues.push(text.slice(0, 160));
  }
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    effectiveStatus: String(raw.effective_status ?? ""),
    createdTime: String(raw.created_time ?? ""),
    accountId: account.id,
    accountName: account.name,
    campaignId: String(campaign.id),
    campaignName: String(campaign.name ?? campaign.id),
    campaignObjective: String(campaign.objective ?? ""),
    campaignCreatedTime: String(campaign.created_time ?? raw.created_time ?? ""),
    campaignHasBudget: !!(Number(campaign.daily_budget) > 0 || Number(campaign.lifetime_budget) > 0),
    adsetId: String(adset.id),
    adsetName: String(adset.name ?? adset.id),
    adsetOptimizationGoal: String(adset.optimization_goal ?? ""),
    adsetDestinationType: String(adset.destination_type ?? ""),
    adsetPixelId: String(adset.promoted_object?.pixel_id ?? ""),
    adsetStartTime: String(adset.start_time ?? ""),
    adsetEndTime: String(adset.end_time ?? ""),
    adsetHasBudget: !!(Number(adset.daily_budget) > 0 || Number(adset.lifetime_budget) > 0),
    trackingPixelIds: trackingPixels(raw.tracking_specs),
    issues,
    hasUtm: /utm_/i.test(urlTags) || links.some((l) => /utm_/i.test(l)),
    hasLink: links.length > 0,
  };
}

async function readAccount(cfg: MetaConfig, account: MetaAccount, window: { since: string; until: string }): Promise<{ ads: MetaAd[]; insights: MetaInsight[] }> {
  const [adsRaw, insRaw] = await Promise.all([
    graphList(cfg, `act_${account.id}/ads`, {
      fields: AD_FIELDS,
      filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: AD_STATUSES }]),
      limit: "200",
    }),
    graphList(cfg, `act_${account.id}/insights`, {
      level: "ad",
      fields: "ad_id,campaign_id,spend,impressions,clicks,actions",
      time_range: JSON.stringify(window),
      limit: "500",
    }),
  ]);
  const ads = adsRaw.map((r) => toAd(r, account)).filter((a): a is MetaAd => !!a);
  const insights: MetaInsight[] = insRaw.map((r: any) => ({
    adId: String(r.ad_id ?? ""),
    campaignId: String(r.campaign_id ?? ""),
    spend: Number(r.spend ?? 0),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    results: (Array.isArray(r.actions) ? r.actions : []).filter((a: any) => RESULT_ACTION.test(String(a?.action_type ?? ""))).reduce((s: number, a: any) => s + Number(a?.value ?? 0), 0),
  }));
  return { ads, insights };
}

/**
 * Lee de Meta todo lo necesario para las alertas: cuentas, anuncios activos o con problemas y las métricas de los
 * últimos `windowDays` días (incluido hoy). Si una cuenta falla se sigue con las demás y queda anotado en
 * `partialErrors`; si fallan todas, tira.
 */
export async function fetchMetaAuditData(cfg: MetaConfig, windowDays: number, now: Date = new Date()): Promise<MetaAuditData> {
  const until = artDay(now);
  const since = artDay(new Date(now.getTime() - (windowDays - 1) * 86400000));
  const window = { since, until };

  const rawAccounts = cfg.accountIds
    ? await Promise.all(cfg.accountIds.map((id) => graphGet(cfg, `act_${id}`, { fields: ACCOUNT_FIELDS }).catch((e) => ({ account_id: id, name: `Cuenta ${id}`, account_status: -1, __error: e?.message }))))
    : await graphList(cfg, "me/adaccounts", { fields: ACCOUNT_FIELDS, limit: "100" });

  const accounts: MetaAccount[] = rawAccounts.map((r: any) => ({
    id: String(r.account_id ?? "").replace(/\D/g, ""),
    name: String(r.name ?? r.account_id ?? ""),
    status: Number(r.account_status ?? -1),
    disableReason: r.disable_reason !== undefined ? Number(r.disable_reason) : undefined,
    currency: r.currency ? String(r.currency) : undefined,
  }));

  const partialErrors: string[] = [];
  const ads: MetaAd[] = [];
  const insights: MetaInsight[] = [];
  const queue = accounts.filter((a) => a.id);
  let okCount = 0;
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      try {
        const r = await readAccount(cfg, a, window);
        ads.push(...r.ads);
        insights.push(...r.insights);
        okCount++;
      } catch (err: any) {
        partialErrors.push(`${a.name}: ${String(err?.message || err).slice(0, 160)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ACCOUNT_CONCURRENCY, queue.length) }, worker));

  if (accounts.length === 0) throw new Error("Meta no devolvió ninguna cuenta publicitaria asignada al usuario del sistema.");
  if (okCount === 0) throw new Error(`No se pudo leer ninguna cuenta de Meta. ${partialErrors.join(" | ")}`);
  return { accounts, ads, insights, window, partialErrors };
}
