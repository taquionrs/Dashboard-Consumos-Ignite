import { normAccountId } from "./matchKeys";
import type { AdRow, ClientData, PlatformKey } from "./types";
import type { MediaPlanTarget } from "./mediaPlan";
import type { FrequencyRow } from "./windsorFrequency";
import type { AlertDraft, AlertSeverity, AlertType } from "./alertTypes";
import type { MetaFinding, MetaAlertType } from "./metaAudit";

/**
 * Resumen del equipo (martes y jueves): alertas de gasto contra presupuesto y de
 * performance de anuncios. Este archivo SOLO arma el contenido (funciones puras,
 * sin red): lo consumen el envío a Google Chat (lib/chat.ts) y el email
 * (lib/email.ts) desde app/api/cron/notify/route.ts. Además de los mensajes,
 * devuelve cada alerta como un registro estructurado (`alertDrafts`) para el
 * registro de trazabilidad (lib/alertLog.ts, pantalla "Alertas" de Medios).
 *
 * Alertas (definidas por el equipo, 2026-10-01):
 *   Gasto contra proyectado: proyección a fin de mes · falta cargar el mes
 *   próximo (última semana del mes) · hoja de proyectados desactualizada.
 *   Performance de anuncios: costo por seguidor (3 mejores / 3 peores) ·
 *   variación contra la semana anterior · frecuencia alta en Meta · CTR muy por
 *   debajo del promedio de su campaña.
 *
 * Los umbrales de THRESHOLDS son una propuesta inicial (nadie del equipo definió
 * todavía cuáles son los correctos): se ajustan acá, en un solo lugar.
 *
 * SOLO SERVER-SIDE.
 */

export const THRESHOLDS = {
  // --- Proyección a fin de mes (proyectado ÷ presupuesto)
  projectionOver: 1.1, // por encima: se pasaría del presupuesto
  projectionUnder: 0.85, // por debajo: quedaría presupuesto sin ejecutar
  /** Días COMPLETOS de datos del mes necesarios para proyectar (antes es ruido). */
  minCompleteDaysForProjection: 3,
  // --- Mes próximo
  /** Se avisa en los últimos N días del mes. */
  nextMonthWindowDays: 7,
  // --- Variación contra la semana anterior
  wowChangePct: 30, // gasto o impresiones
  wowCtrChangePct: 25, // CTR (variación relativa)
  wowMinPrevImpressions: 5000, // volumen mínimo de la semana previa para comparar
  wowCtrMinImpressions: 1000, // impresiones mínimas de esta semana para juzgar el CTR
  // --- Costo por seguidor
  costPerFollowerMinFollowers: 5,
  costPerFollowerListSize: 3,
  // --- Frecuencia (Meta)
  frequencyHigh: 3,
  frequencyMinImpressions: 5000,
  // --- CTR contra el promedio de su campaña
  ctrBelowCampaignRatio: 0.5, // CTR del anuncio < 50% del de su campaña
  ctrMinImpressions: 1000,
  ctrMinAdsInCampaign: 2,
  /** Máximo de filas por lista. */
  listSize: 6,
} as const;

export const PLATFORM_LABEL: Record<PlatformKey, string> = {
  google: "Google Ads",
  meta: "Meta Ads",
  tiktok: "TikTok Ads",
  linkedin: "LinkedIn Ads",
};

export interface AdsByPlatform {
  platform: PlatformKey;
  ads: AdRow[];
}

/** Resultado de la revisión de campañas de Meta (lib/metaAudit.ts). */
export interface MetaAuditResult {
  findings: MetaFinding[];
  /** Cuentas que no se pudieron leer (se avisan en el mensaje). */
  partialErrors: string[];
}

export interface DigestInput {
  today: number;
  daysInPeriod: number;
  /** Ej. "martes, 6 de octubre". */
  dateLabel: string;
  currentMonthKey: string; // "2026-10"
  nextMonthKey: string; // "2026-11"
  /** null = no se pudo obtener el gasto. */
  clients: ClientData[] | null;
  /** null = no se pudo leer la hoja de proyectados. */
  sheet: { targets: MediaPlanTarget[]; warning?: string } | null;
  /** Ventana actual (7 días completos). */
  adsCurrent: AdsByPlatform[];
  /** Los 7 días anteriores a la ventana actual. */
  adsPrevious: AdsByPlatform[];
  /** null = no se pudo obtener. */
  frequency: FrequencyRow[] | null;
  windowLabel: string;
  /**
   * Revisión de campañas de Meta: undefined = no está configurada (no se muestra la sección),
   * null = estaba configurada pero no se pudo obtener.
   */
  metaAudit?: MetaAuditResult | null;
  /** Secciones que no se pudieron armar, con motivo: se muestran, no se ocultan. */
  unavailable: string[];
}

// ------------------------------------------------------------------ modelo

/** Texto con formato mínimo, que cada canal dibuja a su manera. */
export type Rich = Array<string | { b: string } | { c: string }>;
const B = (s: string) => ({ b: s });
const C = (s: string) => ({ c: s });

