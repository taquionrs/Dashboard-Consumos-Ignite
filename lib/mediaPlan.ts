import type { PlatformKey } from "./types";
import { budgetKey, normAccountId } from "./matchKeys";
import { cargarProyectados, currentMonthKey } from "./proyectadoHistorial";

/**
 * Lee los objetivos de inversión (media plan) desde la "Hoja maestra de
 * proyectados - IGNITE" del equipo, vía el conector de Google Sheets de
 * Windsor.ai — mismo mecanismo que el resto de lib/windsor.ts, otra fuente
 * más dentro de Windsor (no una herramienta nueva).
 *
 * ⚠️ ESTADO: el connector "googlesheets" y el hecho de que la primera fila
 * de la hoja se vuelve la lista de campos consultables están confirmados
 * contra la documentación pública de Windsor
 * (windsor.ai/data-field/googlesheets/) — pero no contra una respuesta real
 * de ESTA hoja en particular todavía. Si `targets` viene vacío pese a que la
 * hoja tiene filas, revisar primero que las columnas se llamen EXACTAMENTE
 * como se espera acá (ver abajo) — Windsor usa el nombre de columna tal cual
 * está escrito en la hoja, sin normalizar mayúsculas/acentos.
 *
 * Columnas esperadas en la hoja ("Hoja maestra de proyectados - IGNITE -
 * Consumos en plataformas", ver docs/how-to/conectar-windsor.md):
 *   cliente, plataforma, mes, cuenta, campaña, presupuesto_proyectado
 *
 * - cliente: texto libre (hoy no se cruza contra nada, es solo referencia
 *   humana en la hoja — el cruce real con el dashboard es por "cuenta"
 *   (+ "campaña" si está completa).
 * - plataforma: google | meta | tiktok | linkedin.
 * - mes: "2026-09" o "2026-09-01" — se aceptan ambos formatos.
 * - cuenta: el account_id real tal cual aparece en Windsor.ai (el mismo que
 *   ya se usa como key de las filas reales en fetchWindsorSpend).
 * - campaña / campana (con o sin tilde — ver nota abajo). **Opcional**.
 *   Vacía = presupuesto de CUENTA (como antes). Completa con el nombre
 *   exacto de campaña (tal cual aparece en Windsor / en la tabla de
 *   Campañas de Medios, copiado, no retipeado) = presupuesto específico de
 *   esa campaña. Ver fetchMediaPlanBudgetByCampaign y lib/financeCampaigns.ts.
 *
 *   ⚠️ El nombre de ESTA columna en particular, tal como lo expone el
 *   connector de Windsor, cambió de grafía dos veces en vivo sin que
 *   nosotros tocáramos la hoja: primero pedía "campaña" (con tilde) y
 *   rechazaba "campana" (2026-09-23), después empezó a rechazar "campaña" y
 *   pedir "campana" (2026-09-24) — mismo error HTTP 400 "unknown_field" en
 *   ambos casos, solo invertido. No se pudo determinar la causa exacta
 *   (probablemente algo del lado de Windsor al resincronizar el header de
 *   la hoja), así que en vez de perseguir una sola grafía "correcta",
 *   fetchMediaPlanTargets() prueba las dos (ver CAMPANA_FIELD_CANDIDATES)
 *   y usa la primera que Windsor acepte. La propiedad interna en
 *   `MediaPlanTarget` se sigue llamando `campana` (sin tilde) pase lo que
 *   pase con el nombre real de columna.
 * - presupuesto_proyectado: número plano, sin "$" ni separador de miles.
 *
 * Si una cuenta tiene al menos una fila con "campaña" cargada, el
 * presupuesto de la CUENTA (fetchMediaPlanBudgetByAccount) pasa a ser la
 * SUMA de sus campañas, no la fila de cuenta (si también existe, se
 * ignora) — ver el comentario en esa función.
 *
 * SOLO SERVER-SIDE. No importar desde ningún componente "use client".
 */

const WINDSOR_BASE_URL = "https://connectors.windsor.ai";
const SHEETS_CONNECTOR = "googlesheets";

// Las 2 grafías que la columna de campaña mostró en vivo — ver nota arriba.
// Se prueban en este orden; la primera que Windsor acepte gana.
const CAMPANA_FIELD_CANDIDATES = ["campaña", "campana"] as const;

