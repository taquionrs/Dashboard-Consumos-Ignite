import type { ClientData, PlatformKey } from "./types";
import { fetchMediaPlanBudgetByAccount } from "./mediaPlan";
import { normAccountId } from "./matchKeys";
import { fetchWindsorRows } from "./windsorFetch";

/**
 * Integración con Windsor.ai — API REST (`connectors.windsor.ai`), la capa de
 * ingesta elegida en la Decisión de arquitectura de datos (ver
 * docs/explanation/arquitectura-de-datos.md). Reemplaza en prioridad a
 * lib/googleAds.ts (integración directa a Google Ads API, que queda como
 * fallback si alguna vez hace falta — ver docs/how-to/conectar-google-ads.md).
 *
 * SOLO SERVER-SIDE. No importar este archivo desde ningún componente
 * "use client": expondría la API key en el bundle del navegador.
 *
 * Verificado contra cuentas reales:
 * - **Google Ads** (2026-09-10): connector "google_ads", campos
 *   account_id/account_name/spend/conversions, forma `{ data: [...] }`.
 * - **Meta Ads** (2026-09-10): connector "facebook" (así lo nombra Windsor,
 *   no "meta_ads" ni "facebook_ads") — mismos campos y forma de respuesta.
 * - **TikTok Ads**: connector "tiktok" (confirmado en la documentación
 *   pública de Windsor). Los campos account_id/account_name están
 *   confirmados en el field reference de TikTok — "spend" y "conversions"
 *   NO aparecen ahí con esos nombres exactos (TikTok expone métricas más
 *   nativas), pero sí son parte del esquema "blended" de Windsor que ya
 *   funcionó igual para Google/Meta. Sin verificar todavía contra una
 *   respuesta real: si `spend`/`conversions` vienen vacíos para TikTok pese
 *   a que la cuenta aparece, es la primera sospecha — revisar
 *   windsor.ai/data-field/tiktok/ por el nombre nativo del campo de costo.
 * - El endpoint de cuentas conectadas (onboard.windsor.ai/api/common/ds-accounts)
 *   también quedó verificado con Google Ads: encontró cuentas sin ningún dato
 *   de performance (FRONERI, sin campañas creadas) que los otros dos intentos
 *   no podían ver. Se usa igual para Meta y TikTok, sin verificar todavía
 *   contra una cuenta sin actividad de esas dos — si falla para un connector
 *   puntual, cae al mismo mejor-esfuerzo silencioso que ya tiene cada capa.
 *
 * Descubrimiento de cuentas en 3 capas, por cada plataforma conectada, cada
 * una cubre lo que la anterior no puede: (1) el período elegido en el
 * selector de fecha, con spend/conversiones reales; (2) una ventana ampliada
 * — derivada de ese mismo período pero nunca más angosta que 12 meses, ver
 * `discoveryWindowFor` — para encontrar cuentas dormidas hace tiempo, no
 * solo las que tuvieron actividad reciente; (3) endpoint de cuentas
 * conectadas, para las que nunca tuvieron ni un evento. Las capas 2 y 3
 * solo aportan el nombre — spend/conversiones quedan en 0 si no aparecieron
 * en la capa 1. El número real (capa 1) siempre está 100% atado al período
 * elegido; la ventana de descubrimiento es un concepto aparte, con su
 * propio piso — ver la nota completa en `discoveryWindowFor`.
 *
 * ENFOQUE: no requiere mapear cliente↔cuenta de antemano. Trae **todas** las
 * cuentas de cada plataforma conectada en Windsor.ai (hoy: Google Ads, Meta
 * Ads, TikTok Ads) y las devuelve como filas reales, una por cuenta, usando
 * el nombre real de la cuenta. Si hay al menos una cuenta real, los clientes
 * mock (`baseClients`) se descartan de la vista — ya no aportan una vez que
 * hay datos reales — salvo los que tengan una cuenta real pisándolos
 * explícitamente vía `WINDSOR_<PLATAFORMA>_ACCOUNT_MAP` (mecanismo opcional
 * para cuando ya existe ese mapeo de negocio; ver
 * docs/explanation/estado-y-limitaciones.md). Sin ninguna cuenta real
 * conectada, se sigue mostrando el mock completo — la tabla nunca queda vacía.
 *
 * Próximas plataformas del orden de prioridad (ver specs/003-dashboard-consumos.md
 * en SDD-TAQUION): YouTube, LinkedIn Ads — agregar una entrada más a
 * PLATFORM_SOURCES y (si hace falta mapeo) su propia env var
 * WINDSOR_<PLATAFORMA>_ACCOUNT_MAP.
 *
 * PRESUPUESTO PROYECTADO (media plan): ver lib/mediaPlan.ts — se lee de una
 * hoja de Google Sheets, vía el mismo Windsor.ai (connector "googlesheets",
 * no una herramienta nueva). Sin fila para una cuenta en el mes en curso,
 * esa cuenta sigue en budget 0 / "Sin objetivo cargado" — nunca se inventa.
 *
 * Credenciales (ver .env.example): WINDSOR_API_KEY — la única obligatoria.
 */