export interface Item {
  icon: string;
  head: Rich;
  lines: Rich[];
}
export interface Block {
  emoji: string;
  title: string;
  note?: string;
  items: Item[];
  /** Se muestra cuando no hay items (normalmente un "todo bien"). */
  empty?: string;
}
export interface Section {
  emoji: string;
  title: string;
  blocks: Block[];
}

export interface Digest {
  subject: string;
  html: string;
  text: string;
  /** Mensajes de Google Chat, en orden (el límite de Chat por mensaje es chico). */
  chatMessages: string[];
  /** Cada alerta detectada, lista para el registro de trazabilidad. */
  alertDrafts: AlertDraft[];
  summary: { alerts: number; sections: Record<string, number> };
}

// ------------------------------------------------------------------ formato

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const monthName = (key: string) => MONTHS[Number(key.slice(5, 7)) - 1] ?? key;

// Mismo formato que la UI de Pulso ($ pegado al número, punto de miles).
const money = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");
const int = (n: number) => Math.round(n).toLocaleString("es-AR");
const dec1 = (n: number) => n.toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct0 = (n: number) => `${Math.round(n)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n))}%`;
const trend = (n: number) => (n > 0.5 ? "📈" : n < -0.5 ? "📉" : "➖");

/** Los nombres de cuentas y anuncios vienen de plataformas externas: se escapan antes de ir al HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

type Mode = "chat" | "html" | "text";

function rich(parts: Rich, mode: Mode): string {
  return parts
    .map((p) => {
      if (typeof p === "string") return mode === "html" ? esc(p) : p;
      if ("b" in p) return mode === "chat" ? `*${p.b}*` : mode === "html" ? `<strong>${esc(p.b)}</strong>` : p.b;
      // Nombres en monoespaciado: llevan "_" y "*" que Chat interpretaría como formato.
      return mode === "chat" ? "`" + p.c.replace(/`/g, "'") + "`" : mode === "html" ? `<code>${esc(p.c)}</code>` : p.c;
    })
    .join("");
}

const SEPARATOR = "━━━━━━━━━━━━━━━━━━━━";
const INDENT = "      ";

function renderBlockText(b: Block, mode: "chat" | "text"): string {
  const out: string[] = [];
  out.push(mode === "chat" ? `${b.emoji} *${b.title}*` : `${b.emoji} ${b.title.toUpperCase()}`);
  if (b.note) out.push(mode === "chat" ? `_${b.note}_` : b.note);
  if (b.items.length === 0) {
    out.push("", b.empty ?? "Sin datos.");
    return out.join("\n");
  }
  for (const it of b.items) {
    out.push("");
    out.push(`${it.icon} ${rich(it.head, mode)}`);
    for (const l of it.lines) out.push(INDENT + rich(l, mode));
  }
  return out.join("\n");
}

function joinBlocks(blocks: string[]): string[] {
  return blocks.flatMap((t, i) => (i === 0 ? [t] : ["", "", t]));
}

/** Largo máximo de un mensaje de Chat (lib/chat.ts corta en 4000: acá se queda debajo). */
export const CHAT_SOFT_LIMIT = 3800;

export function packSectionForChat(s: Section, prefix: string[] = []): string[] {
  const head = (cont: boolean) => [...(cont ? [] : prefix), SEPARATOR, `${s.emoji} *${s.title}${cont ? " (continuación)" : ""}*`, "", ""].join("\n");
  const messages: string[] = [];
  let cur = head(false);
  let curHasBlock = false;
  for (const block of s.blocks) {
    const part = renderBlockText(block, "chat");
    const candidate = cur + (curHasBlock ? "\n\n\n" : "") + part;
    if (curHasBlock && candidate.length > CHAT_SOFT_LIMIT) {
      messages.push(cur);
      cur = head(true) + part;
    } else {
      cur = candidate;
    }
    curHasBlock = true;
  }
  messages.push(cur);
  return messages;
}

function renderSectionText(s: Section): string {
  return [SEPARATOR, `${s.emoji} ${s.title}`, "", ...joinBlocks(s.blocks.map((b) => renderBlockText(b, "text")))].join("\n");
}

function renderSectionHtml(s: Section): string {
  const h: string[] = [];
  h.push(`<h3 style="margin:28px 0 8px;font-size:16px;border-top:2px solid #eaecf0;padding-top:16px">${s.emoji} ${esc(s.title)}</h3>`);
  for (const b of s.blocks) {
    h.push(`<h4 style="margin:18px 0 4px;font-size:14px">${b.emoji} ${esc(b.title)}</h4>`);
    if (b.note) h.push(`<p style="margin:0 0 8px;font-size:12px;color:#475467"><em>${esc(b.note)}</em></p>`);
    if (b.items.length === 0) {
      h.push(`<p style="margin:6px 0;font-size:13px">${esc(b.empty ?? "Sin datos.")}</p>`);
      continue;
    }
    for (const it of b.items) {
      h.push(`<div style="margin:0 0 12px;font-size:13px;line-height:1.5"><div>${it.icon} ${rich(it.head, "html")}</div>`);
      for (const l of it.lines) h.push(`<div style="margin-left:26px;color:#344054">${rich(l, "html")}</div>`);
      h.push(`</div>`);
    }
  }
  return h.join("");
}

