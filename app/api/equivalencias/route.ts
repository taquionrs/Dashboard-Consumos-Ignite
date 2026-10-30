import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { readStoreConfig } from "@/lib/redis";
import { fetchMaestro } from "@/lib/maestro";
import { removeEquivalencia, saveEquivalencia, listEquivalencias, EquivalenciasError } from "@/lib/equivalencias";
import { resolverVinculo, validateEquivalenciaInput } from "@/lib/equivalenciasCore";

export const dynamic = "force-dynamic";

/**
 * Equivalencias cuenta publicitaria → cliente/proyecto de Superlum (pantalla
 * /equivalencias). La usa quien tiene la página Finanzas: lo exige middleware.ts
 * y se vuelve a verificar acá.
 *
 * GET                                  → { configured, maestro, warning, equivalencias, audit }
 * PUT { accountId, clienteId, proyectoId? } → alta o cambio → { ok: true, equivalencia }
 * DELETE ?accountId=…                  → baja → { ok: true }
 *
 * El cliente y el proyecto se comprueban contra el Maestro de Superlum y los
 * nombres que quedan guardados salen de ahí, no de lo que mande el navegador.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function forbidden(request: Request) {
  return readSession(request.headers).pages.includes("finanzas")
    ? null
    : NextResponse.json({ error: "Esta pantalla es para quien tiene la página Finanzas." }, { status: 403, headers: NO_STORE });
}

function errorResponse(err: any) {
  const status = err instanceof EquivalenciasError ? err.status : 502;
  return NextResponse.json({ error: String(err?.message || err) }, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const denied = forbidden(request);
  if (denied) return denied;
  const maestro = await fetchMaestro();
  const body = { maestro: maestro.data, warning: maestro.warning ?? null };
  if (!readStoreConfig()) return NextResponse.json({ configured: false, equivalencias: [], audit: [], ...body }, { headers: NO_STORE });
  try {
    return NextResponse.json({ configured: true, ...(await listEquivalencias()), ...body }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(request: Request) {
  const denied = forbidden(request);
  if (denied) return denied;
  const parsed = validateEquivalenciaInput(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const maestro = await fetchMaestro();
  if (!maestro.data) {
    return NextResponse.json({ error: `No se pudo comprobar el cliente en Superlum. ${maestro.warning ?? ""}`.trim() }, { status: 503, headers: NO_STORE });
  }
  const resolved = resolverVinculo(parsed.value, maestro.data);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400, headers: NO_STORE });
  try {
    const equivalencia = await saveEquivalencia(resolved.value, readSession(request.headers).email);
    return NextResponse.json({ ok: true, equivalencia }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request) {
  const denied = forbidden(request);
  if (denied) return denied;
  const accountId = new URL(request.url).searchParams.get("accountId") ?? "";
  try {
    const removed = await removeEquivalencia(accountId, readSession(request.headers).email);
    if (!removed) return NextResponse.json({ error: "Esa cuenta no tenía cliente vinculado." }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