const WINDSOR_BASE_URL = "https://connectors.windsor.ai";

export function hasWindsorCredentials(): boolean {
  return Boolean(process.env.WINDSOR_API_KEY);
}

interface PlatformSource {
  platformKey: PlatformKey;
  connector: string;
  label: string;
  accountMapEnvVar: string;
}

const PLATFORM_SOURCES: PlatformSource[] = [
  { platformKey: "google", connector: "google_ads", label: "Google Ads", accountMapEnvVar: "WINDSOR_GOOGLE_ADS_ACCOUNT_MAP" },
  { platformKey: "meta", connector: "facebook", label: "Meta Ads", accountMapEnvVar: "WINDSOR_META_ACCOUNT_MAP" },
  { platformKey: "tiktok", connector: "tiktok", label: "TikTok Ads", accountMapEnvVar: "WINDSOR_TIKTOK_ACCOUNT_MAP" },
];

function parseAccountMap(envVar: string): Record<string, string> {
  const raw = process.env[envVar] || "";
  const map: Record<string, string> = {};
  raw.split(",").forEach((pair) => {
    const [key, accountId] = pair.split(":").map((s) => s.trim());
    if (key && accountId) map[key] = accountId;
  });
  return map;
}

function firstDayOfMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * Los 6 rangos de fecha reales que ofrece el selector del dashboard, más
 * "month" (default). Windsor.ai sincroniza una vez por día en el plan
 * Basic — "today"/"yesterday" pueden no reflejar la sincronización más
 * reciente todavía (ver el aviso en el propio selector de fecha).
 */
export type DateRangeKey = "today" | "yesterday" | "7d" | "14d" | "28d" | "month" | "lastmonth";
export const DATE_RANGE_KEYS: DateRangeKey[] = ["today", "yesterday", "7d", "14d", "28d", "month", "lastmonth"];

/** Lo que reciben los fetchers: un preset del selector o un rango ya resuelto (rango personalizado, ver lib/rangeParam.ts). */
export type RangeInput = DateRangeKey | ResolvedDateRange;

export interface ResolvedDateRange {
  dateFrom: string;
  dateTo: string;
  /** "Día actual" dentro del período elegido — para el cálculo de pacing. */
  today: number;
  /** Largo total del período elegido — para el cálculo de pacing. */
  daysInPeriod: number;
}

/**
 * Traduce un preset del selector de fecha a un rango concreto de
 * date_from/date_to para pedirle a Windsor.ai, más "today"/"daysInPeriod"
 * para que el cálculo de pacing (spend8 / budget vs. tiempo transcurrido)
 * siga teniendo sentido fuera de "este mes": para una ventana fija (hoy,
 * ayer, últimos N días, mes anterior) el período ya está 100% transcurrido
 * — today = daysInPeriod.
 */