// ------------------------------------------------------------------ alertas

interface Built {
  blocks: Block[];
  alerts: number;
  /** Una por alerta detectada (incluye las que quedaron fuera de la lista del mensaje). */
  drafts: AlertDraft[];
}

const monthMatches = (mes: string, key: string) => mes.startsWith(key);

function platformsOf(c: ClientData): string {
  return Object.keys(c.mix)
    .map((k) => PLATFORM_LABEL[k as PlatformKey] ?? k)
    .join(" + ");
}

/** Convierte un ítem del mensaje en el registro estructurado de esa alerta (texto plano). */
function draftFrom(item: Item, meta: { type: AlertType; severity: AlertSeverity; fingerprint: string; listed?: boolean }): AlertDraft {
  return {
    type: meta.type,
    severity: meta.severity,
    fingerprint: meta.fingerprint,
    listed: meta.listed ?? true,
    title: rich(item.head, "text"),
    lines: item.lines.map((l) => rich(l, "text")),
  };
}

const built = (blocks: Block[], drafts: AlertDraft[]): Built => ({ blocks, alerts: drafts.length, drafts });

// ----- Revisión de campañas de Meta (lib/metaAudit.ts)

const META_BLOCKS: Array<{ type: MetaAlertType; emoji: string; title: string; note?: string }> = [
  { type: "account_issue", emoji: "🏦", title: "Cuentas con problema" },
  { type: "ad_issue", emoji: "⛔", title: "Anuncios rechazados o con problemas" },
  { type: "ad_no_pixel", emoji: "🧩", title: "Sin el pixel de Taquion", note: "Campañas de conversión en el sitio sin el pixel en el conjunto de anuncios o en el seguimiento del anuncio." },
  { type: "spend_no_results", emoji: "💸", title: "Gastan y no registran resultados", note: "Campañas de conversión con gasto y cero resultados en los últimos 3 días." },
  { type: "ad_no_delivery", emoji: "🚫", title: "Anuncios activos sin entrega", note: "Activos hace más de 24 horas y sin una sola impresión en los últimos 3 días." },
  { type: "campaign_incomplete", emoji: "🆕", title: "Campañas nuevas sin completar", note: "Campañas de los últimos 7 días sin presupuesto o sin parámetros UTM." },
];

export function metaAuditBlocks(audit: MetaAuditResult | null): Built {
  const T = THRESHOLDS;
  if (!audit) {
    return built([{ emoji: "🛡️", title: "Revisión de campañas de Meta", items: [], empty: "⚠️ Sección no disponible en este envío." }], []);
  }
  const blocks: Block[] = [];
  const drafts: AlertDraft[] = [];
  for (const def of META_BLOCKS) {
    const list = audit.findings.filter((f) => f.type === def.type);
    if (list.length === 0) continue;
    const items: Item[] = list.map((f) => ({
      icon: f.severity === "critical" ? "🔴" : "🟠",
      head: [C(f.title)],
      lines: [...(f.accountName && f.accountName !== f.title ? [[f.accountName] as Rich] : []), ...f.lines.map((l) => [l] as Rich)],
    }));
    list.forEach((f, i) => drafts.push(draftFrom(items[i], { type: f.type, severity: f.severity, fingerprint: f.fingerprint, listed: i < T.listSize })));
    blocks.push({ emoji: def.emoji, title: def.title, note: def.note, items: items.slice(0, T.listSize) });
    if (list.length > T.listSize) blocks[blocks.length - 1].items.push({ icon: "➕", head: [`${list.length - T.listSize} más en Medios → Alertas`], lines: [] });
  }
  if (blocks.length === 0) {
    blocks.push({ emoji: "✅", title: "Campañas de Meta", items: [], empty: "✅ Todo en orden: nada sin entrega, sin pixel ni rechazado." });
  }
  if (audit.partialErrors.length > 0) {
    blocks.push({ emoji: "⚠️", title: "Cuentas de Meta que no se pudieron leer", items: audit.partialErrors.map((e) => ({ icon: "•", head: [e], lines: [] })) });
  }
  return built(blocks, drafts);
}

/**
 * Mensaje de la revisión diaria de Meta (lo manda app/api/cron/calentar a Google Chat cuando hay alertas NUEVAS).
 * `newCount`: cuántas de las alertas son nuevas (las demás ya se avisaron en los últimos días y no se repiten).
 */
export function buildMetaDailyMessages(audit: MetaAuditResult, newFindings: MetaFinding[], dateLabel: string): { chatMessages: string[]; alertDrafts: AlertDraft[] } {
  const only: MetaAuditResult = { findings: newFindings, partialErrors: [] };
  const b = metaAuditBlocks(only);
  const head = [
    "🛡️ *PULSO IGNITE — REVISIÓN DE CAMPAÑAS*",
    `🗓️ _${dateLabel}_`,
    `🔔 *${newFindings.length} alerta${newFindings.length === 1 ? "" : "s"} nueva${newFindings.length === 1 ? "" : "s"}* en Meta${audit.findings.length > newFindings.length ? ` _(${audit.findings.length - newFindings.length} más ya se avisaron y siguen abiertas)_` : ""}`,
  ];
  const chatMessages = packSectionForChat({ emoji: "🛡️", title: "REVISIÓN DE CAMPAÑAS · Meta", blocks: b.blocks }, [...head, ""]);
  return { chatMessages, alertDrafts: b.drafts };
}

