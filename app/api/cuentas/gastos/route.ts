import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { readStoreConfig } from "@/lib/redis";
import { CUENTAS_NOT_CONFIGURED, CuentasError, getPresupuesto } from "@/lib/cuentas";
import { esIdDeGasto, removeGasto, saveGasto } from "@/lib/cuentasGastos";
import { validarGasto } from "@/lib/cuentasCore";

export const dynamic = "force-dynamic";

/**
 * Gastos fuera de las plataformas de la vista Cuentas (UGC, envíos, shooting...). Los maneja quien tiene la
 * página Finanzas: lo exige middleware.ts y se vuelve a verificar acá. La lista se lee con GET /api/cuentas.
 *
 * POST   { fecha, lineaId, categoria, detalle, campana?, monto }        → alta
 * PUT    { id, fecha, lineaId, categoria, detalle, campana?, monto }    → cambio
 * DELETE ?id=…                                                         → baja
 *
 * Cada movimiento queda en la auditoría (quién y cuándo). Hace falta que el presupuesto esté cargado:
 * cada gasto cuenta contra una de sus líneas.
 */

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });

function guard(request: Request) {
  if (!readSession(request.headers).pages.includes("finanzas")) return fail(403, "Esta pantalla es para quien tiene la página Finanzas.");
  if (!readStoreConfig()) return fail(503, CUENTAS_NOT_CONFIGURED);
  return null;
}

const errorResponse = (err: any) => fail(err instanceof CuentasError ? err.status : 502, String(err?.message || err));

async function guardar(request: Request, conId: boolean) {
  const denied = guard(request);
  if (denied) return denied;
  let body: any;
  try {
    body = await request.json();
  } catch {
    return fail(400, "El cuerpo no es un JSON válido.");
  }
  if (conId && !esIdDeGasto(body?.id)) return fail(400, "Identificador de gasto inválido.");
  try {
    const presupuesto = await getPresupuesto();
    if (!presupuesto) return fail(409, "Primero cargá el presupuesto del año: cada gasto cuenta contra una de sus líneas.");
    const v = validarGasto(body, presupuesto.lineas.map((l) => l.id));
    if ("error" in v) return fail(400, v.error);
    const gasto = await saveGasto(v, readSession(request.headers).email, conId ? body.id : undefined);
    return NextResponse.json({ ok: true, gasto }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = (request: Request) => guardar(request, false);
export const PUT = (request: Request) => guardar(request, true);

export async function DELETE(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!esIdDeGasto(id)) return fail(400, "Identificador de gasto inválido.");
  try {
    return (await removeGasto(id, readSession(request.headers).email)) ? NextResponse.json({ ok: true }, { headers: NO_STORE }) : fail(404, "Ese gasto no existe.");
  } catch (err) {
    return errorResponse(err);
  }
}