export function resolveDateRange(input: RangeInput, now: Date = new Date()): ResolvedDateRange {
  if (typeof input !== "string") return input; // rango ya resuelto (personalizado)
  const key = input;
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (key) {
    case "today":
      return { dateFrom: toISODate(today0), dateTo: toISODate(today0), today: 1, daysInPeriod: 1 };
    case "yesterday": {
      const y = addDays(today0, -1);
      return { dateFrom: toISODate(y), dateTo: toISODate(y), today: 1, daysInPeriod: 1 };
    }
    case "7d":
      return { dateFrom: toISODate(addDays(today0, -6)), dateTo: toISODate(today0), today: 7, daysInPeriod: 7 };
    case "14d":
      return { dateFrom: toISODate(addDays(today0, -13)), dateTo: toISODate(today0), today: 14, daysInPeriod: 14 };
    case "28d":
      return { dateFrom: toISODate(addDays(today0, -27)), dateTo: toISODate(today0), today: 28, daysInPeriod: 28 };
    case "lastmonth": {
      const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastOfPrevMonth = addDays(firstOfThisMonth, -1);
      const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);
      const days = lastOfPrevMonth.getDate();
      return { dateFrom: toISODate(firstOfPrevMonth), dateTo: toISODate(lastOfPrevMonth), today: days, daysInPeriod: days };
    }
    case "month":
    default: {
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      return { dateFrom: firstDayOfMonth(now), dateTo: toISODate(today0), today: now.getDate(), daysInPeriod: daysInMonth };
    }
  }
}

/**
 * Rango explícito entre dos fechas (YYYY-MM-DD, ambas inclusive) — para ventanas
 * que no son un preset del selector, como las semanas completas del resumen
 * (los presets "7d"/"14d" incluyen el día de hoy, que todavía está incompleto).
 */
export function rangeFromDates(dateFrom: string, dateTo: string): ResolvedDateRange {
  const days = Math.round((parseISODate(dateTo).getTime() - parseISODate(dateFrom).getTime()) / 86400000) + 1;
  return { dateFrom, dateTo, today: days, daysInPeriod: days };
}

function parseISODate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Ventana de "descubrimiento" (para encontrar cuentas/campañas/anuncios
 * pausados o sin actividad en el rango elegido, que Windsor omitiría en
 * silencio en vez de devolver en $0) — derivada del rango elegido en el
 * selector de período (el doble de días del período, terminando en el
 * mismo `dateTo`), pero **nunca más angosta que 12 meses**.
 *
 * Corrección 2026-09-22: antes cada fetcher tenía su propia ventana
 * hardcodeada, independiente del filtro de período — se cambió a que
 * dependiera solo del período elegido. Corrección 2026-09-23: eso rompió
 * el descubrimiento real — con "Este mes" la ventana quedaba en ~2 meses,
 * demasiado angosta para encontrar campañas pausadas hace más tiempo (caso
 * real: las campañas de Google Ads de TQN-LC, pausadas desde antes de esa
 * ventana, dejaron de aparecer). El número real (Capa 1, lo que se
 * muestra) sigue 100% atado al período elegido — eso nunca cambió y está
 * bien así. La ventana de DESCUBRIMIENTO es un concepto distinto: "cuánto
 * atrás hay que mirar para saber si una cuenta/campaña/anuncio existe",
 * que no tiene relación natural con qué período se está mirando ahora —
 * por eso el piso de 12 meses (ya probado que alcanza) en vez de un
 * multiplicador puro del período.
 */
export function discoveryWindowFor(range: ResolvedDateRange): { dateFrom: string; dateTo: string } {
  const from = parseISODate(range.dateFrom);
  const periodDoubled = new Date(from.getFullYear(), from.getMonth(), from.getDate() - range.daysInPeriod);
  const dateTo = parseISODate(range.dateTo);
  const twelveMonthsBack = new Date(dateTo.getFullYear() - 1, dateTo.getMonth(), dateTo.getDate());
  const widest = periodDoubled.getTime() < twelveMonthsBack.getTime() ? periodDoubled : twelveMonthsBack;
  return { dateFrom: toISODate(widest), dateTo: range.dateTo };
}

interface AccountTotals {
  accountId: string;
  accountName: string;
  spend: number;
  conversions: number;
}

