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
const NON_WEBSITE_DESTINATIONS = new Set(["ON_AD", "MESSENGER", "WHATSAPP", "INSTAGRAM_DIRECT", "ON_POST", "ON_VIDEO", "ON_PAGE", "ON_EVENT", "APP", "SHOP_AUTOMATIC", "PHONE_CALL"]);

const money = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");
const int = (n: number) => Math.round(n).toLocaleString("es-AR");
const names = (list: string[], max: number) => list.slice(0, max).join(", ") + (list.length > max ? ` y ${list.length - max} más` : "");
const ms = (iso: string) => (iso ? new Date(iso).getTime() : NaN);

/** ¿La campaña persigue una conversión en el sitio (la que necesita el pixel y registra resultados)? */
function isWebsiteConversion(ad: MetaAd): boolean {
  const byGoal = ad.adsetOptimizationGoal === "OFFSITE_CONVERSIONS" || ad.adsetOptimizationGoal === "VALUE";
  const byObjective = CONVERSION_OBJECTIVES.has(ad.campaignObjective) && !NON_WEBSITE_DESTINATIONS.has(ad.adsetDestinationType);
  return byGoal || byObjective;
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

  // 5) Anuncios rechazados o con problemas
  for (const ad of data.ads.filter((a) => a.effectiveStatus === "DISAPPROVED" || a.effectiveStatus === "WITH_ISSUES")) {
    const disapproved = ad.effectiveStatus === "DISAPPROVED";
    out.push({
      type: "ad_issue",
      severity: disapproved ? "critical" : "warning",
      fingerprint: `ad_issue:${ad.id}:${ad.effectiveStatus}`,
      title: ad.name,
      accountName: ad.accountName,
      lines: [`${ad.campaignName}`, disapproved ? "Anuncio rechazado por Meta: no está entregando." : "Anuncio con problemas: puede entregar limitado.", ...(ad.issues.length ? [`Motivo: ${ad.issues.slice(0, 2).join(" · ")}`] : [])],
    });
  }

  return out;
}
