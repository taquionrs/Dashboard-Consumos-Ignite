import type { AlertSeverity, AlertType } from "./alertTypes";
import type { MetaAccount, MetaAd, MetaAuditData } from "./metaGraph";

/**
 * Reglas de las alertas de calidad de campañas de Meta (revisión de solo lectura, ver lib/metaGraph.ts).
 * Funciones puras: reciben los datos ya leídos y devuelven los hallazgos, sin red.
 *
 * Alertas (definidas por el equipo, 2026-10-09 y 2026-10-15):
 *  - ad_no_delivery     Anuncio activo sin entrega.
 *  - ad_no_pixel        Anuncio o conjunto sin el pixel de Taquion.
 *  - spend_no_results   Campaña de conversión que gasta y no registra resultados.
 *  - campaign_incomplete Campaña nueva sin completar (presupuesto, parámetros UTM).
 *  - ad_issue           Anuncio rechazado o con problemas.
 *  - account_issue      Cuenta con problema de pago o restringida.
 *
 * Los umbrales de META_THRESHOLDS son una propuesta inicial, sin validar con el equipo: se ajustan acá.
 *
 * SOLO SERVER-SIDE.
 */

export const META_THRESHOLDS = {
  /** Días de métricas que se miran (incluido hoy). */
  windowDays: 3,
  /** Un anuncio activo sin impresiones se marca recién pasadas estas horas desde que arrancó. */
  noDeliveryHours: 24,
  /** Gasto mínimo en la ventana (moneda de la cuenta) para exigir resultados. */
  noResultsMinSpend: 20000,
  /** Una campaña es "nueva" durante estos días. */
  newCampaignDays: 7,
  /** Máximo de nombres de anuncios que se listan en una alerta. */
  namesListed: 4,
  /** Desde cuántas campañas de una misma cuenta con el mismo motivo se agrupa en una sola alerta de la cuenta. */
  accountGroupMinCampaigns: 4,
} as const;

export type MetaAlertType = Extract<AlertType, "ad_no_delivery" | "ad_no_pixel" | "spend_no_results" | "campaign_incomplete" | "ad_issue" | "account_issue">;

export interface MetaFinding {
  type: MetaAlertType;
  severity: AlertSeverity;
  fingerprint: string;
  /** Campaña, anuncio o cuenta afectada. */
  title: string;
  accountName: string;
  /** Detalle, una línea por elemento, en texto plano. */
  lines: string[];
}

const CONVERSION_OBJECTIVES = new Set(["OUTCOME_SALES", "OUTCOME_LEADS", "CONVERSIONS", "LEAD_GENERATION", "PRODUCT_CATALOG_SALES"]);
const UTM_OBJECTIVES = new Set(["OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_TRAFFIC", "CONVERSIONS", "LINK_CLICKS", "TRAFFIC", "LEAD_GENERATION"]);
const LIVE_PARENT = new Set(["ACTIVE", "WITH_ISSUES", "IN_PROCESS", "PENDING_REVIEW"]);
const NON_PIXEL_GOALS = new Set(["LEAD_GENERATION", "QUALITY_LEAD", "CONVERSATIONS", "REACH", "IMPRESSIONS", "LINK_CLICKS", "LANDING_PAGE_VIEWS", "THRUPLAY", "POST_ENGAGEMENT", "PAGE_LIKES", "PROFILE_VISIT", "VIDEO_VIEWS"]);
const NON_WEBSITE_DESTINATIONS = new Set(["ON_AD", "MESSENGER", "WHATSAPP", "INSTAGRAM_DIRECT", "ON_POST", "ON_VIDEO", "ON_PAGE", "ON_EVENT", "APP", "SHOP_AUTOMATIC", "PHONE_CALL"]);

const money = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");
const int = (n: number) => Math.round(n).toLocaleString("es-AR");
const names = (list: string[], max: number) => list.slice(0, max).join(", ") + (list.length > max ? ` y ${list.length - max} más` : "");
const ms = (iso: string) => (iso ? new Date(iso).getTime() : NaN);

