import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { hasWindsorCredentials } from "@/lib/windsor";
import { parseRange } from "@/lib/rangeParam";
import { fetchMetaCampaigns } from "@/lib/windsorMeta";
import { cachedWithFallback, hasDegradedWarning, staleWarning, CACHE_FRESH_MS, CACHE_MAX_STALE_MS } from "@/lib/cache";
import { readStoreConfig } from "@/lib/redis";
import { CUENTAS_NOT_CONFIGURED, CuentasError, getPresupuesto, listAudit, savePresupuesto } from "@/lib/cuentas";
import { ejecucionPorLinea, gastosDelPeriodo, gastosPorCampana, resumir, validarPresupuesto } from "@/lib/cuentasCore";
import { listGastos } from "@/lib/cuentasGastos";
import { normAccountId } from "@/lib/matchKeys";
import type { CampaignRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // ver WINDSOR_TIMEOUT_MS en lib/windsorFetch.ts

/**
 * Vista Cuentas (pantalla /cuentas). La usa quien tiene la página Finanzas:
 * lo exige middleware.ts y se vuelve a verificar acá.
 *
 * GET ?range=…[&from=…&to=…][&cuenta=<accountId>]
 *   → gastos cargados a mano del período (`gastos`, ver /api/cuentas/gastos) y gasto real de Meta del período ordenado por marca, ocasión y objetivo, y la ejecución de cada línea
 *     del presupuesto del año (ejecutado, % y saldo). Solo Meta por ahora; sin datos de ejemplo: si Windsor
 *     falla y no hay un resultado reciente, responde error.
 * PUT { inicio, lineas }  → guarda el presupuesto del año (con auditoría de quién lo cambió).
 */

const NO_STORE = { "Cache-Control": "no-store" };
const PERIODO_PLAN = "plan";

function forbidden(request: Request) {
  return readSession(request.headers).pages.includes("finanzas")
    ? null
    : NextResponse.json({ error: "Esta pantalla es para quien tiene la página Finanzas." }, { status: 403, headers: NO_STORE });
}

export async function GET(request: Request) {
  const denied = forbidden(request);
  if (denied) return denied;
  const sp = new URL(request.url).searchParams;

  let presupuesto = null;
  let audit: Awaited<ReturnType<typeof listAudit>> = [];
  let todosLosGastos: Awaited<ReturnType<typeof listGastos>> = [];
  const storeOk = readStoreConfig() !== null;
  try {
    [presupuesto, audit, todosLosGastos] = await Promise.all([getPresupuesto(), listAudit(), listGastos()]);
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: err instanceof CuentasError ? err.status : 502, headers: NO_STORE });
  }

  // "plan" = desde el inicio del plan cargado hasta hoy (tope de 366 días, igual que las fechas propias).
  const rangeSp = new URLSearchParams(sp);
  if (sp.get("range") === PERIODO_PLAN) {
    rangeSp.set("range", "custom");
    rangeSp.set("from", presupuesto?.inicio ?? `${new Date().getFullYear()}-01-01`);
    rangeSp.set("to", "9999-12-31");
  }
  const parsed = parseRange(new Request(`http://x/?${rangeSp.toString()}`));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  const gastos = gastosDelPeriodo(todosLosGastos, parsed.range.dateFrom, parsed.range.dateTo);
  const base = { configured: storeOk, presupuesto, audit, gastos, gastosPorCampana: gastosPorCampana(gastos), periodo: { desde: parsed.range.dateFrom, hasta: parsed.range.dateTo, dias: Math.round((Date.parse(parsed.range.dateTo) - Date.parse(parsed.range.dateFrom)) / 86400000) + 1 } };
  if (!hasWindsorCredentials()) {
    return NextResponse.json({ ...base, error: "Falta conectar Windsor.ai (WINDSOR_API_KEY): sin eso no hay gasto real para mostrar." }, { status: 503, headers: NO_STORE });
  }

  try {
    const result = await cachedWithFallback<{ campaigns: CampaignRow[]; warnings: string[] }>({
      key: `cuentas:meta:${parsed.id}`,
      freshMs: CACHE_FRESH_MS,
      maxStaleMs: CACHE_MAX_STALE_MS,
      load: async () => {
        const { campaigns, warnings, failed } = await fetchMetaCampaigns(parsed.input);
        if (failed) throw new Error(warnings.join(" | ") || "Windsor.ai no respondió");
        return { campaigns, warnings };
      },
      isClean: (r) => r.campaigns.length > 0 && !hasDegradedWarning(r.warnings),
      describe: (r) => r.warnings.join(" | "),
    });
    const warnings = [...result.value.warnings];
    if (result.stale) warnings.push(staleWarning(result.ageMs, result.refreshError));

    // Cuentas que aparecen en el período, para elegir una sola (Froneri) y no mezclar las propias de Taquión.
    const porCuenta = new Map<string, { accountId: string; accountName: string; gasto: number }>();
    for (const c of result.value.campaigns) {
      const k = normAccountId(c.accountId);
      const a = porCuenta.get(k) ?? { accountId: c.accountId, accountName: c.accountName, gasto: 0 };
      a.gasto += c.spend;
      porCuenta.set(k, a);
    }
    const cuentas = [...porCuenta.values()].sort((a, b) => b.gasto - a.gasto);

    const cuenta = sp.get("cuenta");
    const campanas = cuenta ? result.value.campaigns.filter((c) => normAccountId(c.accountId) === normAccountId(cuenta)) : result.value.campaigns;
    const resumen = resumir(campanas);
    const ejecucion = presupuesto ? ejecucionPorLinea(presupuesto.lineas, resumen.porMarca, gastos) : null;

    return NextResponse.json({ ...base, source: "windsor", fuente: "Meta Ads", cuentas, cuenta: cuenta ?? null, resumen, ejecucion, warnings }, { headers: NO_STORE });
  } catch (err: any) {
    return NextResponse.json({ ...base, error: `No se pudo consultar Meta en Windsor.ai: ${String(err?.message || err).slice(0, 300)}` }, { status: 502, headers: NO_STORE });
  }
}

export async function PUT(request: Request) {
  const denied = forbidden(request);
  if (denied) return denied;
  if (!readStoreConfig()) return NextResponse.json({ error: CUENTAS_NOT_CONFIGURED }, { status: 503, headers: NO_STORE });
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "El cuerpo no es un JSON válido." }, { status: 400, headers: NO_STORE });
  }
  const v = validarPresupuesto(body);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400, headers: NO_STORE });
  try {
    const presupuesto = await savePresupuesto(v, readSession(request.headers).email);
    return NextResponse.json({ ok: true, presupuesto }, { headers: NO_STORE });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: err instanceof CuentasError ? err.status : 502, headers: NO_STORE });
  }
}