// ----- 1) Proyección a fin de mes

type ProjStatus = "exceeded" | "over" | "under" | "ok" | "pending";

export function projectionBlock(clients: ClientData[] | null, today: number, daysInPeriod: number): Built {
  const T = THRESHOLDS;
  if (!clients) {
    return built([{ emoji: "📈", title: "Proyección a fin de mes", items: [], empty: "⚠️ Sección no disponible en este envío." }], []);
  }
  // Windsor sincroniza una vez por día: a la mañana el gasto llega hasta AYER, así
  // que se proyecta sobre los días completos (today - 1), no sobre today.
  const completeDays = Math.max(today - 1, 0);
  const canProject = completeDays >= T.minCompleteDaysForProjection;

  let withoutBudget = 0;
  const rows: Array<{ c: ClientData; executed: number; projectedSpend?: number; projectedPct?: number; status: ProjStatus }> = [];
  for (const c of clients) {
    if (!(c.budget > 0)) {
      withoutBudget++;
      continue;
    }
    const executed = (c.spend8 / c.budget) * 100;
    const projectedSpend = canProject ? (c.spend8 / completeDays) * daysInPeriod : undefined;
    const projectedPct = projectedSpend !== undefined ? (projectedSpend / c.budget) * 100 : undefined;
    let status: ProjStatus;
    if (executed >= 100) status = "exceeded";
    else if (projectedPct === undefined) status = "pending";
    else if (projectedPct > T.projectionOver * 100) status = "over";
    else if (projectedPct < T.projectionUnder * 100) status = "under";
    else status = "ok";
    rows.push({ c, executed, projectedSpend, projectedPct, status });
  }
  const order: Record<ProjStatus, number> = { exceeded: 0, over: 1, under: 2, pending: 3, ok: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || (b.projectedPct ?? b.executed) - (a.projectedPct ?? a.executed));

  const ICON: Record<ProjStatus, string> = { exceeded: "🚨", over: "🔴", under: "🟠", ok: "🟢", pending: "⏳" };
  const items: Item[] = rows.map((r) => {
    const lines: Rich[] = [["💵 Gastó ", B(money(r.c.spend8)), ` de ${money(r.c.budget)} (${pct0(r.executed)} del presupuesto)`]];
    if (r.status === "exceeded") {
      lines.push(["🚨 ", B("Presupuesto superado")]);
    } else if (r.projectedPct !== undefined && r.projectedSpend !== undefined) {
      const verdict = r.status === "over" ? " · se pasaría del presupuesto" : r.status === "under" ? " · quedaría presupuesto sin ejecutar" : " · en ritmo";
      lines.push(["🎯 A este ritmo termina en ", B(pct0(r.projectedPct)), ` (≈ ${money(r.projectedSpend)})${verdict}`]);
    } else {
      lines.push([`⏳ La proyección se muestra desde que hay ${T.minCompleteDaysForProjection} días completos de datos del mes.`]);
    }
    return { icon: ICON[r.status], head: [C(r.c.name), ` · ${platformsOf(r.c)}`], lines };
  });

  const drafts: AlertDraft[] = [];
  rows.forEach((r, i) => {
    if (r.status === "exceeded" || r.status === "over" || r.status === "under") {
      drafts.push(
        draftFrom(items[i], { type: "projection", severity: r.status === "under" ? "warning" : "critical", fingerprint: `projection:${r.c.accountId ?? r.c.key}:${r.status}` })
      );
    }
  });

  const notes: string[] = [`Gasto del mes hasta ayer (${completeDays} día${completeDays === 1 ? "" : "s"} de datos), proyectado a ${daysInPeriod} días.`];
  if (withoutBudget > 0) notes.push(`${withoutBudget} cuenta${withoutBudget === 1 ? "" : "s"} sin presupuesto cargado no se incluye${withoutBudget === 1 ? "" : "n"}.`);

  return built(
    [
      {
        emoji: "📈",
        title: "Proyección a fin de mes",
        note: notes.join(" "),
        items,
        empty: "Ninguna cuenta tiene presupuesto cargado en la hoja de proyectados.",
      },
    ],
    drafts
  );
}

// ----- 2) Falta cargar el presupuesto del mes próximo (última semana del mes)