// Timeout, reintento y límite de concurrencia: ver lib/windsorFetch.ts.
function fetchRows(connector: string, dateFrom: string, dateTo: string, fields: string): Promise<any[]> {
  return fetchWindsorRows(connector, fields, dateFrom, dateTo);
}

/**
 * Descubre las cuentas conectadas de UNA plataforma (un connector de
 * Windsor.ai) en 3 capas — ver la nota del archivo. Nunca tira: cualquier
 * falla en cualquier capa se empuja a `warnings` y sigue con lo que ya tenga.
 */
async function discoverPlatformAccounts(
  source: PlatformSource,
  warnings: string[],
  metricRange: ResolvedDateRange
): Promise<Map<string, AccountTotals>> {
  const { connector, label } = source;
  const discovery = discoveryWindowFor(metricRange);

  const byAccount = new Map<string, AccountTotals>();

  // Las 3 capas son independientes: se piden en paralelo (el tiempo total es
  // el de la más lenta, no la suma) y después se aplican en el mismo orden de
  // siempre — la capa 1 tiene prioridad sobre el nombre/total de una cuenta.
  // El .catch vacío solo evita un unhandledRejection mientras se espera a otra
  // capa; cada `await` de abajo sigue tirando el error normalmente.
  const rangeP = fetchRows(connector, metricRange.dateFrom, metricRange.dateTo, "account_id,account_name,date,spend,conversions");
  const historyP = fetchRows(connector, discovery.dateFrom, discovery.dateTo, "account_id,account_name");
  const accountsP = fetch(
    `https://onboard.windsor.ai/api/common/ds-accounts?datasource=${connector}&api_key=${process.env.WINDSOR_API_KEY}`,
    { cache: "no-store", signal: AbortSignal.timeout(15000) }
  );
  for (const p of [rangeP, historyP, accountsP]) p.catch(() => {});

  // Capa 1: el rango elegido en el selector de fecha (por defecto, mes en
  // curso), spend y conversiones reales.
  let rangeRows: any[] = [];
  try {
    rangeRows = await rangeP;
    for (const row of rangeRows) {
      const accountId = String(row.account_id ?? "");
      if (!accountId) continue;
      const accountName = String(row.account_name ?? accountId);
      const prev = byAccount.get(accountId) || { accountId, accountName, spend: 0, conversions: 0 };
      prev.spend += Number(row.spend ?? 0);
      prev.conversions += Number(row.conversions ?? 0);
      byAccount.set(accountId, prev);
    }
  } catch (err: any) {
    warnings.push(`Windsor.ai (${label}): falló la consulta del rango de fecha elegido. Detalle: ${err?.message || err}`);
  }

  // Capa 2: ventana de descubrimiento derivada del período elegido (ver
  // discoveryWindowFor) — para cuentas sin actividad en ese período (Windsor
  // no manda una fila con spend "0", omite la cuenta directamente).
  try {
    const historyRows = await historyP;
    for (const row of historyRows) {
      const accountId = String(row.account_id ?? "");
      if (!accountId || byAccount.has(accountId)) continue;
      byAccount.set(accountId, { accountId, accountName: String(row.account_name ?? accountId), spend: 0, conversions: 0 });
    }
  } catch (err: any) {
    warnings.push(`Windsor.ai (${label}): no se pudo consultar el histórico ampliado (${discovery.dateFrom} → ${discovery.dateTo}). Detalle: ${err?.message || err}`);
  }

  // Capa 3: endpoint de cuentas conectadas (metadata, no datos de campaña) —
  // para cuentas que nunca tuvieron ni un solo evento.
  try {
    const res = await accountsP;
    if (res.ok) {
      const json = await res.json();
      const list = Array.isArray(json) ? json : json?.data ?? json?.accounts;
      if (Array.isArray(list)) {
        for (const acc of list) {
          const accountId = String(acc.account_id ?? acc.id ?? "");
          if (!accountId || byAccount.has(accountId)) continue;
          byAccount.set(accountId, { accountId, accountName: String(acc.account_name ?? acc.name ?? accountId), spend: 0, conversions: 0 });
        }
      } else {
        warnings.push(`Windsor.ai (${label}): el endpoint de cuentas conectadas respondió con una forma inesperada.`);
      }
    } else {
      warnings.push(`Windsor.ai (${label}): el endpoint de cuentas conectadas devolvió HTTP ${res.status}.`);
    }
  } catch (err: any) {
    warnings.push(`Windsor.ai (${label}): no se pudo consultar el endpoint de cuentas conectadas. Detalle: ${err?.message || err}`);
  }

  if (byAccount.size === 0) {
    warnings.push(`Windsor.ai (${label}): no se encontró ninguna cuenta conectada con datos en la ventana de descubrimiento del período elegido.`);
  }

  return byAccount;
}

