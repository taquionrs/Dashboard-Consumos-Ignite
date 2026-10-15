/**
 * Tipos, etiquetas y validación del registro de alertas. SIN dependencias de
 * servidor: lo usan tanto lib/alertLog.ts (almacenamiento) como la pantalla
 * "Alertas" de Medios (componente cliente).
 */

export type AlertType =
  | "projection"
  | "next_month"
  | "sheet"
  | "week_over_week"
  | "frequency"
  | "ctr_below_campaign"
  | "ad_no_delivery"
  | "ad_no_pixel"
  | "spend_no_results"
  | "campaign_incomplete"
  | "ad_issue"
  | "account_issue";
export type AlertSeverity = "critical" | "warning";
export type ModerationStatus = "pending" | "reviewed" | "dismissed";

export const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  projection: "📈 Proyección a fin de mes",
  next_month: "📅 Presupuesto del mes próximo",
  sheet: "🔄 Hoja de proyectados",
  week_over_week: "📆 Variación semanal",
  frequency: "🔁 Frecuencia en Meta",
  ctr_below_campaign: "🖱️ CTR bajo el de su campaña",
  ad_no_delivery: "🚫 Anuncio activo sin entrega",
  ad_no_pixel: "🧩 Sin el pixel de Taquion",
  spend_no_results: "💸 Gasta y no registra resultados",
  campaign_incomplete: "🆕 Campaña nueva sin completar",
  ad_issue: "⛔ Anuncio rechazado o con problemas",
  account_issue: "🏦 Cuenta con problema",
};

export const STATUS_LABEL: Record<ModerationStatus, string> = {
  pending: "Pendiente",
  reviewed: "Revisada",
  dismissed: "Descartada",
};

/** Lo que arma el resumen (lib/notifications.ts) por cada alerta detectada. */
export interface AlertDraft {
  type: AlertType;
  severity: AlertSeverity;
  /** Qué cuenta/campaña/anuncio, en texto plano. */
  title: string;
  /** Detalle, una línea por elemento, en texto plano. */
  lines: string[];
  /** Identifica "la misma alerta" entre envíos distintos (para ver cuánto se repite). */
  fingerprint: string;
  /** false = se detectó pero quedó fuera de la lista del mensaje (límite de filas). */
  listed: boolean;
}

export interface AlertHistoryEntry {
  at: string; // ISO
  by: string;
  from: ModerationStatus;
  to: ModerationStatus;
  note?: string;
}

export interface AlertRecord extends AlertDraft {
  id: string;
  runId: string;
  /** Cuándo se envió el resumen que la incluyó (ISO). */
  sentAt: string;
  status: ModerationStatus;
  note?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  history: AlertHistoryEntry[];
}

export interface DeliveryResult {
  channel: "googleChat" | "email";
  ok: boolean;
  /** Mensajes enviados (Chat) o detalle del error. */
  detail?: string;
}

/** Un envío del cron (haya tenido alertas o no). */
export interface RunRecord {
  id: string;
  sentAt: string; // ISO
  dateLabel: string;
  subject: string;
  alertCount: number;
  alertsBySection: Record<string, number>;
  deliveries: DeliveryResult[];
  /** Texto exacto de los mensajes de Google Chat enviados. */
  messages: string[];
  unavailable: string[];
  windowLabel: string;
}

export const MODERATION_STATUSES: ModerationStatus[] = ["pending", "reviewed", "dismissed"];

export interface ModerationInput {
  status: ModerationStatus;
  note?: string;
  by: string;
}

/**
 * Valida el cuerpo de una moderación. Descartar exige un motivo: el registro
 * existe justamente para saber por qué se descartó una alerta.
 */
export function validateModeration(body: unknown): { ok: true; value: ModerationInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Cuerpo inválido." };
  const b = body as Record<string, unknown>;
  if (typeof b.status !== "string" || !MODERATION_STATUSES.includes(b.status as ModerationStatus)) {
    return { ok: false, error: "Estado inválido (pending, reviewed o dismissed)." };
  }
  const by = typeof b.by === "string" ? b.by.trim() : "";
  if (by.length < 2 || by.length > 60) return { ok: false, error: "Indicá quién modera (entre 2 y 60 caracteres)." };
  let note: string | undefined;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string") return { ok: false, error: "La nota debe ser texto." };
    note = b.note.trim() || undefined;
    if (note && note.length > 500) return { ok: false, error: "La nota no puede superar 500 caracteres." };
  }
  if (b.status === "dismissed" && (!note || note.length < 3)) {
    return { ok: false, error: "Para descartar una alerta hay que indicar el motivo." };
  }
  return { ok: true, value: { status: b.status as ModerationStatus, note, by } };
}

/** Los ids se arman en el servidor; se validan antes de usarlos como parte de una clave. */
export function isValidAlertId(id: string): boolean {
  return /^[a-z0-9]{4,20}-\d{1,4}$/.test(id);
}