/**
 * ¿La campaña optimiza una conversión en el SITIO (la que necesita el pixel y registra resultados)? Solo cuando el conjunto
 * optimiza por conversiones (OFFSITE_CONVERSIONS / VALUE) o la campaña es de ventas. Los leads con formulario
 * (LEAD_GENERATION), los mensajes de WhatsApp (CONVERSATIONS), el tráfico y la interacción NO llevan pixel de conversión.
 * Corregido tras la primera prueba con la cuenta real: marcaba campañas de WhatsApp y de formularios.
 */
function isWebsiteConversion(ad: MetaAd): boolean {
  if (ad.adsetOptimizationGoal === "OFFSITE_CONVERSIONS" || ad.adsetOptimizationGoal === "VALUE") return true;
  const salesObjective = ad.campaignObjective === "OUTCOME_SALES" || ad.campaignObjective === "CONVERSIONS" || ad.campaignObjective === "PRODUCT_CATALOG_SALES";
  return salesObjective && !NON_PIXEL_GOALS.has(ad.adsetOptimizationGoal) && !NON_WEBSITE_DESTINATIONS.has(ad.adsetDestinationType);
}

/** ¿El anuncio está realmente prendido? (él, su conjunto y su campaña). */
function isLive(ad: MetaAd): boolean {
  return ad.adStatus === "ACTIVE" && LIVE_PARENT.has(ad.adsetEffectiveStatus) && LIVE_PARENT.has(ad.campaignEffectiveStatus);
}

const ACCOUNT_STATUS: Record<number, string> = {
  2: "deshabilitada",
  3: "con un pago pendiente o fallido",
  7: "en revisión de riesgo",
  8: "con una liquidación pendiente",
  9: "en período de gracia de un pago",
  100: "en cierre temporal",
  101: "cerrada",
  201: "cerrada",
  202: "cerrada",
};

function accountFinding(a: MetaAccount): MetaFinding | null {
  if (a.status === 1 || a.status === -1) return null; // activa, o no se pudo leer (eso ya sale como error aparte)
  const what = ACCOUNT_STATUS[a.status] ?? `con un estado que requiere atención (código ${a.status})`;
  return {
    type: "account_issue",
    severity: "critical",
    fingerprint: `account_issue:${a.id}:${a.status}`,
    title: a.name,
    accountName: a.name,
    lines: [`La cuenta publicitaria está ${what}.`, "Si no se resuelve, los anuncios dejan de entregar."],
  };
}