export function nextMonthBlock(
  sheet: DigestInput["sheet"],
  clients: ClientData[] | null,
  today: number,
  daysInPeriod: number,
  currentKey: string,
  nextKey: string
): Built | null {
  const T = THRESHOLDS;
  if (today < daysInPeriod - (T.nextMonthWindowDays - 1)) return null; // todavía falta para fin de mes
  if (!sheet || sheet.warning || sheet.targets.length === 0) return null; // lo cubre el bloque de la hoja

  const nameOf = (cuenta: string, cliente: string) => clients?.find((c) => normAccountId(c.accountId) === normAccountId(cuenta))?.name ?? (cliente || cuenta);
  const expected = new Map<string, string>(); // cuenta -> nombre
  const hasNext = new Set<string>();
  for (const t of sheet.targets) {
    if (monthMatches(t.mes, currentKey) && t.presupuesto > 0) expected.set(t.cuenta, nameOf(t.cuenta, t.cliente));
    if (monthMatches(t.mes, nextKey)) hasNext.add(t.cuenta);
  }
  if (expected.size === 0) return null;

  const mes = monthName(nextKey);
  const missing = [...expected.entries()].filter(([cuenta]) => !hasNext.has(cuenta));
  const items: Item[] = missing.map(([, name]) => ({
    icon: "⚠️",
    head: [C(name)],
    lines: [[`Tiene presupuesto en ${monthName(currentKey)}, pero no figura en la hoja para ${mes}.`]],
  }));
  const drafts = missing.map(([cuenta], i) => draftFrom(items[i], { type: "next_month", severity: "warning", fingerprint: `next_month:${cuenta}:${nextKey}` }));
  return built(
    [
      {
        emoji: "📅",
        title: `Presupuesto de ${mes}`,
        note: `Última semana del mes: conviene tener ${mes} cargado en la hoja. Si ya está cargado y no aparece, Windsor no sincronizó (Clear Cache).`,
        items,
        empty: `✅ Todas las cuentas con presupuesto en ${monthName(currentKey)} ya tienen ${mes} cargado.`,
      },
    ],
    drafts
  );
}

// ----- 3) Hoja de proyectados desactualizada en Windsor

export function sheetBlock(sheet: DigestInput["sheet"], currentKey: string): Built {
  const action: Rich = ["🛠️ Qué hacer: Windsor → Data Sources → Google Sheets → ", B("Clear Cache"), ", y recargar."];
  const title = "Hoja de proyectados en Windsor";
  const problem = (item: Item, kind: string): Built =>
    built([{ emoji: "🔄", title, items: [item] }], [draftFrom(item, { type: "sheet", severity: "critical", fingerprint: `sheet:${kind}` })]);

  if (!sheet) {
    return problem({ icon: "🔴", head: [B("No se pudo leer la hoja")], lines: [["Windsor no respondió; los presupuestos de este resumen pueden estar incompletos."]] }, "unreadable");
  }
  if (sheet.warning) {
    return problem({ icon: "🔴", head: [B("No se pudo leer la hoja")], lines: [[sheet.warning.slice(0, 220)]] }, "unreadable");
  }
  if (sheet.targets.length === 0) {
    return problem({ icon: "🔴", head: [B("Windsor devolvió la hoja vacía")], lines: [action] }, "empty");
  }
  const current = sheet.targets.filter((t) => monthMatches(t.mes, currentKey));
  if (current.length === 0) {
    const months = [...new Set(sheet.targets.map((t) => t.mes.slice(0, 7)))].filter(Boolean).sort();
    return problem(
      {
        icon: "🔴",
        head: [B(`Windsor no tiene filas de ${monthName(currentKey)}`)],
        lines: [[`Meses que sí tiene: ${months.join(", ") || "ninguno"}. Si el Media Analyst ya cargó ${monthName(currentKey)}, Windsor todavía no sincronizó.`], action],
      },
      `stale:${currentKey}`
    );
  }
  return built([{ emoji: "🔄", title, items: [], empty: `✅ Al día: Windsor tiene ${current.length} fila${current.length === 1 ? "" : "s"} de ${monthName(currentKey)}.` }], []);
}

// ----- 4) Costo por seguidor: 3 mejores y 3 peores (ranking informativo: no genera alertas)

export function costPerFollowerBlocks(groups: AdsByPlatform[]): Built {
  const T = THRESHOLDS;
  const all = groups.flatMap((g) => g.ads.map((ad) => ({ platform: g.platform, ad })));
  const withCost = all
    .filter(({ ad }) => (ad.followers ?? 0) >= T.costPerFollowerMinFollowers && ad.spend > 0)
    .map((x) => ({ ...x, cpf: x.ad.spend / (x.ad.followers as number) }))
    .sort((a, b) => a.cpf - b.cpf);

  const best = withCost.slice(0, T.costPerFollowerListSize);
  const bestKeys = new Set(best.map((x) => `${x.platform}:${x.ad.accountId}:${x.ad.adId}`));
  const worst = [...withCost]
    .reverse()
    .filter((x) => !bestKeys.has(`${x.platform}:${x.ad.accountId}:${x.ad.adId}`))
    .slice(0, T.costPerFollowerListSize);

  const toItem = (x: (typeof withCost)[number], icon: string): Item => ({
    icon,
    head: [C(x.ad.adName)],
    lines: [
      [C(x.ad.campaignName), ` · ${PLATFORM_LABEL[x.platform]}`],
      ["💵 ", B(`${money(x.cpf)} por seguidor`), ` · ${int(x.ad.followers as number)} seguidores · gastó ${money(x.ad.spend)}`],
    ],
  });
  const note = `Seguidores ganados atribuidos al anuncio (Meta y TikTok), con al menos ${T.costPerFollowerMinFollowers}. Menor costo = mejor.`;
  const none = "Ningún anuncio registró seguidores en la ventana (o la métrica no está disponible).";
  return built(
    [
      { emoji: "🏆", title: `Los ${T.costPerFollowerListSize} más baratos por seguidor`, note, items: best.map((x, i) => toItem(x, ["🥇", "🥈", "🥉"][i] ?? "✅")), empty: none },
      { emoji: "💸", title: `Los ${T.costPerFollowerListSize} más caros por seguidor`, items: worst.map((x) => toItem(x, "🔻")), empty: withCost.length === 0 ? none : "No hay suficientes anuncios para armar este ranking." },
    ],
    []
  );
}

