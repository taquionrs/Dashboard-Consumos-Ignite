import { NextResponse } from "next/server";
import { allowedDomains, fixedAdmins, readSession } from "@/lib/auth";
import { readStoreConfig } from "@/lib/redis";
import { listUsers, removeUser, saveUser, UsersError, validateUserInput } from "@/lib/users";

export const dynamic = "force-dynamic";

/**
 * Gestión de usuarios de Pulso (pantalla /usuarios). Solo administradores: lo
 * exige middleware.ts y se vuelve a verificar acá, porque desde esta ruta se
 * dan permisos.
 *
 * GET                    → { configured, users, audit, fixedAdmins, domains }
 * PUT { email, pages, admin } → alta o cambio → { ok: true, user }
 * DELETE ?email=…        → baja → { ok: true }
 *
 * Reglas (lib/users.ts): los administradores fijos (ADMIN_EMAILS) no se tocan
 * desde acá y nadie puede cambiar ni quitar su propio acceso.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function forbidden(request: Request) {
  return readSession(request.headers).admin ? null : NextResponse.json({ error: "Solo un administrador puede gestionar usuarios." }, { status: 403, headers: NO_STORE });
}

function errorResponse(err: any) {
  const status = err instanceof UsersError ? err.status : 502;
  return NextResponse.json({ error: String(err?.message || err) }, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const denied = forbidden(request);
  if (denied) return denied;
  const base = { fixedAdmins: fixedAdmins(), domains: allowedDomains() };
  if (!readStoreConfig()) return NextResponse.json({ configured: false, users: [], audit: [], ...base }, { headers: NO_STORE });
  try {
    return NextResponse.json({ configured: true, ...(await listUsers()), ...base }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(request: Request) {
  const denied = forbidden(request);
  if (denied) return denied;
  const parsed = validateUserInput(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  try {
    const user = await saveUser(parsed.value, readSession(request.headers).email);
    return NextResponse.json({ ok: true, user }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request) {
  const denied = forbidden(request);
  if (denied) return denied;
  const email = new URL(request.url).searchParams.get("email") ?? "";
  try {
    const removed = await removeUser(email, readSession(request.headers).email);
    if (!removed) return NextResponse.json({ error: "El usuario no existe." }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
