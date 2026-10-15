import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { MOCK_CLIENTS } from "@/lib/mockData";
import { fetchWindsorSpend, hasWindsorCredentials, rangeFromDates, resolveDateRange } from "@/lib/windsor";
import { fetchMediaPlanTargets } from "@/lib/mediaPlan";
import { fetchGoogleAdsAds } from "@/lib/windsorAds";
import { fetchMetaAds } from "@/lib/windsorAdsMeta";
import { fetchTiktokAds } from "@/lib/windsorAdsTiktok";
import { fetchMetaFrequency } from "@/lib/windsorFrequency";
import type { FetchAdsOptions } from "@/lib/windsorFetch";
import { buildDigest, PLATFORM_LABEL, type AdsByPlatform, type MetaAuditResult } from "@/lib/notifications";
import { runMetaAudit, maxFreshAlerts } from "@/lib/metaAuditRun";
import { readEmailConfig, sendEmail } from "@/lib/email";
import { readChatConfig, sendChatMessage } from "@/lib/chat";
import { newRunId, readStoreConfig, saveRun } from "@/lib/alertLog";
import type { DeliveryResult, RunRecord } from "@/lib/alertTypes";
import type { AdRow, PlatformKey } from "@/lib/types";

export const dynamic = "force-dynamic";
// Más holgado que las pantallas: el primer pedido de una ventana de fechas nueva a
// Windsor puede tardar más de 20 s (ver CRON_LAYER_TIMEOUT_MS). El plan Hobby con
// Fluid Compute admite hasta 300 s.
export const maxDuration = 120;

/**
 * Resumen del equipo (alertas de gasto contra presupuesto y de performance de
 * anuncios, ver lib/notifications.ts). Lo dispara el cron de vercel.json:
 * martes y jueves a las 8:00 hs de Argentina (11:00 UTC, `0 11 * * 2,4`). Se
 * envía a TODOS los canales que estén configurados:
 *
 * - Google Chat: GOOGLE_CHAT_WEBHOOK_URL (ver lib/chat.ts)
 * - Email (Resend): RESEND_API_KEY + NOTIFY_FROM + NOTIFY_TO (ver lib/email.ts)
 *
 * GET /api/cron/notify            → arma y envía el resumen.
 * GET /api/cron/notify?dryRun=1   → arma el resumen y lo devuelve, sin enviar.
 *
 * Seguridad: es la única ruta que el login con SSO deja pasar (la llama el
 * cron, no una persona; ver CRON_PATHS en lib/access.ts), así que NO responde sin
 * `Authorization: Bearer <CRON_SECRET>` (Vercel lo agrega solo al invocar el
 * cron cuando la variable CRON_SECRET existe en el proyecto). Si CRON_SECRET
 * no está configurada, la ruta queda cerrada: nunca se abre por omisión.
 */

const TZ = "America/Argentina/Buenos_Aires";

/** Fecha de hoy en Argentina, YYYY-MM-DD (en-CA da ese formato). */
function artToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: TZ });
}
function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function nextMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const errMsg = (e: unknown) => (e as any)?.message || String(e);

const PLATFORMS: PlatformKey[] = ["google", "meta", "tiktok"];

/**
 * Timeout por consulta de anuncios y frecuencia del resumen. Cada envío usa ventanas
 * de fechas distintas a las del anterior, así que Windsor siempre las recibe "en frío":
 * en producción (2026-10-02) la primera consulta de anuncios de Meta superó los 20 s y
 * el resumen salió sin esa sección; la segunda, ya en caché de Windsor, tardó 2 s.
 */
const CRON_LAYER_TIMEOUT_MS = 70000;

