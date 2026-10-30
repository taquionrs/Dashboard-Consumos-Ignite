import { MOCK_CLIENTS } from "./mockData";
import { fetchWindsorSpend } from "./windsor";
import { fetchCampaignsByAccount } from "./financeCampaigns";
import { cachedWithFallback, hasDegradedWarning, CACHE_FRESH_MS, CACHE_MAX_STALE_MS, type CachedResult } from "./cache";
import type { ParsedRange } from "./rangeParam";
import type { SpendResponse } from "./types";

/**
 * Consumo por cuenta (con desglose por campaña) de un período, desde Windsor.ai,
 * con la caché y el último-dato-bueno de lib/cache.ts. Lo comparten /api/spend
 * (la pantalla Finanzas) y la generación de cortes (/api/cortes): los dos ven
 * exactamente el mismo dato y la misma caché.
 *
 * SOLO SERVER-SIDE.
 */
export function loadWindsorSpend(parsed: ParsedRange): Promise<CachedResult<SpendResponse>> {
  const range = parsed.range;
  return cachedWithFallback<SpendResponse>({
    key: `spend:${parsed.id}`,
    freshMs: CACHE_FRESH_MS,
    maxStaleMs: CACHE_MAX_STALE_MS,
    load: async () => {
      // Cuentas (presupuesto/real ya existentes) + desglose por campaña
      // (lib/financeCampaigns.ts, a pedido explícito del usuario) en
      // paralelo — son 2 fuentes independientes que se mezclan acá, no
      // una depende de la otra.
      const [{ clients, warnings: spendWarnings }, { byAccount: campaignsByAccount, warnings: campaignWarnings }] = await Promise.all([
        fetchWindsorSpend(MOCK_CLIENTS, range),
        fetchCampaignsByAccount(parsed.input),
      ]);
      const warnings = [...spendWarnings, ...campaignWarnings];
      return {
        source: "windsor",
        today: range.today,
        daysInMonth: range.daysInPeriod,
        clients: clients.map((c) => (c.accountId ? { ...c, campaigns: campaignsByAccount.get(c.accountId) ?? [] } : c)),
        warnings: warnings.length ? warnings : undefined,
      } satisfies SpendResponse;
    },
    isClean: (r) => r.clients.length > 0 && !hasDegradedWarning(r.warnings),
    describe: (r) => (r.warnings ?? []).join(" | "),
  });
}