// ----- 5) Variación contra la semana anterior (gasto, impresiones, CTR)

interface Agg {
  platform: PlatformKey;
  accountName: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
}
function aggregateByCampaign(groups: AdsByPlatform[]): Map<string, Agg> {
  const m = new Map<string, Agg>();
  for (const g of groups) {
    for (const ad of g.ads) {
      const key = `${g.platform}:${ad.accountId}:${ad.campaignId}`;
      const a = m.get(key) ?? { platform: g.platform, accountName: ad.accountName, campaignName: ad.campaignName, spend: 0, impressions: 0, clicks: 0 };
      a.spend += ad.spend;
      a.impressions += ad.impressions;
      a.clicks += ad.clicks;
      m.set(key, a);
    }
  }
  return m;
}
const ctrOf = (a: { impressions: number; clicks: number }) => (a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0);
const delta = (cur: number, prev: number): number | undefined => (prev > 0 ? ((cur - prev) / prev) * 100 : undefined);

export function weekOverWeekBlock(current: AdsByPlatform[], previous: AdsByPlatform[], windowLabel: string): Built {
  const T = THRESHOLDS;
  const cur = aggregateByCampaign(current);
  const prev = aggregateByCampaign(previous);

  const flagged: Array<{ key: string; cur: Agg; prev: Agg; dSpend?: number; dImp?: number; dCtr?: number; worst: number; hits: Set<string> }> = [];
  for (const [key, c] of cur) {
    const p = prev.get(key);
    if (!p || p.impressions < T.wowMinPrevImpressions) continue;
    const dSpend = delta(c.spend, p.spend);
    const dImp = delta(c.impressions, p.impressions);
    const dCtr = c.impressions >= T.wowCtrMinImpressions ? delta(ctrOf(c), ctrOf(p)) : undefined;
    const hits = new Set<string>();
    if (dSpend !== undefined && Math.abs(dSpend) >= T.wowChangePct) hits.add("spend");
    if (dImp !== undefined && Math.abs(dImp) >= T.wowChangePct) hits.add("imp");
    if (dCtr !== undefined && Math.abs(dCtr) >= T.wowCtrChangePct) hits.add("ctr");
    if (hits.size === 0) continue;
    flagged.push({ key, cur: c, prev: p, dSpend, dImp, dCtr, hits, worst: Math.max(Math.abs(dSpend ?? 0), Math.abs(dImp ?? 0), Math.abs(dCtr ?? 0)) });
  }
  flagged.sort((a, b) => b.worst - a.worst);

  const line = (label: string, d: number | undefined, detail: string, hit: boolean): Rich | null =>
    d === undefined ? null : [trend(d) + " ", hit ? B(`${label} ${signed(d)}`) : `${label} ${signed(d)}`, ` (${detail})`];

  const allItems: Item[] = flagged.map((f) => {
    const lines: Array<Rich | null> = [
      [`${PLATFORM_LABEL[f.cur.platform]} · ${f.cur.accountName}`],
      line("Gasto", f.dSpend, `${money(f.prev.spend)} → ${money(f.cur.spend)}`, f.hits.has("spend")),
      line("Impresiones", f.dImp, `${int(f.prev.impressions)} → ${int(f.cur.impressions)}`, f.hits.has("imp")),
      line("CTR", f.dCtr, `${dec1(ctrOf(f.prev))}% → ${dec1(ctrOf(f.cur))}%`, f.hits.has("ctr")),
    ];
    return { icon: "🔔", head: [C(f.cur.campaignName)], lines: lines.filter((l): l is Rich => l !== null) };
  });
  const drafts = allItems.map((it, i) => draftFrom(it, { type: "week_over_week", severity: "warning", fingerprint: `week_over_week:${flagged[i].key}`, listed: i < T.listSize }));

  return built(
    [
      {
        emoji: "📆",
        title: "Variación contra la semana anterior",
        note: `${windowLabel} contra los 7 días anteriores. Se avisa si el gasto o las impresiones cambian ${T.wowChangePct}% o más, o el CTR ${T.wowCtrChangePct}% o más (campañas con ${int(T.wowMinPrevImpressions)}+ impresiones la semana previa).`,
        items: allItems.slice(0, T.listSize),
        empty: "✅ Ninguna campaña tuvo variaciones grandes contra la semana anterior.",
      },
    ],
    drafts
  );
}