export async function GET(request: Request) {
  const auth = cronAuthorized(request);
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "CRON_SECRET no está configurada en este entorno: la ruta queda cerrada." }, { status: 503 });
  }
  if (!auth) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  if (!hasWindsorCredentials()) {
    return NextResponse.json({ error: "Falta WINDSOR_API_KEY: no hay datos reales para resumir." }, { status: 503 });
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";

  // Canales: se validan antes de gastar consultas a Windsor.
  const chat = readChatConfig();
  const email = readEmailConfig();
  if ("invalid" in chat) {
    return NextResponse.json({ error: chat.invalid }, { status: 503 });
  }
  const hasChat = "url" in chat;
  const hasEmail = "config" in email;
  if (!dryRun && !hasChat && !hasEmail) {
    return NextResponse.json(
      { error: "No hay ningún canal de envío configurado. Cargá GOOGLE_CHAT_WEBHOOK_URL (Google Chat) o RESEND_API_KEY + NOTIFY_FROM + NOTIFY_TO (email)." },
      { status: 503 }
    );
  }

  // Fechas en hora de Argentina. Las ventanas de anuncios son de 7 días COMPLETOS
  // (los presets "7d"/"14d" incluyen el día de hoy, todavía incompleto): la actual
  // va del día -7 al -1 y la anterior del -14 al -8, así se comparan semanas parejas.
  const today = artToday();
  const [y, m, d] = today.split("-").map(Number);
  const monthRange = resolveDateRange("month", new Date(y, m - 1, d));
  const current = rangeFromDates(addDaysISO(today, -7), addDaysISO(today, -1));
  const previous = rangeFromDates(addDaysISO(today, -14), addDaysISO(today, -8));
  const currentMonthKey = today.slice(0, 7);

  // El resumen solo mira anuncios CON actividad: se omite la capa de descubrimiento
  // (>= 12 meses de historia, la consulta más lenta de Meta/TikTok, que en la primera
  // prueba en producción venció por timeout de 20 s). La semana anterior tampoco
  // necesita la capa de seguidores.
  const currentOpts: FetchAdsOptions = { skipDiscovery: true, range: current, timeoutMs: CRON_LAYER_TIMEOUT_MS };
  const previousOpts: FetchAdsOptions = { skipDiscovery: true, skipFollowers: true, range: previous, timeoutMs: CRON_LAYER_TIMEOUT_MS };

  const [spendRes, sheetRes, freqRes, metaRes, ...adsRes] = await Promise.allSettled([
    fetchWindsorSpend(MOCK_CLIENTS, monthRange),
    fetchMediaPlanTargets(),
    fetchMetaFrequency(current, CRON_LAYER_TIMEOUT_MS),
    runMetaAudit(),
    fetchGoogleAdsAds("7d", currentOpts),
    fetchMetaAds("7d", currentOpts),
    fetchTiktokAds("7d", currentOpts),
    fetchGoogleAdsAds("7d", previousOpts),
    fetchMetaAds("7d", previousOpts),
    fetchTiktokAds("7d", previousOpts),
  ]);

  const unavailable: string[] = [];

  let clients = null as Awaited<ReturnType<typeof fetchWindsorSpend>>["clients"] | null;
  if (spendRes.status === "fulfilled") clients = spendRes.value.clients;
  else unavailable.push(`Seguimiento del gasto: ${errMsg(spendRes.reason)}`);

  const sheet = sheetRes.status === "fulfilled" ? sheetRes.value : null;

  let frequency = null as Awaited<ReturnType<typeof fetchMetaFrequency>> | null;
  if (freqRes.status === "fulfilled") frequency = freqRes.value;
  else unavailable.push(`Frecuencia de Meta: ${errMsg(freqRes.reason)}`);

  // Revisión de campañas de Meta (API de Meta, solo lectura): undefined = no configurada, null = falló.
  let metaAudit: MetaAuditResult | null | undefined;
  if (metaRes.status === "fulfilled") {
    metaAudit = metaRes.value;
    // Mismo freno que la revisión diaria: una cantidad absurda de alertas es una regla mal calibrada, no un resumen útil.
    if (metaAudit && metaAudit.findings.length > maxFreshAlerts()) {
      unavailable.push(`Revisión de campañas de Meta: ${metaAudit.findings.length} alertas (más de ${maxFreshAlerts()}): se omite hasta revisar las reglas (?soloMeta=1&dryRun=1 en /api/cron/calentar).`);
      metaAudit = null;
    }
  } else {
    metaAudit = null;
    unavailable.push(`Revisión de campañas de Meta: ${errMsg(metaRes.reason)}`);
  }

  const collect = (results: PromiseSettledResult<{ ads: AdRow[]; warnings: string[]; failed?: boolean }>[], label: string): AdsByPlatform[] => {
    const out: AdsByPlatform[] = [];
    results.forEach((res, i) => {
      const platform = PLATFORMS[i];
      if (res.status === "rejected") unavailable.push(`${label} de ${PLATFORM_LABEL[platform]}: ${errMsg(res.reason)}`);
      else if (res.value.failed) unavailable.push(`${label} de ${PLATFORM_LABEL[platform]}: ${res.value.warnings.join(" | ")}`);
      else out.push({ platform, ads: res.value.ads });
    });
    return out;
  };
  const adsCurrent = collect(adsRes.slice(0, 3), "Anuncios");
  const adsPrevious = collect(adsRes.slice(3, 6), "Anuncios de la semana anterior");

  // Sin NADA que reportar (Windsor caído del todo): no se manda un resumen
  // vacío que parezca "todo bien"; se responde error para que quede en los logs.
  if (!clients && adsCurrent.length === 0 && !sheet && !frequency) {
    return NextResponse.json({ error: "No se pudo obtener ningún dato de Windsor.ai.", detail: unavailable }, { status: 502 });
  }

  const dateLabel = new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  const windowLabel = `Últimos 7 días (${ddmm(current.dateFrom)} al ${ddmm(current.dateTo)})`;

  const digest = buildDigest({
    today: monthRange.today,
    daysInPeriod: monthRange.daysInPeriod,
    dateLabel,
    currentMonthKey,
    nextMonthKey: nextMonthKey(currentMonthKey),
    clients,
    sheet,
    adsCurrent,
    adsPrevious,
    frequency,
    windowLabel,
    metaAudit,
    unavailable,
  });

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      channels: { googleChat: hasChat, email: hasEmail },
      subject: digest.subject,
      summary: digest.summary,
      unavailable,
      chat: digest.chatMessages,
      text: digest.text,
      html: digest.html,
    });
  }

  // Un canal que falla no impide el otro: se reporta cada resultado, y solo
  // es error (502) si NINGUNO pudo enviar.
  const results: Record<string, { ok: boolean; sent?: number; error?: string }> = {};
  if (hasChat) {
    let sent = 0;
    let error: string | undefined;
    for (const message of digest.chatMessages) {
      const r = await sendChatMessage(chat.url, message);
      if (!r.ok) {
        error = r.error;
        break;
      }
      sent++;
    }
    results.googleChat = { ok: sent === digest.chatMessages.length, sent, error };
  }
  if (hasEmail) results.email = await sendEmail(email.config, { subject: digest.subject, html: digest.html, text: digest.text });

  const sentAny = Object.values(results).some((r) => r.ok);

  // Registro de trazabilidad (pantalla "Alertas" de Medios): queda guardado el
  // envío completo, haya tenido alertas o no, y haya llegado o no. Un fallo del
  // registro NUNCA cambia el resultado del envío: solo se informa en `log`.
  const sentAt = new Date().toISOString();
  const run: RunRecord = {
    id: newRunId(),
    sentAt,
    dateLabel,
    subject: digest.subject,
    alertCount: digest.alertDrafts.length,
    alertsBySection: digest.summary.sections,
    deliveries: Object.entries(results).map(([channel, r]): DeliveryResult => ({
      channel: channel as DeliveryResult["channel"],
      ok: r.ok,
      detail: r.error ?? (r.sent !== undefined ? `${r.sent} mensaje${r.sent === 1 ? "" : "s"}` : undefined),
    })),
    messages: digest.chatMessages,
    unavailable,
    windowLabel,
  };
  let log: { ok: boolean; error?: string };
  if (!readStoreConfig()) {
    log = { ok: false, error: "El registro de alertas no está configurado (falta conectar Upstash Redis en Vercel → Storage)." };
  } else {
    try {
      await saveRun(run, digest.alertDrafts);
      log = { ok: true };
    } catch (err: any) {
      log = { ok: false, error: errMsg(err) };
    }
  }

  return NextResponse.json({ ok: sentAny, results, summary: digest.summary, unavailable, log }, { status: sentAny ? 200 : 502 });
}
