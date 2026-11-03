import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { readStoreConfig } from "@/lib/redis";
import { esIdDeCorte, type EnvioDeCorte } from "@/lib/cortesCore";
import { CORTES_NOT_CONFIGURED, CortesError, getCorte, saveEnvio } from "@/lib/cortes";
import { armarCuerpo, envioSinRespuesta, firmar, leerSecreto, resumirRespuesta, urlDeSuperlum } from "@/lib/enviarCorte";

export const dynamic = "force-dynamic";
// Superlum lee su base y llama al backend financiero antes de contestar: mismo orden de tiempo que /api/spend.
export const maxDuration = 60;

/**
 * Envía un corte guardado a Superlum, que lo valida y lo reenvía al backend financiero (pauta real por
 * cuenta y mes). Solo para quien tiene la página Finanzas: lo exige middleware.ts y se vuelve a verificar acá.
 *
 * POST /api/cortes/<id>/enviar → { ok, envio }
 *
 * - El resultado del envío (también si Superlum lo rechaza) viaja en `envio` con estado 200 y se guarda para
 *   mostrarlo en /cortes. Un error propio de Pulso (permiso, falta de configuración, corte inexistente)
 *   responde 4xx/5xx con `{ error }`.
 * - Reenviar el mismo corte es seguro: el backend lo reconoce por su identificador y no duplica nada.
 * - El secreto compartido (PULSO_SHARED_SECRET) firma el cuerpo y nunca se loguea ni se devuelve.
 */

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = readSession(request.headers);
  if (!session.pages.includes("finanzas")) {
    return NextResponse.json({ error: "Esta acción es para quien tiene la página Finanzas." }, { status: 403, headers: NO_STORE });
  }
  if (!esIdDeCorte(params.id)) return NextResponse.json({ error: "Identificador de corte inválido." }, { status: 400, headers: NO_STORE });
  if (!readStoreConfig()) return NextResponse.json({ error: CORTES_NOT_CONFIGURED }, { status: 503, headers: NO_STORE });

  const secreto = leerSecreto();
  if (!secreto) {
    return NextResponse.json(
      { error: "Falta PULSO_SHARED_SECRET (32 caracteres o más) en este entorno: sin él Pulso no puede firmar el envío. Lo carga Tecnología, con el mismo valor en Superlum." },
      { status: 503, headers: NO_STORE }
    );
  }
  const url = urlDeSuperlum();
  if (!url) return NextResponse.json({ error: "SUPERLUM_PULSO_URL no es una dirección https válida." }, { status: 503, headers: NO_STORE });

  try {
    const corte = await getCorte(params.id);
    if (!corte) return NextResponse.json({ error: "Ese corte no existe." }, { status: 404, headers: NO_STORE });

    // La hora del pedido se pone ahora: Superlum rechaza uno de más de 10 minutos.
    const ahora = new Date();
    const cuerpo = armarCuerpo(corte, ahora);
    let resumen;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-pulso-signature": firmar(secreto, cuerpo) },
        body: cuerpo,
        signal: AbortSignal.timeout(55_000),
        cache: "no-store",
      });
      resumen = resumirRespuesta(res.status, await res.json().catch(() => null));
    } catch (err: any) {
      resumen = envioSinRespuesta(String(err?.message || err));
    }

    const envio: EnvioDeCorte = { enviadoEn: ahora.toISOString(), enviadoPor: session.email, ...resumen };
    await saveEnvio(corte.id, envio);
    return NextResponse.json({ ok: envio.ok, envio }, { headers: NO_STORE });
  } catch (err: any) {
    const status = err instanceof CortesError ? err.status : 502;
    return NextResponse.json({ error: String(err?.message || err) }, { status, headers: NO_STORE });
  }
}