export function evaluateMetaAudit(data: MetaAuditData, pixelIds: string[], requireUtm: boolean, now: Date = new Date()): MetaFinding[] {
  const T = META_THRESHOLDS;
  const out: MetaFinding[] = [];
  const nowMs = now.getTime();

  // ---- Cuentas
  for (const acc of data.accounts) {
    const f = accountFinding(acc);
    if (f) out.push(f);
  }

  // ---- Métricas por anuncio y por campaña
  const impByAd = new Map<string, number>();
  const campaignAgg = new Map<string, { spend: number; results: number }>();
  for (const i of data.insights) {
    impByAd.set(i.adId, (impByAd.get(i.adId) ?? 0) + i.impressions);
    const c = campaignAgg.get(i.campaignId) ?? { spend: 0, results: 0 };
    c.spend += i.spend;
    c.results += i.results;
    campaignAgg.set(i.campaignId, c);
  }

  const active = data.ads.filter((a) => a.effectiveStatus === "ACTIVE");
  const byCampaign = new Map<string, MetaAd[]>();
  for (const ad of active) byCampaign.set(ad.campaignId, [...(byCampaign.get(ad.campaignId) ?? []), ad]);

  for (const [campaignId, ads] of byCampaign) {
    const first = ads[0];

    // 1) Anuncios activos sin entrega
    const noDelivery = ads.filter((ad) => {
      const started = Math.max(ms(ad.createdTime) || 0, ms(ad.adsetStartTime) || 0);
      if (!started || started > nowMs) return false; // programado a futuro
      if (ms(ad.adsetEndTime) < nowMs) return false; // el conjunto ya terminó
      const hours = (nowMs - started) / 3600000;
      return hours >= T.noDeliveryHours && (impByAd.get(ad.id) ?? 0) === 0;
    });
    if (noDelivery.length > 0) {
      out.push({
        type: "ad_no_delivery",
        severity: "warning",
        fingerprint: `ad_no_delivery:${campaignId}`,
        title: first.campaignName,
        accountName: first.accountName,
        lines: [
          `${noDelivery.length} de ${ads.length} anuncio${ads.length === 1 ? "" : "s"} activo${ads.length === 1 ? "" : "s"} sin una sola impresión en ${T.windowDays} días: ${names(noDelivery.map((a) => a.name), T.namesListed)}`,
          "Revisar la audiencia, el presupuesto del conjunto, la fase de aprendizaje y el método de pago.",
        ],
      });
    }

    // 2) Sin el pixel de Taquion (solo campañas de conversión en el sitio)
    if (pixelIds.length > 0) {
      const conv = ads.filter(isWebsiteConversion);
      const noPixel = conv.filter((ad) => !pixelIds.includes(ad.adsetPixelId) || !ad.trackingPixelIds.some((p) => pixelIds.includes(p)));
      if (noPixel.length > 0) {
        const adsetMissing = noPixel.filter((a) => !pixelIds.includes(a.adsetPixelId));
        const adMissing = noPixel.filter((a) => !a.trackingPixelIds.some((p) => pixelIds.includes(p)));
        const lines: string[] = [];
        if (adsetMissing.length > 0) {
          const others = [...new Set(adsetMissing.map((a) => a.adsetPixelId).filter(Boolean))];
          lines.push(`Conjunto de anuncios sin el pixel de Taquion${others.length ? ` (usa ${others.join(", ")})` : " (ninguno elegido)"}: ${names([...new Set(adsetMissing.map((a) => a.adsetName))], T.namesListed)}`);
        }
        if (adMissing.length > 0) lines.push(`Anuncio sin el pixel en el seguimiento de conversiones: ${names(adMissing.map((a) => a.name), T.namesListed)}`);
        lines.push("Sin el pixel, la campaña gasta pero no registra resultados.");
        out.push({ type: "ad_no_pixel", severity: "critical", fingerprint: `ad_no_pixel:${campaignId}`, title: first.campaignName, accountName: first.accountName, lines });
      }
    }

    // 3) Gasta y no registra resultados (campañas de conversión)
    const agg = campaignAgg.get(campaignId);
    if (agg && ads.some(isWebsiteConversion) && agg.spend >= T.noResultsMinSpend && agg.results === 0) {
      out.push({
        type: "spend_no_results",
        severity: "critical",
        fingerprint: `spend_no_results:${campaignId}`,
        title: first.campaignName,
        accountName: first.accountName,
        lines: [`Gastó ${money(agg.spend)} en ${T.windowDays} días y no registró ningún resultado (compras, leads o registros).`, "Revisar el pixel, el evento de conversión y la página de destino."],
      });
    }

    // 4) Campaña nueva sin completar
    const created = ms(first.campaignCreatedTime);
    if (created && (nowMs - created) / 86400000 <= T.newCampaignDays) {
      const missing: string[] = [];
      const adsetsWithoutBudget = ads.filter((a) => !a.adsetHasBudget);
      if (!first.campaignHasBudget && adsetsWithoutBudget.length === ads.length) missing.push("no tiene presupuesto (ni en la campaña ni en los conjuntos)");
      if (requireUtm && UTM_OBJECTIVES.has(first.campaignObjective)) {
        const noUtm = ads.filter((a) => a.hasLink && !a.hasUtm);
        if (noUtm.length > 0) missing.push(`sin parámetros UTM en: ${names(noUtm.map((a) => a.name), T.namesListed)}`);
      }
      if (missing.length > 0) {
        out.push({
          type: "campaign_incomplete",
          severity: "warning",
          fingerprint: `campaign_incomplete:${campaignId}`,
          title: first.campaignName,
          accountName: first.accountName,
          lines: [`Campaña nueva (de los últimos ${T.newCampaignDays} días) incompleta: ${missing.join("; ")}`],
        });
      }
    }
  }

  // 5) Anuncios rechazados o con problemas: SOLO los prendidos (anuncio, conjunto y campaña), agrupados por campaña
  // (antes: un aviso por anuncio, incluidos miles de anuncios viejos con una advertencia menor).
  const troubled = new Map<string, MetaAd[]>();
  for (const ad of data.ads) {
    if ((ad.effectiveStatus === "DISAPPROVED" || ad.effectiveStatus === "WITH_ISSUES") && isLive(ad)) troubled.set(ad.campaignId, [...(troubled.get(ad.campaignId) ?? []), ad]);
  }
  // Cuando muchas campañas de UNA cuenta comparten el mismo motivo (caso real: "Anuncios en pausa debido a una cuenta
  // comprometida" en miles de anuncios de una cuenta), es UN problema de la cuenta y no miles de alertas.
  const slug = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").slice(0, 60) || "sin-motivo";
  type Troubled = { campaignId: string; ads: MetaAd[]; rejected: MetaAd[]; reason: string };
  const groups = new Map<string, Troubled[]>();
  for (const [campaignId, ads] of troubled) {
    const rejected = ads.filter((a) => a.effectiveStatus === "DISAPPROVED");
    const reason = ads.flatMap((a) => a.issues)[0] ?? "";
    const key = `${ads[0].accountId}|${slug(reason)}`;
    groups.set(key, [...(groups.get(key) ?? []), { campaignId, ads, rejected, reason }]);
  }
  for (const [key, list] of groups) {
    const first = list[0].ads[0];
    if (list.length >= T.accountGroupMinCampaigns) {
      const totalAds = list.reduce((n, t) => n + t.ads.length, 0);
      const anyRejected = list.some((t) => t.rejected.length > 0);
      const reason = list[0].reason;
      out.push({
        type: "ad_issue",
        severity: anyRejected ? "critical" : "warning",
        fingerprint: `ad_issue_cuenta:${key}`,
        title: first.accountName,
        accountName: first.accountName,
        lines: [
          `${list.length} campañas (${int(totalAds)} anuncios) de esta cuenta comparten el mismo problema${reason ? `: ${reason}` : ""}.`,
          `Por ejemplo: ${names(list.map((t) => t.ads[0].campaignName), T.namesListed)}`,
          "Es un problema de la cuenta: se resuelve una sola vez, no campaña por campaña.",
        ],
      });
      continue;
    }
    for (const t of list) {
      const { campaignId, ads, rejected } = t;
      const reasons = [...new Set(ads.flatMap((a) => a.issues))].slice(0, 3);
      const f = ads[0];
      out.push({
        type: "ad_issue",
        severity: rejected.length > 0 ? "critical" : "warning",
        fingerprint: `ad_issue:${campaignId}:${rejected.length > 0 ? "rejected" : "issues"}`,
        title: f.campaignName,
        accountName: f.accountName,
        lines: [
          ...(rejected.length > 0 ? [`${rejected.length} anuncio${rejected.length === 1 ? "" : "s"} rechazado${rejected.length === 1 ? "" : "s"} por Meta (no entregan): ${names(rejected.map((a) => a.name), T.namesListed)}`] : []),
          ...(ads.length - rejected.length > 0 ? [`${ads.length - rejected.length} anuncio${ads.length - rejected.length === 1 ? "" : "s"} con problemas (pueden entregar limitado): ${names(ads.filter((a) => a.effectiveStatus !== "DISAPPROVED").map((a) => a.name), T.namesListed)}`] : []),
          ...(reasons.length ? [`Motivo: ${reasons.join(" · ")}`] : []),
        ],
      });
    }
  }

  return out;
}
