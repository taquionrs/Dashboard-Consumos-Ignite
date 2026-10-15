import type { CampaignRow } from "./types";
import { fetchWindsorRows } from "./windsorFetch";
import { resolveDateRange, discoveryWindowFor, type RangeInput } from "./windsor";

/**
 * Datos a nivel CAMPAÑA (no cuenta) para la vista Medios — ver Artifact
 * "Pulso Ignite — Perfil Medios". Arranca solo con Google Ads: es la
 * plataforma con más métricas propias ya verificadas (ver
 * SDD-TAQUION/specs/003-dashboard-consumos.md, catálogo de métricas de
 * Medios) y la primera en conectarse a Windsor.ai. Meta Ads y TikTok Ads se
 * suman después, con el mismo patrón — ver el módulo por plataforma que
 * se agregue al lado de este.
 *
 * ⚠️ VERIFICADO 2026-09-17 contra una cuenta real: Windsor/Google Ads NO
 * deja pedir todos los campos en una sola consulta — HTTP 400
 * "Google Ads cannot return these fields in one request:
 * search_budget_lost_impression_share has no report in common with the
 * others". Google Ads organiza sus métricas en "reportes" (recursos de su
 * propia API: campaign, campaign con vista de subasta, etc.) y Windsor
 * respeta esa separación. Por eso acá se pide en CAPAS separadas — cada una
 * es su propio request, con su propio try/catch — en vez de una sola
 * consulta con todos los campos. Si una capa falla, se avisa y se sigue sin
 * esos campos particulares; el resto de la fila no se pierde.
 *
 * Capas actuales (agrupadas por lo que reveló el error de arriba — no hay
 * garantía de que el resto de los campos de la capa 2 sean 100%
 * compatibles entre sí; si aparece un nuevo error de "no report in common",
 * es la próxima capa a separar):
 *   1. Núcleo — account/campaign + spend/conversions/impressions/clicks,
 *      del período elegido.
 *   2. Descubrimiento — ventana ampliada pero derivada del período elegido
 *      (ver discoveryWindowFor en lib/windsor.ts, nunca una constante
 *      fija), solo identificadores (sin métricas). Encuentra campañas
 *      pausadas/sin actividad en el período elegido, que si no quedarían
 *      afuera en vez de mostrar $0 (mismo problema ya resuelto a nivel
 *      cuenta en lib/windsor.ts).
 *   3. Cuota de subasta y calidad — search_impression_share, quality_score,
 *      search_rank_lost_impression_share, search_absolute_top_impression_share,
 *      search_top_impression_share, optimization_score.
 *   4. search_budget_lost_impression_share, sola (la que Windsor marcó como
 *      incompatible con el resto).
 *
 * No se piden todavía content_impression_share (% impresión de display) ni
 * un campo de tasa de conversión nativo — quedaron marcados como "muy
 * probable, sin confirmar" en el catálogo; conversion_rate se calcula acá
 * mismo (conversions / clicks) en vez de pedirlo, para no depender de un
 * nombre de campo sin verificar.
 *
 * Los campos de % / score vienen día por día — se promedian sin ponderar
 * por spend, una simplificación deliberada hasta confirmar si Windsor
 * ofrece una forma de pedirlos ya agregados al período.
 *
 * SOLO SERVER-SIDE.
 */

const WINDSOR_BASE_URL = "https://connectors.windsor.ai";
const CONNECTOR = "google_ads";

const JOIN_FIELDS = "account_id,account_name,campaign_id,campaign_name,date";
const DISCOVERY_FIELDS = "account_id,account_name,campaign_id,campaign_name";
const CORE_FIELDS = `${JOIN_FIELDS},spend,conversions,impressions,clicks`;
const AUCTION_FIELDS = `${JOIN_FIELDS},search_impression_share,quality_score,search_rank_lost_impression_share,search_absolute_top_impression_share,search_top_impression_share,optimization_score`;
const BUDGET_LOST_FIELDS = `${JOIN_FIELDS},search_budget_lost_impression_share`;

const AVG_FIELDS = [
  "search_impression_share",
  "quality_score",
  "search_budget_lost_impression_share",
  "search_rank_lost_impression_share",
  "search_absolute_top_impression_share",
  "search_top_impression_share",
  "optimization_score",
] as const;

interface Accum {
  accountId: string;
  accountName: string;
  campaignId: string;
  campaignName: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  hasCore: boolean;
  // Para promediar los campos de % / score: suma + cuántas filas tenían el campo.
  sums: Record<string, number>;
  counts: Record<string, number>;
}

