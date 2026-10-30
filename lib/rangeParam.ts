import { DATE_RANGE_KEYS, rangeFromDates, resolveDateRange, type DateRangeKey, type RangeInput, type ResolvedDateRange } from "./windsor";

/**
 * Lee el período que piden las pantallas en `?range=...` para las rutas /api/*:
 * - un preset ("7d", "month", ...), o
 * - un rango propio: `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` (ambas fechas inclusive).
 *
 * Un rango propio se valida acá (fechas reales, desde <= hasta, no más de MAX_DAYS días) y la fecha
 * "hasta" se corta en hoy: Windsor no tiene datos del futuro. Si algo está mal, devuelve el motivo
 * para responder 400 en vez de mostrar datos de otro período sin avisar.
 *
 * SOLO SERVER-SIDE (usa la fecha del servidor, igual que resolveDateRange).
 */

export const MAX_CUSTOM_DAYS = 366;

export interface ParsedRange {
  /** Lo que se le pasa a los fetchers (preset o rango ya resuelto). */
  input: RangeInput;
  range: ResolvedDateRange;
  /** Identificador para la clave de caché: distinto por cada período. */
  id: string;
  /** true solo para el preset "month": es el único con el que se comparan filas de la hoja de proyectados. */
  isMonth: boolean;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s: string): boolean {
  if (!ISO.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseRange(request: Request, now: Date = new Date()): ParsedRange | { error: string } {
  return parseRangeParams(new URL(request.url).searchParams, now);
}

/** Lo mismo que parseRange, desde los parámetros ya separados (lo usa también la generación de cortes, que los arma desde un cuerpo JSON). */
export function parseRangeParams(sp: URLSearchParams, now: Date = new Date()): ParsedRange | { error: string } {
  const raw = sp.get("range") || "";

  if (raw === "custom") {
    const from = sp.get("from") || "";
    const to = sp.get("to") || "";
    if (!isRealDate(from) || !isRealDate(to)) return { error: "Rango personalizado inválido: hacen falta las fechas desde y hasta (AAAA-MM-DD)." };
    const today = resolveDateRange("today", now).dateTo;
    if (from > today) return { error: "La fecha desde no puede ser futura." };
    const toClamped = to > today ? today : to;
    if (from > toClamped) return { error: "La fecha desde no puede ser posterior a la fecha hasta." };
    const range = rangeFromDates(from, toClamped);
    if (range.daysInPeriod > MAX_CUSTOM_DAYS) return { error: `El rango personalizado puede tener hasta ${MAX_CUSTOM_DAYS} días.` };
    return { input: range, range, id: `custom:${from}:${toClamped}`, isMonth: false };
  }

  const key: DateRangeKey = (DATE_RANGE_KEYS as string[]).includes(raw) ? (raw as DateRangeKey) : "month";
  return { input: key, range: resolveDateRange(key, now), id: key, isMonth: key === "month" };
}
