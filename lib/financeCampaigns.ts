import type { FinanceCampaignRow } from "./types";
import type { DateRangeKey } from "./windsor";
import { fetchGoogleAdsCampaigns } from "./windsorCampaigns";
import { fetchMetaCampaigns } from "./windsorMeta";
import { fetchTiktokCampaigns } from "./windsorTiktok";
import { fetchMediaPlanBudgetByCampaign } from "./mediaPlan";
import { budgetKey } from "./matchKeys";

/**
 * Desglose por campaña para la vista Finanzas — a pedido explícito del
 * usuario: "todas las campañas por cuenta con su proyectado por campaña
 * específico, declarado en la sheet madre". Reutiliza los mismos fetchers
 * de campaña que ya usa Medios (lib/windsorCampaigns.ts / windsorMeta.ts /
 * windsorTiktok.ts) — no hay un fetcher nuevo, solo se reagrupan por cuenta
 * en vez de por plataforma, y se les suma el presupuesto de
 * lib/mediaPlan.ts (columna "campana", ver la nota ahí).
 *
 * A propósito, NO trae las métricas de performance de CampaignRow (CPM,
 * CTR, Alcance, etc.) — esas son para Medios. Finanzas solo necesita
 * presupuesto vs. real, las mismas 4 cosas que ya muestra a nivel cuenta
 * (Presupuesto proyectado / Real / Ritmo / Remanente, calculadas en
 * Dashboard.tsx a partir de `spend`/`budget`).
 *
 * Repite, sí, las 3 consultas de campaña que ya hace /api/campaigns en
 * paralelo — no hay capa de cache compartida entre rutas todavía (cada
 * request de este proyecto siempre pide fresco, `cache: "no-store"` en
 * todos lados) — una optimización a futuro si el costo de Windsor lo
 * justifica, no antes.
 *
 * SOLO SERVER-SIDE.
 */
export async function fetchCampaignsByAccount(
  rangeKey: DateRangeKey
): Promise<{ byAccount: Map<string, FinanceCampaignRow[]>; warnings: string[] }> {
  const warnings: string[] = [];

  const [google, meta, tiktok, budgets] = await Promise.all([
    fetchGoogleAdsCampaigns(rangeKey),
    fetchMetaCampaigns(rangeKey),
    fetchTiktokCampaigns(rangeKey),
    fetchMediaPlanBudgetByCampaign(),
  ]);
  warnings.push(...google.warnings, ...meta.warnings, ...tiktok.warnings);
  if (budgets.warning) warnings.push(budgets.warning);

  const byAccount = new Map<string, FinanceCampaignRow[]>();
  for (const c of [...google.campaigns, ...meta.campaigns, ...tiktok.campaigns]) {
    const list = byAccount.get(c.accountId) ?? [];
    list.push({
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      spend: c.spend,
      budget: budgets.byCampaign.get(budgetKey(c.accountId, c.campaignName)) ?? 0,
    });
    byAccount.set(c.accountId, list);
  }

  return { byAccount, warnings };
}