export interface MediaPlanTarget {
  cliente: string;
  plataforma: PlatformKey;
  mes: string;
  cuenta: string;
  campana: string; // "" = presupuesto de cuenta, sin campaña específica
  presupuesto: number;
}

/** Período para el que se pide el presupuesto: solo hacen falta las fechas (rango ya resuelto). */
export interface BudgetPeriod {
  dateFrom: string;
  dateTo: string;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Meses ("AAAA-MM") cuyo presupuesto mensual corresponde al período elegido.
 * - Sin período: el mes en curso (lo que se hacía antes de poder mirar meses pasados).
 * - Un mes cuenta si el período cubre al menos la mitad de sus días: "Mes anterior" → ese mes; del 15/10 al 15/11 →
 *   octubre y noviembre (se suman los dos presupuestos completos, sin prorratear). Los períodos cortos que cruzan un
 *   cambio de mes (ej. "7 días" el 3/11) no cubren la mitad de ninguno: se usa el mes en el que termina el período.
 */
export function budgetMonthsFor(period?: BudgetPeriod, now: Date = new Date()): string[] {
  if (!period) return [`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`];
  const [fy, fm, fd] = period.dateFrom.split("-").map(Number);
  const [ty, tm, td] = period.dateTo.split("-").map(Number);
  const months: string[] = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
    const len = daysInMonth(y, m);
    const from = y === fy && m === fm ? fd : 1;
    const to = y === ty && m === tm ? td : len;
    if ((to - from + 1) * 2 >= len) months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return months.length ? months : [`${ty}-${String(tm).padStart(2, "0")}`];
}

/** "octubre 2026" para avisos. */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MESES[m - 1]} ${y}`;
}

/** Aviso cuando el proyectado suma más de un mes (si es un solo mes no hace falta decir nada). */
export function multiMonthNote(months: string[]): string | undefined {
  if (months.length < 2) return undefined;
  return `El período abarca ${months.length} meses: el presupuesto proyectado suma los presupuestos mensuales completos de ${months.length === 2 ? `${monthLabel(months[0])} y ${monthLabel(months[1])}` : `${monthLabel(months[0])} a ${monthLabel(months[months.length - 1])}`}.`;
}

/**
 * Filas de la hoja y fotos guardadas (lib/proyectadoHistorial.ts) para los meses pedidos. Un mes que ya pasó y tiene foto se toma
 * de la foto (lo que se proyectó entonces, aunque después se haya editado o borrado en la hoja); el mes en curso, los futuros y los
 * pasados sin foto salen de la hoja. Si la hoja falló pero todos los meses pedidos tienen foto, no hace falta la hoja.
 */
async function targetsFor(months: string[], now: Date): Promise<{ targets: MediaPlanTarget[]; warning?: string }> {
  const actual = currentMonthKey(now);
  const [sheet, snaps] = await Promise.all([fetchMediaPlanTargets(), cargarProyectados(months.filter((m) => m < actual))]);
  if (sheet.warning && months.some((m) => !snaps.has(m))) return { targets: [], warning: sheet.warning };
  const fromSheet = sheet.targets.filter((t) => {
    const m = inMonths(t.mes, months);
    return m !== undefined && !snaps.has(m);
  });
  const fromSnaps = [...snaps.entries()].flatMap(([mes, filas]) => filas.map((f) => ({ ...f, mes })));
  return { targets: [...fromSheet, ...fromSnaps] };
}

/** La hoja acepta "2026-09" y "2026-09-01" como valor de mes. */
function inMonths(mes: string, months: string[]): string | undefined {
  return months.find((m) => mes === m || mes === `${m}-01`);
}

/**
 * Trae todas las filas de la hoja maestra de proyectados, sin filtrar por
 * mes (el llamador decide qué mes le interesa). Nunca tira: cualquier error
 * se atrapa y devuelve una lista vacía + un warning — /api/spend sigue
 * funcionando con "$0 / Sin objetivo cargado" aunque la hoja falle.
 */
export async function fetchMediaPlanTargets(): Promise<{ targets: MediaPlanTarget[]; warning?: string }> {
  if (!process.env.WINDSOR_API_KEY) return { targets: [] };

  try {
    // A diferencia de los demás fetchers de este proyecto (Google/Meta/TikTok
    // Ads), esta consulta no tenía date_from/date_to — verificado en vivo
    // 2026-09-21: sin un rango de fecha, Windsor devuelve 0 filas incluso con
    // la hoja bien conectada y con datos (aunque las filas de la hoja no
    // tengan una noción de fecha propia — Windsor igual filtra por su propio
    // "data_fetched_at"). Se pide un año hacia atrás por las dudas de que el
    // próximo sync no sea inmediato.
    const now = new Date();
    const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const dateParams = {
      date_from: yearAgo.toISOString().slice(0, 10),
      date_to: now.toISOString().slice(0, 10),
    };

    // Probamos las grafías candidatas de la columna de campaña en orden —
    // ver CAMPANA_FIELD_CANDIDATES. Solo pasamos a la siguiente si Windsor
    // rechaza específicamente ESE campo ("unknown_field" mencionándolo);
    // cualquier otro error (API key, hoja no conectada, etc.) corta acá,
    // reintentar con otro nombre de columna no lo va a arreglar.
    let rows: any[] | null = null;
    let campanaField: string = CAMPANA_FIELD_CANDIDATES[0];
    const fieldAttemptErrors: string[] = [];
    for (const field of CAMPANA_FIELD_CANDIDATES) {
      const params = new URLSearchParams({
        api_key: process.env.WINDSOR_API_KEY,
        fields: `cliente,plataforma,mes,cuenta,${field},presupuesto_proyectado`,
        ...dateParams,
      });
      const res = await fetch(`${WINDSOR_BASE_URL}/${SHEETS_CONNECTOR}?${params.toString()}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const json = await res.json();
        const r = Array.isArray(json) ? json : json?.data;
        if (!Array.isArray(r)) {
          throw new Error("Respuesta inesperada de Windsor.ai (hoja de proyectados) — ni array ni { data: [...] }");
        }
        rows = r;
        campanaField = field;
        break;
      }
      const t = await res.text().catch(() => "");
      if (res.status === 400 && /unknown_field/i.test(t) && t.includes(field)) {
        fieldAttemptErrors.push(`campo "${field}": ${t.slice(0, 150)}`);
        continue;
      }
      throw new Error(`HTTP ${res.status} — ${t.slice(0, 200)}`);
    }
    if (rows === null) {
      throw new Error(`Windsor rechazó todas las grafías probadas para la columna de campaña — ${fieldAttemptErrors.join(" | ")}`);
    }

    const targets: MediaPlanTarget[] = rows
      .map((r: any) => ({
        cliente: String(r.cliente ?? "").trim(),
        plataforma: String(r.plataforma ?? "").trim() as PlatformKey,
        mes: String(r.mes ?? "").trim(),
        cuenta: String(r.cuenta ?? "").trim(),
        // Bracket notation porque `campanaField` puede ser "campaña" (con
        // tilde, no válido en dot notation) según cuál haya aceptado Windsor.
        campana: String(r[campanaField] ?? "").trim(),
        presupuesto: Number(r.presupuesto_proyectado ?? 0),
      }))
      .filter((t) => t.cuenta && t.mes);

    // Diagnóstico: la consulta no tiró error, pero no hay ninguna fila
    // utilizable — dos causas bien distintas que sin esto quedan indistinguibles
    // desde afuera (las dos terminan en "$0 / Sin objetivo cargado" en silencio).
    if (targets.length === 0) {
      if (rows.length === 0) {
        return {
          targets: [],
          warning: `Hoja de proyectados (Windsor.ai / Google Sheets): la consulta no devolvió ninguna fila — revisar que el Google Sheet esté conectado como fuente de datos en Windsor.ai (connector "googlesheets").`,
        };
      }
      return {
        targets: [],
        warning: `Hoja de proyectados (Windsor.ai / Google Sheets): se leyeron ${rows.length} fila(s), pero ninguna tenía "cuenta" y "mes" completos — revisar que los encabezados de la hoja sean exactamente cliente/plataforma/mes/cuenta/campaña/presupuesto_proyectado (sin espacios ni mayúsculas distintas).`,
      };
    }

    return { targets };
  } catch (err: any) {
    return {
      targets: [],
      warning: `Hoja de proyectados (Windsor.ai / Google Sheets): falló la consulta, se sigue sin objetivo cargado. Detalle: ${err?.message || err}`,
    };
  }
}

