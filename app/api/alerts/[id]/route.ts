import { NextResponse } from "next/server";
import { moderateAlert, readStoreConfig } from "@/lib/alertLog";
import { isValidAlertId, validateModeration } from "@/lib/alertTypes";
import { readSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * PATCH { status: "pending" | "reviewed" | "dismissed", note? } → modera una alerta.
 *
 * - Quién modera (`by`) es la cuenta con la que se inició sesión en el SSO
 *   (middleware.ts): un `by` que mande el navegador se ignora.
 * - Descartar exige una `note` con el motivo.
 * - Cada cambio se agrega al historial; nada se borra.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!isValidAlertId(params.id)) {
    return NextResponse.json({ error: "Identificador de alerta inválido." }, { status: 400 });
  }
  if (!readStoreConfig()) {
    return NextResponse.json({ error: "El registro de alertas no está configurado." }, { status: 503 });
  }
  const body = await request.json().catch(() => null);
  const by = readSession(request.headers).email;
  const parsed = validateModeration(body && typeof body === "object" ? { ...body, by } : body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const updated = await moderateAlert(params.id, parsed.value);
    if (!updated) return NextResponse.json({ error: "La alerta no existe." }, { status: 404 });
    return NextResponse.json({ ok: true, alert: updated });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 502 });
  }
}