/**
 * Trae el gasto real de **todas** las cuentas conectadas en Windsor.ai, para
 * cada plataforma en `PLATFORM_SOURCES` (hoy: Google Ads, Meta Ads). Cada
 * cuenta real se agrega como una fila propia — sin necesidad de mapeo
 * previo. Si el mapeo opcional por plataforma (`WINDSOR_<PLATAFORMA>_ACCOUNT_MAP`)
 * tiene una entrada que apunta a esa cuenta, en cambio, el spend se aplica al
 * cliente mock correspondiente (pisa su valor) en vez de crear una fila nueva.
 *
 * `metricRange` fija el período real que se le pide a Windsor (por defecto,
 * mes en curso) — ver `resolveDateRange`. El descubrimiento de cuentas sin
 * actividad en ese período (capa 2 de `discoverPlatformAccounts`) usa una
 * ventana ampliada pero SIEMPRE derivada del mismo `metricRange` (ver
 * `discoveryWindowFor`) — nunca una constante fija de fecha; la capa 3
 * (endpoint de cuentas conectadas) es metadata sin fecha, no le aplica esto.
 */
export async function fetchWindsorSpend(
  baseClients: ClientData[],
  metricRange: ResolvedDateRange = resolveDateRange("month")
): Promise<{ clients: ClientData[]; warnings: string[] }> {
  const warnings: string[] = [];

  // Presupuesto proyectado (media plan) por cuenta, del mes en curso — sale
  // de la hoja maestra de proyectados vía el connector "googlesheets" de
  // Windsor (ver lib/mediaPlan.ts). Se pide una sola vez, no por plataforma:
  // la hoja mezcla las 3 en las mismas filas.
  const [{ byAccount: budgetByAccount, warning: mediaPlanWarning }, ...discovered] = await Promise.all([
    fetchMediaPlanBudgetByAccount(),
    ...PLATFORM_SOURCES.map((source) => discoverPlatformAccounts(source, warnings, metricRange)),
  ]);
  if (mediaPlanWarning) warnings.push(mediaPlanWarning);

  const usedByMock = new Set<string>(); // "platformKey:accountId" ya aplicado a un mock client
  let updatedMockClients: ClientData[] = baseClients;
  const allRealClients: ClientData[] = [];

  for (const [i, source] of PLATFORM_SOURCES.entries()) {
    const byAccount = discovered[i];
    const accountMap = parseAccountMap(source.accountMapEnvVar);

    updatedMockClients = updatedMockClients.map((c) => {
      const accountId = accountMap[c.key];
      if (!accountId || !byAccount.has(accountId)) return c;
      usedByMock.add(`${source.platformKey}:${accountId}`);

      const totals = byAccount.get(accountId)!;
      const prevCpl = c.cpl[source.platformKey];
      return {
        ...c,
        spend8: c.spend8 + totals.spend, // se acumula: un mock client puede tener overrides de varias plataformas
        cpl: {
          ...c.cpl,
          [source.platformKey]: {
            ...prevCpl,
            target: prevCpl?.target ?? 0,
            real: totals.conversions > 0 ? totals.spend / totals.conversions : 0,
          },
        },
      };
    });

    // Todas las cuentas reales que NO tienen mapeo explícito a un cliente
    // mock se agregan como filas propias.
    [...byAccount.values()]
      .filter((t) => !usedByMock.has(`${source.platformKey}:${t.accountId}`))
      .forEach((t) =>
        allRealClients.push({
          key: `windsor-${source.platformKey}-${t.accountId}`,
          name: t.accountName,
          accountId: t.accountId,
          vertical: `Cuenta real (Windsor.ai — ${source.label})`,
          // Si la hoja de proyectados tiene un presupuesto para esta cuenta
          // este mes, se usa; si no, sigue en $0 (no se inventa un objetivo).
          budget: budgetByAccount.get(normAccountId(t.accountId)) ?? 0,
          spend8: t.spend,
          mix: { [source.platformKey]: 100 } as Partial<Record<PlatformKey, number>>,
          // El CPL objetivo (distinto del presupuesto) todavía no se carga
          // desde la hoja — se muestra el gasto total de la cuenta, que es
          // lo que coincide directo con lo que se ve en la plataforma.
          cpl: { [source.platformKey]: { target: 0, real: t.spend, label: "Gasto" } } as ClientData["cpl"],
          health: [],
        })
      );
  }

  // Con cuentas reales conectadas, los clientes ficticios de referencia ya
  // no aportan nada — a pedido del usuario, se sacan de la vista. Solo se
  // conservan los mock clients que tienen alguna cuenta real pisándolos
  // explícitamente. Sin ninguna cuenta real (Windsor sin cuentas conectadas
  // en ninguna plataforma, o todas las consultas fallaron), se sigue
  // mostrando el mock completo — nunca una tabla vacía.
  if (allRealClients.length === 0 && usedByMock.size === 0) {
    // Con warnings, Windsor falló (no es que no haya cuentas conectadas):
    // devolver el mock acá mostraba clientes ficticios marcados como reales.
    // Se tira para que la ruta sirva el último dato bueno o un error claro.
    if (warnings.length > 0) {
      throw new Error(`No se pudo obtener ninguna cuenta desde Windsor.ai. ${warnings.slice(0, 3).join(" | ")}`);
    }
    return { clients: baseClients, warnings };
  }
  const overriddenMockClients = updatedMockClients.filter((c) =>
    PLATFORM_SOURCES.some((s) => usedByMock.has(`${s.platformKey}:${parseAccountMap(s.accountMapEnvVar)[c.key]}`))
  );
  return { clients: [...overriddenMockClients, ...allRealClients], warnings };
}

