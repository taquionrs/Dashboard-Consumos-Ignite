import { fetchMetaAuditData, readMetaConfig } from "./metaGraph";
import { evaluateMetaAudit, META_THRESHOLDS } from "./metaAudit";
import type { MetaAuditResult } from "./notifications";
import { buildMetaDailyMessages } from "./notifications";
import { readChatConfig, sendChatMessage } from "./chat";
import { listLog, newRunId, readStoreConfig, saveRun } from "./alertLog";
import type { DeliveryResult, RunRecord } from "./alertTypes";

/**
 * Corre la revisión de campañas de Meta (lecturas a la API de Meta + reglas de lib/metaAudit.ts).
 * - runMetaAudit: devuelve los hallazgos. `undefined` = no está configurada (falta META_ACCESS_TOKEN).
 *   Lo usa el resumen de martes y jueves y la revisión diaria.
 * - runDailyMetaReview: la revisión diaria (la dispara app/api/cron/calentar): avisa a Google Chat SOLO las alertas
 *   nuevas (las que no se avisaron en los últimos DEDUPE_DAYS días) y las deja en el registro de Medios → Alertas.
 *
 * SOLO SERVER-SIDE.
 */

/** Una alerta ya avisada no se vuelve a mandar al chat durante estos días (sigue visible en Medios → Alertas). */
export const DEDUPE_DAYS = 3;

const TZ = "America/Argentina/Buenos_Aires";

export async function runMetaAudit(now: Date = new Date()): Promise<MetaAuditResult | undefined> {
  const cfg = readMetaConfig();
  if (!cfg) return undefined;
  const data = await fetchMetaAuditData(cfg, META_THRESHOLDS.windowDays, now);
  return { findings: evaluateMetaAudit(data, cfg.pixelIds, cfg.requireUtm, now), partialErrors: data.partialErrors };
}

export interface DailyReviewResult {
  configured: boolean;
  ok: boolean;
  /** Alertas abiertas hoy / de las cuales nuevas (las que se avisan). */
  found: number;
  newCount: number;
  sent: number;
  /** Con dryRun: el texto exacto que se enviaría. */
  messages?: string[];
  error?: string;
  log?: { ok: boolean; error?: string };
  /** Falta el pixel en la configuración: la alerta de pixel no se evalúa. */
  pixelCheck: boolean;
}

export async function runDailyMetaReview(opts: { dryRun?: boolean } = {}, now: Date = new Date()): Promise<DailyReviewResult> {
  const cfg = readMetaConfig();
  if (!cfg) return { configured: false, ok: true, found: 0, newCount: 0, sent: 0, pixelCheck: false };
  const base = { configured: true, pixelCheck: cfg.pixelIds.length > 0 };

  let audit: MetaAuditResult;
  try {
    audit = (await runMetaAudit(now))!;
  } catch (err: any) {
    return { ...base, ok: false, found: 0, newCount: 0, sent: 0, error: String(err?.message || err) };
  }

  // Qué ya se avisó hace poco (por huella): no se repite todos los días.
  const already = new Set<string>();
  if (readStoreConfig()) {
    try {
      const { alerts } = await listLog();
      const since = now.getTime() - DEDUPE_DAYS * 86400000;
      for (const a of alerts) if (new Date(a.sentAt).getTime() >= since) already.add(a.fingerprint);
    } catch {
      // sin registro legible: se avisa todo (mejor repetir que callar)
    }
  }
  const fresh = audit.findings.filter((f) => !already.has(f.fingerprint));
  if (fresh.length === 0) return { ...base, ok: true, found: audit.findings.length, newCount: 0, sent: 0 };

  const dateLabel = now.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  const { chatMessages, alertDrafts } = buildMetaDailyMessages(audit, fresh, dateLabel);
  if (opts.dryRun) return { ...base, ok: true, found: audit.findings.length, newCount: fresh.length, sent: 0, messages: chatMessages };

  const chat = readChatConfig();
  let sent = 0;
  let error: string | undefined;
  if ("url" in chat) {
    for (const m of chatMessages) {
      const r = await sendChatMessage(chat.url, m);
      if (!r.ok) {
        error = r.error;
        break;
      }
      sent++;
    }
  } else {
    error = "invalid" in chat ? chat.invalid : "Falta GOOGLE_CHAT_WEBHOOK_URL: no hay dónde avisar.";
  }

  // Registro de trazabilidad: queda guardado haya llegado el aviso o no (y de acá sale la deduplicación de mañana).
  let log: { ok: boolean; error?: string };
  if (!readStoreConfig()) {
    log = { ok: false, error: "El registro de alertas no está configurado (falta Upstash Redis)." };
  } else {
    try {
      const deliveries: DeliveryResult[] = [{ channel: "googleChat", ok: !error && sent === chatMessages.length, detail: error ?? `${sent} mensaje${sent === 1 ? "" : "s"}` }];
      const run: RunRecord = {
        id: newRunId(),
        sentAt: now.toISOString(),
        dateLabel,
        subject: `Pulso Ignite — revisión de campañas de Meta: ${fresh.length} alerta${fresh.length === 1 ? "" : "s"} nueva${fresh.length === 1 ? "" : "s"} (${dateLabel})`,
        alertCount: alertDrafts.length,
        alertsBySection: { revisionMeta: alertDrafts.length },
        deliveries,
        messages: chatMessages,
        unavailable: audit.partialErrors,
        windowLabel: `Últimos ${META_THRESHOLDS.windowDays} días`,
      };
      await saveRun(run, alertDrafts);
      log = { ok: true };
    } catch (err: any) {
      log = { ok: false, error: String(err?.message || err) };
    }
  }
  return { ...base, ok: !error, found: audit.findings.length, newCount: fresh.length, sent, error, log };
}