/**
 * Arma un mapa account_id -> presupuesto proyectado, ya filtrado al mes
 * pedido (por defecto, el mes en curso) — lo que necesita
 * fetchWindsorSpend para pisar el budget de una cuenta real.
 *
 * Si la cuenta tiene al menos una fila de presupuesto POR CAMPAÑA (columna
 * "campana" completa) ese mes, el total de la cuenta es la SUMA de esas
 * campañas — la fila de cuenta (sin "campana"), si también existe para el
 * mismo mes, se ignora a propósito: evita mantener dos números que puedan
 * quedar desincronizados (el total "a mano" vs. la suma real de campañas).
 * Sin ninguna fila por campaña, se usa la fila de cuenta como siempre.
 */
export async function fetchMediaPlanBudgetByAccount(
  period?: BudgetPeriod,
  now: Date = new Date()
): Promise<{ byAccount: Map<string, number>; months: string[]; warning?: string }> {
  const months = budgetMonthsFor(period, now);
  const { targets, warning } = await targetsFor(months, now);
  if (warning) return { byAccount: new Map(), months, warning };

  const byAccount = new Map<string, number>();
  for (const month of months) {
    const relevant = targets.filter((t) => inMonths(t.mes, [month]));
    const monthly = new Map<string, number>();
    const accountsWithCampaignBudget = new Set<string>();
    relevant.forEach((t) => {
      const acct = normAccountId(t.cuenta);
      if (t.campana) {
        monthly.set(acct, (monthly.get(acct) ?? 0) + t.presupuesto);
        accountsWithCampaignBudget.add(acct);
      }
    });
    relevant.forEach((t) => {
      const acct = normAccountId(t.cuenta);
      if (!t.campana && !accountsWithCampaignBudget.has(acct)) {
        monthly.set(acct, t.presupuesto);
      }
    });
    monthly.forEach((v, acct) => byAccount.set(acct, (byAccount.get(acct) ?? 0) + v));
  }

  // Hay filas leídas, pero ninguna es de los meses pedidos — la sospecha más
  // probable es que Google Sheets no se sincroniza en vivo en cada request
  // (como el resto de los connectors de Windsor, en el plan Basic es una
  // vez al día): si se acaba de editar la hoja, puede tardar en reflejarse.
  if (byAccount.size === 0) {
    const mesesEncontrados = [...new Set(targets.map((t) => t.mes))].filter(Boolean);
    const esperado = months.map(monthLabel).join(" y ");
    return {
      byAccount,
      months,
      warning: `Hoja de proyectados: se leyeron ${targets.length} fila(s) de Windsor.ai, pero ninguna es del período pedido (se esperaba ${esperado}: "${months.join('", "')}"). Meses encontrados en la hoja: ${mesesEncontrados.join(", ") || "ninguno"}. Si la hoja se editó recién, puede ser que Windsor todavía no resincronizó.`,
    };
  }

  return { byAccount, months };
}