// ----- 6) Frecuencia alta en Meta

export function frequencyBlock(rows: FrequencyRow[] | null, windowLabel: string): Built {
  const T = THRESHOLDS;
  const base = { emoji: "🔁", title: "Frecuencia en Meta" };
  if (!rows) {
    return built([{ ...base, items: [], empty: "⚠️ Sección no disponible en este envío." }], []);
  }
  const eligible = rows.filter((r) => r.impressions >= T.frequencyMinImpressions && r.reach > 0);
  const high = eligible.filter((r) => r.frequency >= T.frequencyHigh).sort((a, b) => b.frequency - a.frequency);
  const top = [...eligible].sort((a, b) => b.frequency - a.frequency)[0];

  const allItems: Item[] = high.map((r) => ({
    icon: "🔥",
    head: [C(r.campaignName)],
    lines: [[`${r.accountName}`], ["🔁 Frecuencia ", B(dec1(r.frequency)), ` · ${int(r.impressions)} impresiones · alcance ${int(r.reach)}`]],
  }));
  const drafts = allItems.map((it, i) => draftFrom(it, { type: "frequency", severity: "warning", fingerprint: `frequency:${high[i].accountId}:${high[i].campaignId}`, listed: i < T.listSize }));
  const topText = top ? ` La más alta es ${dec1(top.frequency)} (${top.campaignName}).` : "";
  return built(
    [
      {
        ...base,
        note: `${windowLabel}. Se avisa desde ${T.frequencyHigh} (cuántas veces vio el anuncio, en promedio, cada persona alcanzada).`,
        items: allItems.slice(0, T.listSize),
        empty: eligible.length === 0 ? "Sin campañas de Meta con volumen suficiente para evaluar." : `✅ Ninguna campaña llega a frecuencia ${T.frequencyHigh}.${topText}`,
      },
    ],
    drafts
  );
}

// ----- 7) CTR muy por debajo del promedio de su campaña

export function ctrBelowCampaignBlock(groups: AdsByPlatform[], windowLabel: string): Built {
  const T = THRESHOLDS;
  const byCampaign = new Map<string, { platform: PlatformKey; ads: AdRow[] }>();
  for (const g of groups) {
    for (const ad of g.ads) {
      const key = `${g.platform}:${ad.accountId}:${ad.campaignId}`;
      const e = byCampaign.get(key) ?? { platform: g.platform, ads: [] };
      e.ads.push(ad);
      byCampaign.set(key, e);
    }
  }

  const flagged: Array<{ platform: PlatformKey; ad: AdRow; campaignCtr: number; gap: number }> = [];
  for (const { platform, ads } of byCampaign.values()) {
    const evaluable = ads.filter((a) => a.impressions >= T.ctrMinImpressions);
    if (evaluable.length < T.ctrMinAdsInCampaign) continue;
    const campaignCtr = ctrOf({ impressions: ads.reduce((s, a) => s + a.impressions, 0), clicks: ads.reduce((s, a) => s + a.clicks, 0) });
    if (campaignCtr <= 0) continue;
    for (const ad of evaluable) {
      if (ad.ctr < campaignCtr * T.ctrBelowCampaignRatio) flagged.push({ platform, ad, campaignCtr, gap: (ad.ctr - campaignCtr) / campaignCtr });
    }
  }
  flagged.sort((a, b) => a.gap - b.gap);

  const allItems: Item[] = flagged.map((f) => ({
    icon: "📉",
    head: [C(f.ad.adName)],
    lines: [
      [C(f.ad.campaignName), ` · ${PLATFORM_LABEL[f.platform]}`],
      ["🖱️ CTR ", B(`${dec1(f.ad.ctr)}%`), ` vs ${dec1(f.campaignCtr)}% de su campaña (${signed(f.gap * 100)})`],
      [`👁️ ${int(f.ad.impressions)} impresiones · gastó ${money(f.ad.spend)}`],
    ],
  }));
  const drafts = allItems.map((it, i) => draftFrom(it, { type: "ctr_below_campaign", severity: "warning", fingerprint: `ctr_below_campaign:${flagged[i].platform}:${flagged[i].ad.adId}`, listed: i < T.listSize }));
  return built(
    [
      {
        emoji: "🖱️",
        title: "CTR muy por debajo del de su campaña",
        note: `${windowLabel}. Anuncios con CTR menor a ${Math.round(T.ctrBelowCampaignRatio * 100)}% del promedio de su campaña (campañas con ${T.ctrMinAdsInCampaign}+ anuncios de ${int(T.ctrMinImpressions)}+ impresiones). Candidatos a pausar o renovar el creativo.`,
        items: allItems.slice(0, T.listSize),
        empty: "✅ Ningún anuncio está muy por debajo del CTR de su campaña.",
      },
    ],
    drafts
  );
}

// ------------------------------------------------------------------ armado

