import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { readSession } from "@/lib/auth";
import { readStoreConfig } from "@/lib/redis";
import { hasWindsorCredentials, resolveDateRange } from "@/lib/windsor";
import { parseRangeParams } from "@/lib/rangeParam";
import { loadWindsorSpend } from "@/lib/spendData";
import { staleWarning } from "@/lib/cache";
import { fetchManualBudget } from "@/lib/financeBudget";
import { listEquivalencias } from "@/lib/equivalencias";
import { armarCorte, esIdDeCorte } from "@/lib/cortesCore";
import { CORTES_NOT_CONFIGURED, CortesError, getCorte, listCortes, saveCorte } from "@/lib/cortes";

export const dynamic = "force-dynamic";
// Generar un corte consulta a Windsor, que a veces tarda: mismo tope que /api/spend.
export const maxDuration = 90;

/**
 * Cortes de finanzas (pantalla /cortes). Los usa quien tiene la página Finanzas:
 * lo exige middleware.ts y se vuelve a verificar acá.
 *
 * GET              → { configured, cortes, hayMas }  (los más nuevos primero, solo el resumen)
 * GET ?id=…        → { corte }  (el corte completo)
 * POST { preset } o { desde, hasta } → genera y guarda un corte nuevo → { ok: true, corte }
 *     preset: today | yesterday | 7d | 14d | 28d | month | lastmonth (los mismos que Finanzas)
 *     desde/hasta: AAAA-MM-DD, ambas inclusive (hasta se corta en hoy; máximo 366 días)
 *
 * Un corte es una foto: no se edita ni se borra. Nunca se genera con datos de ejemplo
 * ni con un resultado viejo de Windsor: si no se puede consultar, responde error.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function forbidden(request: Request) {
  return readSession(request.headers).pages.includes("finanzas")
    ? null
    : NextResponse.json({ error: "Esta pantalla es para quien tiene la página Finanzas." }, { status: 403, headers: NO_STORE });
}

function errorResponse(err: any) {
  const status = err instanceof CortesError ? err.status : 502;
  return NextResponse.json({ error: String(err?.message || err) }, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const denied = forbidden(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!readStoreConfig()) return NextResponse.json({ configured: false, cortes: [], hayMas: false }, { headers: NO_STORE });
  try {
    if (id !== null) {
      if (!esIdDeCorte(id)) return NextResponse.json({ error: "Identificador de corte inválido." }, { status: 400, headers: NO_STORE });
      const corte = await getCorte(id);
      return corte ? NextResponse.json({ corte }, { headers: NO_STORE }) : NextResponse.json({ error: "Ese corte no existe." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ configured: true, ...(await listCortes()) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  const denied = forbidden(request);
  if (denied) return denied;
  if (!readStoreConfig()) return NextResponse.json({ error: CORTES_NOT_CONFIGURED }, { status: 503, headers: NO_STORE });
  if (!hasWindsorCredentials()) {
    return NextResponse.json({ error: "Sin conexión a Windsor.ai no se generan cortes: los datos serían de ejemplo." }, { status: 503, headers: NO_STORE });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Cuerpo inválido." }, { status: 400, headers: NO_STORE });
  const sp = new URLSearchParams();
  if (typeof body.preset === "string") sp.set("range", body.preset);
  else {
    sp.set("range", "custom");
    sp.set("from", String(body.desde ?? ""));
    sp.set("to", String(body.hasta ?? ""));
  }
  const now = new Date();
  const parsed = parseRangeParams(sp, now);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  try {
    const result = await loadWindsorSpend(parsed);
    // Un corte es una foto que después viaja a Finanzas: nunca con un resultado viejo.
    if (result.stale) {
      return NextResponse.json(
        { error: `No se pudo consultar Windsor ahora, así que no se genera el corte (no se usan datos viejos). ${staleWarning(result.ageMs, result.refreshError)}` },
        { status: 502, headers: NO_STORE }
      );
    }

    const avisosExtra: string[] = [];
    const manual = await fetchManualBudget();
    if (manual.warning) avisosExtra.push(manual.warning);
    let equivalencias = null;
    try {
      equivalencias = (await listEquivalencias()).equivalencias;
    } catch (err: any) {
      avisosExtra.push(`Equivalencias: ${String(err?.message || err).slice(0, 150)}`);
    }

    const corte = armarCorte({
      spend: result.value,
      desde: parsed.range.dateFrom,
      hasta: parsed.range.dateTo,
      dias: parsed.range.daysInPeriod,
      hoy: resolveDateRange("today", now).dateTo,
      ahora: now,
      sufijo: randomUUID().slice(0, 4),
      generadoPor: readSession(request.headers).email,
      edadDatoMs: result.ageMs,
      presupuestoManual: manual.value,
      equivalencias,
      avisosExtra,
    });
    await saveCorte(corte);
    return NextResponse.json({ ok: true, corte }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