function getOrCreate(byCampaign: Map<string, Accum>, row: any): Accum | null {
  const campaignId = String(row.campaign_id ?? "");
  const accountId = String(row.account_id ?? "");
  if (!campaignId || !accountId) return null;
  const key = `${accountId}:${campaignId}`;
  let acc = byCampaign.get(key);
  if (!acc) {
    acc = {
      accountId,
      accountName: String(row.account_name ?? accountId),
      campaignId,
      // .trim() — ver la nota en lib/windsorMeta.ts: el cruce con el
      // presupuesto por campaña de la hoja de proyectados necesita el mismo
      // texto exacto que ahí (que sí viene recortado), un espacio de más
      // acá rompe ese cruce en silencio.
      campaignName: String(row.campaign_name ?? campaignId).trim(),
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: 0,
      hasCore: false,
      sums: {},
      counts: {},
    };
    byCampaign.set(key, acc);
  }
  return acc;
}

// Timeout, reintento y límite de concurrencia: ver lib/windsorFetch.ts.
function fetchLayer(fields: string, dateFrom: string, dateTo: string): Promise<any[]> {
  return fetchWindsorRows(CONNECTOR, fields, dateFrom, dateTo);
}

export async function fetchGoogleAdsCampaigns(
  rangeKey: RangeInput = "month"
): Promise<{ campaigns: CampaignRow[]; warnings: string[]; failed?: boolean }> {
  const warnings: string[] = [];
  if (!process.env.WINDSOR_API_KEY) return { campaigns: [], warnings };

  const range = resolveDateRange(rangeKey);
  const byCampaign = new Map<string, Accum>();

  // Todas las capas son independientes entre sí: se piden en paralelo, el
  // tiempo total es el de la más lenta y no la suma.
  const discoveryWindow = discoveryWindowFor(range);
  const coreP = fetchLayer(CORE_FIELDS, range.dateFrom, range.dateTo);
  const discoveryP = fetchLayer(DISCOVERY_FIELDS, discoveryWindow.dateFrom, discoveryWindow.dateTo);
  const auctionP = fetchLayer(AUCTION_FIELDS, range.dateFrom, range.dateTo);
  const budgetLostP = fetchLayer(BUDGET_LOST_FIELDS, range.dateFrom, range.dateTo);
  for (const p of [coreP, discoveryP, auctionP, budgetLostP]) p.catch(() => {});

  // Capa 1 — núcleo. Si esta falla, no hay nada que mostrar: se corta acá.
  try {
    const rows = await coreP;
    for (const row of rows) {
      const acc = getOrCreate(byCampaign, row);
      if (!acc) continue;
      acc.hasCore = true;
      acc.impressions += Number(row.impressions ?? 0);
      acc.clicks += Number(row.clicks ?? 0);
      acc.spend += Number(row.spend ?? 0);
      acc.conversions += Number(row.conversions ?? 0);
    }
  } catch (err: any) {
    warnings.push(`Windsor.ai (Google Ads, campañas): falló la consulta principal. Detalle: ${err?.message || err}`);
    return { campaigns: [], warnings, failed: true };
  }

  // Descubrimiento — ventana ampliada, derivada del período elegido (ver
  // discoveryWindowFor en lib/windsor.ts — nunca una constante fija,
  // corrección 2026-09-22), solo identificadores (sin métricas). Mismo
  // problema que ya resolvimos a nivel cuenta en lib/windsor.ts: Windsor no
  // manda una fila con spend "0", omite la campaña directamente si no tuvo
  // ningún evento en el período elegido — sin esto, una campaña pausada
  // desaparece en vez de mostrar $0 real. Corre siempre, no solo cuando la
  // capa 1 vino vacía, para no perder campañas mixtas (algunas activas,
  // otras pausadas, en la misma cuenta).
  try {
    const rows = await discoveryP;
    for (const row of rows) {
      const acc = getOrCreate(byCampaign, row);
      if (acc) acc.hasCore = true; // existe, aunque no haya tenido actividad en el período elegido
    }
  } catch (err: any) {
    warnings.push(
      `Windsor.ai (Google Ads, campañas): no se pudo consultar el histórico ampliado para descubrir campañas sin actividad. Detalle: ${err?.message || err}`
    );
  }

  if (byCampaign.size === 0) {
    warnings.push(`Windsor.ai (Google Ads, campañas): no se encontró ninguna campaña conectada, ni con actividad ni sin ella, en la ventana de descubrimiento del período elegido.`);
    return { campaigns: [], warnings };
  }

  // Capa 2 — cuota de subasta y calidad. Si falla, se sigue sin estas
  // columnas (quedan en "—" en la tabla) en vez de perder toda la fila.
  try {
    const rows = await auctionP;
    for (const row of rows) {
      const acc = getOrCreate(byCampaign, row);
      if (!acc) continue;
      for (const f of ["search_impression_share", "quality_score", "search_rank_lost_impression_share", "search_absolute_top_impression_share", "search_top_impression_share", "optimization_score"] as const) {
        const v = row[f];
        if (v === undefined || v === null || v === "") continue;
        const n = Number(v);
        if (Number.isNaN(n)) continue;
        acc.sums[f] = (acc.sums[f] ?? 0) + n;
        acc.counts[f] = (acc.counts[f] ?? 0) + 1;
      }
    }
  } catch (err: any) {
    warnings.push(
      `Windsor.ai (Google Ads, campañas): falló la consulta de cuota de subasta/calidad, esas columnas quedan sin datos. Detalle: ${err?.message || err}`
    );
  }

  // Capa 3 — la que Windsor marcó como incompatible con el resto.
  try {
    const rows = await budgetLostP;
    for (const row of rows) {
      const acc = getOrCreate(byCampaign, row);
      if (!acc) continue;
      const v = row.search_budget_lost_impression_share;
      if (v === undefined || v === null || v === "") continue;
      const n = Number(v);
      if (Number.isNaN(n)) continue;
      acc.sums.search_budget_lost_impression_share = (acc.sums.search_budget_lost_impression_share ?? 0) + n;
      acc.counts.search_budget_lost_impression_share = (acc.counts.search_budget_lost_impression_share ?? 0) + 1;
    }
  } catch (err: any) {
    warnings.push(
      `Windsor.ai (Google Ads, campañas): falló la consulta de pérdida por presupuesto, esa columna queda sin datos. Detalle: ${err?.message || err}`
    );
  }

  // Cuota de subasta, calidad y puntuación de optimización son métricas que
  // Google Ads calcula A PARTIR de impresiones reales en el período — si
  // ninguna campaña tuvo impresiones (ej. todas pausadas), es esperable que
  // ninguna de estas venga, sin que eso implique un nombre de campo mal
  // escrito. Por eso se distingue: si hay al menos una campaña con
  // impresiones y aun así un campo no vino en ninguna fila, ESO sí es
  // sospechoso (posible nombre de campo incorrecto) y se avisa por campo.
  // Si NINGUNA campaña tuvo impresiones, se avisa una única vez, aclarando
  // que es esperable.
  const anyImpressions = [...byCampaign.values()].some((acc) => acc.impressions > 0);
  if (anyImpressions) {
    AVG_FIELDS.forEach((f) => {
      const cameForAny = [...byCampaign.values()].some((acc) => (acc.counts[f] ?? 0) > 0);
      if (!cameForAny) {
        warnings.push(
          `Windsor.ai (Google Ads, campañas): el campo "${f}" no vino en ninguna fila pese a haber campañas con impresiones este período — esa columna va a quedar en "—" (verificar nombre contra windsor.ai/data-field/google_ads/).`
        );
      }
    });
  } else {
    warnings.push(
      `Windsor.ai (Google Ads, campañas): ninguna campaña tuvo impresiones en este período, así que cuota de subasta, nivel de calidad, pérdidas por presupuesto/ranking, posición y puntuación de optimización no tienen valor que calcular — esperable con cuentas sin actividad, no un problema de Windsor. Esas columnas quedan en "—" hasta que haya una campaña con impresiones reales.`
    );
  }

  const campaigns: CampaignRow[] = [...byCampaign.values()]
    .filter((acc) => acc.hasCore) // descarta filas que solo aparecieron en capas 2/3 (no deberían existir, pero por las dudas)
    .map((acc) => {
      const avg = (f: string) => (acc.counts[f] ? acc.sums[f] / acc.counts[f] : undefined);
      return {
        accountId: acc.accountId,
        accountName: acc.accountName,
        campaignId: acc.campaignId,
        campaignName: acc.campaignName,
        impressions: acc.impressions,
        clicks: acc.clicks,
        spend: acc.spend,
        budget: 0, // se pisa en app/api/campaigns/route.ts con el presupuesto real de la hoja madre
        cpm: acc.impressions > 0 ? (acc.spend / acc.impressions) * 1000 : 0,
        ctr: acc.impressions > 0 ? (acc.clicks / acc.impressions) * 100 : 0,
        cpl: acc.conversions > 0 ? acc.spend / acc.conversions : 0,
        conversions: acc.conversions,
        searchImpressionShare: avg("search_impression_share"),
        qualityScore: avg("quality_score"),
        searchBudgetLostIS: avg("search_budget_lost_impression_share"),
        searchRankLostIS: avg("search_rank_lost_impression_share"),
        searchAbsoluteTopIS: avg("search_absolute_top_impression_share"),
        searchTopIS: avg("search_top_impression_share"),
        optimizationScore: avg("optimization_score"),
      };
    });

  return { campaigns, warnings };
}
