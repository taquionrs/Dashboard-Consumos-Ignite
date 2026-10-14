import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { hasWindsorCredentials } from "@/lib/windsor";
import { GET as getSpend } from "@/app/api/spend/route";
import { GET as getCampaigns } from "@/app/api/campaigns/route";
import { GET as getAds } from "@/app/api/ads/route";
import { GET as getComparison } from "@/app/api/platform-comparison/route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Calentamiento diario de Windsor: pide, temprano a la mañana y antes de que entre el equipo, lo mismo que
 * piden las pantallas con el período por defecto ("Este mes"). Windsor tarda más de 20 s en la PRIMERA
 * consulta de una ventana nueva (la ventana de "Este mes" cambia de fecha final cada día) y responde en
 * segundos las siguientes; así, cuando alguien abre Pulso, las consultas ya están calientes.
 *
 * Llama directo a los handlers de las rutas (sin pasar por el login ni por la red), así que de paso
 * también deja llena la caché en memoria de esta instancia.
 *
 * Seguridad: igual que /api/cron/notify, es una ruta que el SSO deja pasar (ver CRON_PATHS en lib/access.ts)
 * y por eso exige `Authorization: Bearer <CRON_SECRET>`. Sin CRON_SECRET queda cerrada.
 *
 * GET /api/cron/calentar → calienta todo y devuelve un resumen (qué respondió bien y cuánto tardó).
 *
 * Plan Hobby de Vercel: un cron corre como máximo una vez por día, y dentro de la hora indicada.
 */

const BASE = "http://calentamiento.local";

const CALLS: { name: string; run: () => Promise<Response> }[] = [
  { name: "finanzas", run: () => getSpend(new Request(`${BASE}/api/spend?range=month`)) },
  ...(["google", "meta", "tiktok"] as const).flatMap((p) => [
    { name: `campañas ${p}`, run: () => getCampaigns(new Request(`${BASE}/api/campaigns?platform=${p}&range=month`)) },
    { name: `anuncios ${p}`, run: () => getAds(new Request(`${BASE}/api/ads?platform=${p}&range=month`)) },
  ]),
  { name: "comparación", run: () => getComparison(new Request(`${BASE}/api/platform-comparison?range=month`)) },
];

export async function GET(request: Request) {
  const auth = cronAuthorized(request);
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "CRON_SECRET no está configurada en este entorno: la ruta queda cerrada." }, { status: 503 });
  }
  if (!auth) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  if (!hasWindsorCredentials()) {
    return NextResponse.json({ error: "Falta WINDSOR_API_KEY: no hay nada que calentar." }, { status: 503 });
  }

  const t0 = Date.now();
  const results = await Promise.all(
    CALLS.map(async ({ name, run }) => {
      const start = Date.now();
      try {
        const res = await run();
        // Avisos de la respuesta (si Windsor devolvió algo incompleto, la pantalla no lo guarda en la caché).
        const body: any = await res.clone().json().catch(() => ({}));
        const warnings: string[] = Array.isArray(body?.warnings) ? body.warnings.map((w: string) => String(w).slice(0, 160)).slice(0, 3) : [];
        return { name, status: res.status, ok: res.ok, seconds: Math.round((Date.now() - start) / 100) / 10, ...(warnings.length ? { warnings } : {}) };
      } catch (err: any) {
        return { name, status: 500, ok: false, seconds: Math.round((Date.now() - start) / 100) / 10, error: String(err?.message || err).slice(0, 200) };
      }
    })
  );

  const failed = results.filter((r) => !r.ok);
  return NextResponse.json({ ok: failed.length === 0, totalSeconds: Math.round((Date.now() - t0) / 100) / 10, failed: failed.map((r) => r.name), results });
}