export function buildDigest(input: DigestInput): Digest {
  const { today, daysInPeriod, dateLabel, currentMonthKey, nextMonthKey, clients, sheet, adsCurrent, adsPrevious, frequency, windowLabel, unavailable } = input;

  const projection = projectionBlock(clients, today, daysInPeriod);
  const nextMonth = nextMonthBlock(sheet, clients, today, daysInPeriod, currentMonthKey, nextMonthKey);
  const sheetB = sheetBlock(sheet, currentMonthKey);
  const cpf = costPerFollowerBlocks(adsCurrent);
  const wow = weekOverWeekBlock(adsCurrent, adsPrevious, windowLabel);
  const freq = frequencyBlock(frequency, windowLabel);
  const ctr = ctrBelowCampaignBlock(adsCurrent, windowLabel);

  const meta = input.metaAudit === undefined ? null : metaAuditBlocks(input.metaAudit);

  const sections: Section[] = [
    { emoji: "💰", title: "GASTO CONTRA PROYECTADO", blocks: [...projection.blocks, ...(nextMonth?.blocks ?? []), ...sheetB.blocks] },
    { emoji: "📣", title: "PERFORMANCE DE ANUNCIOS · crecimiento y evolución", blocks: [...cpf.blocks, ...wow.blocks] },
    { emoji: "🎯", title: "PERFORMANCE DE ANUNCIOS · calidad de los anuncios", blocks: [...freq.blocks, ...ctr.blocks] },
    ...(meta ? [{ emoji: "🛡️", title: "REVISIÓN DE CAMPAÑAS · Meta", blocks: meta.blocks }] : []),
  ];

  const counts = {
    proyeccion: projection.alerts,
    mesProximo: nextMonth?.alerts ?? 0,
    hoja: sheetB.alerts,
    semanaAnterior: wow.alerts,
    frecuencia: freq.alerts,
    ctrBajo: ctr.alerts,
    ...(meta ? { revisionMeta: meta.alerts } : {}),
  };
  const alertDrafts = [...projection.drafts, ...(nextMonth?.drafts ?? []), ...sheetB.drafts, ...wow.drafts, ...freq.drafts, ...ctr.drafts, ...(meta?.drafts ?? [])];
  const alerts = alertDrafts.length;

  const subject =
    alerts > 0 ? `Pulso Ignite — ${alerts} alerta${alerts === 1 ? "" : "s"} para revisar (${dateLabel})` : `Pulso Ignite — resumen sin alertas (${dateLabel})`;

  const headerLines = [
    "📊 *PULSO IGNITE — RESUMEN*",
    `🗓️ _${dateLabel}_ · día ${today} de ${daysInPeriod} del mes`,
    alerts > 0 ? `🔔 *${alerts} alerta${alerts === 1 ? "" : "s"}* para revisar` : "✅ *Sin alertas*",
  ];
  if (unavailable.length > 0) {
    headerLines.push("", "⚠️ *Datos que no se pudieron obtener*", ...unavailable.map((u) => `• ${u}`));
  }

  // Google Chat limita el largo de cada mensaje: se arma un mensaje por sección y,
  // si una sección no entra, se reparte por bloques en más mensajes (nunca se
  // corta una lista a la mitad).
  const chatMessages = sections.flatMap((s, i) => packSectionForChat(s, i === 0 ? [...headerLines, ""] : []));

  // ---- Email
  const textHeader = [`PULSO IGNITE — RESUMEN`, `${dateLabel} · día ${today} de ${daysInPeriod} del mes`, alerts > 0 ? `${alerts} alerta(s) para revisar` : "Sin alertas"];
  if (unavailable.length > 0) textHeader.push("", "DATOS QUE NO SE PUDIERON OBTENER:", ...unavailable.map((u) => `- ${u}`));
  const text = [...textHeader, "", ...sections.map(renderSectionText)].join("\n\n");

  const h: string[] = [];
  h.push(`<div style="font-family:Arial,Helvetica,sans-serif;color:#101828;max-width:760px">`);
  h.push(`<h2 style="margin:0 0 4px">📊 Pulso Ignite — resumen</h2>`);
  h.push(`<p style="margin:0 0 8px;color:#475467;font-size:13px">🗓️ ${esc(dateLabel)} · día ${today} de ${daysInPeriod} del mes</p>`);
  h.push(`<p style="margin:0 0 16px;font-size:14px"><strong>${alerts > 0 ? `🔔 ${alerts} alerta${alerts === 1 ? "" : "s"} para revisar` : "✅ Sin alertas"}</strong></p>`);
  if (unavailable.length > 0) {
    h.push(`<div style="background:#fffaeb;border:1px solid #fedf89;padding:10px 12px;border-radius:6px;margin-bottom:16px;font-size:13px">`);
    h.push(`<strong>⚠️ Datos que no se pudieron obtener:</strong><ul style="margin:6px 0 0 18px;padding:0">${unavailable.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></div>`);
  }
  h.push(...sections.map(renderSectionHtml));
  h.push(`<p style="margin-top:28px;font-size:11px;color:#98a2b3">Enviado automáticamente por Pulso Ignite. Datos de Windsor.ai al momento del envío.</p></div>`);

  return { subject, html: h.join(""), text, chatMessages, alertDrafts, summary: { alerts, sections: counts } };
}