/**
 * Arma un mapa "cuenta:campaña" -> presupuesto proyectado, ya filtrado al
 * mes pedido — lo que necesita lib/financeCampaigns.ts para el desglose
 * por campaña de la vista Finanzas. Solo incluye filas con "campana"
 * completa; las de cuenta (sin campaña) las resuelve
 * fetchMediaPlanBudgetByAccount. No tira warning propio si viene vacío —
 * una campaña sin presupuesto cargado es un caso normal y esperado (se
 * muestra en $0 / "Sin objetivo cargado" en la UI, no es un error).
 */
export async function fetchMediaPlanBudgetByCampaign(
  period?: BudgetPeriod,
  now: Date = new Date()
): Promise<{ byCampaign: Map<string, number>; rows: MediaPlanTarget[]; months: string[]; warning?: string }> {
  const months = budgetMonthsFor(period, now);
  const { targets, warning } = await targetsFor(months, now);
  if (warning) return { byCampaign: new Map(), rows: [], months, warning };

  const byCampaign = new Map<string, number>();
  const rows: MediaPlanTarget[] = [];
  for (const month of months) {
    const monthly = new Map<string, number>();
    targets.forEach((t) => {
      if (t.campana && inMonths(t.mes, [month])) {
        monthly.set(budgetKey(t.cuenta, t.campana), t.presupuesto);
        rows.push(t);
      }
    });
    monthly.forEach((v, k) => byCampaign.set(k, (byCampaign.get(k) ?? 0) + v));
  }

  // `rows`: las filas por campaña del período, para avisar cuáles no cruzaron con ninguna campaña (ver app/api/campaigns).
  return { byCampaign, rows, months };
}
