import { NextResponse } from "next/server";
import { listLog, readStoreConfig } from "@/lib/alertLog";

export const dynamic = "force-dynamic";

/**
 * GET → registro de alertas enviadas por el cron (más nuevas primero) y los
 * envíos que las incluyeron. Alimenta la pantalla "Alertas" de Medios.
 *
 * { configured: false } = todavía no se conectó el almacenamiento (Upstash
 * Redis en Vercel → Storage): la pantalla explica cómo activarlo.
 *
 * Solo quien tiene la página Medios · Alertas: lo exige middleware.ts (permisos en lib/access.ts).
 */
export async function GET() {
  if (!readStoreConfig()) {
    return NextResponse.json({ configured: false, alerts: [], runs: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const { alerts, runs } = await listLog();
    return NextResponse.json({ configured: true, alerts, runs }, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    return NextResponse.json({ configured: true, error: String(err?.message || err), alerts: [], runs: [] }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