export interface PlatformTotals {
  platformKey: PlatformKey;
  label: string;
  spend: number;
  conversions: number;
  cpl: number;
  /** Cuántas cuentas se encontraron para esta plataforma (activas o no) — si es 0, no hay nada real que mostrar todavía. */
  accountCount: number;
}

/**
 * Agrega el gasto/conversiones de cada plataforma conectada — para la vista
 * Medios ("Comparación entre plataformas"). Reutiliza el mismo descubrimiento
 * de cuentas de `fetchWindsorSpend` (Google/Meta/TikTok ya conectados), así
 * que sale real desde el día uno: no hace falta un fetcher nuevo por
 * plataforma, esto ya se prueba a nivel cuenta en la vista Finanzas.
 */
export async function fetchPlatformComparison(
  metricRange: ResolvedDateRange = resolveDateRange("month")
): Promise<{ platforms: PlatformTotals[]; warnings: string[] }> {
  const warnings: string[] = [];
  const platforms: PlatformTotals[] = [];

  const discovered = await Promise.all(PLATFORM_SOURCES.map((source) => discoverPlatformAccounts(source, warnings, metricRange)));
  for (const [i, source] of PLATFORM_SOURCES.entries()) {
    const byAccount = discovered[i];
    let spend = 0;
    let conversions = 0;
    for (const acc of byAccount.values()) {
      spend += acc.spend;
      conversions += acc.conversions;
    }
    platforms.push({
      platformKey: source.platformKey,
      label: source.label,
      spend,
      conversions,
      cpl: conversions > 0 ? spend / conversions : 0,
      accountCount: byAccount.size,
    });
  }

  if (platforms.every((p) => p.accountCount === 0) && warnings.length > 0) {
    throw new Error(`No se pudo obtener ninguna cuenta desde Windsor.ai. ${warnings.slice(0, 3).join(" | ")}`);
  }

  return { platforms, warnings };
}
