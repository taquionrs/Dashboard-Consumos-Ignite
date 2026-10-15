/**
 * Único punto de salida hacia connectors.windsor.ai — antes cada lib/windsor*.ts
 * tenía su propio `fetchLayer` copiado, unos con timeout y otros sin.
 *
 * - Timeout de WINDSOR_TIMEOUT_MS por consulta (incluye la lectura del body).
 *   Medido en producción 2026-09-30: Meta y TikTok a nivel anuncio tardan
 *   ~9s, así que el 8s anterior los cortaba a mitad de camino.
 * - Un reintento ante 429 / 5xx / error de red. Un timeout NO se reintenta:
 *   duplicaría la espera sin evidencia de que el segundo intento sea más rápido.
 * - Máximo MAX_CONCURRENT consultas en vuelo por instancia: las capas de cada
 *   plataforma ahora corren en paralelo, esto evita disparar ~25 requests
 *   simultáneos contra Windsor cuando se abre Finanzas.
 *
 * SOLO SERVER-SIDE (usa WINDSOR_API_KEY).
 */

import type { ResolvedDateRange } from "./windsor";

const WINDSOR_BASE_URL = "https://connectors.windsor.ai";

// 50 s: la PRIMERA consulta de una ventana de fechas nueva ("Este mes" cambia de fecha final cada día) tarda a veces
// más de 20 s ("en frío") y las siguientes responden en segundos (medido 2026-10-14: 20 s con error, 8 s, 0,2 s).
// Con 20 s la pantalla mostraba error o plataformas en $0; con 50 s trae los datos, aunque la primera carga sea lenta.
// Las rutas /api tienen maxDuration 90 para dar lugar a consultas encadenadas. El cron de calentamiento
// (/api/cron/calentar) hace esa primera consulta temprano, antes de que entre el equipo.
export const WINDSOR_TIMEOUT_MS = 50000;
const MAX_CONCURRENT = 8;
const RETRY_DELAY_MS = 500;

class WindsorHttpError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(`HTTP ${status} — ${detail}`);
    this.status = status;
  }
}

class WindsorTimeoutError extends Error {
  constructor(ms: number) {
    super(`Timeout de ${Math.round(ms / 1000)}s consultando Windsor.ai`);
  }
}

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  // El lugar se traspasa directo al siguiente en la cola: `active` no baja.
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

async function requestOnce(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WindsorHttpError(res.status, text.slice(0, 300));
    }
    return await res.json();
  } catch (err: any) {
    if (err?.name === "AbortError") throw new WindsorTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof WindsorTimeoutError) return false;
  if (err instanceof WindsorHttpError) return err.status === 429 || err.status >= 500;
  return true; // error de red
}

async function requestWithRetry(url: string, timeoutMs: number): Promise<any> {
  await acquire();
  try {
    try {
      return await requestOnce(url, timeoutMs);
    } catch (err) {
      if (!isRetryable(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return await requestOnce(url, timeoutMs);
    }
  } finally {
    release();
  }
}

/** Una consulta de un connector de Windsor → array de filas. Tira si falla. */
/**
 * `timeoutMs` (opcional) pisa el timeout por defecto. Hace falta en el resumen del
 * cron: cada envío pide ventanas de fechas NUEVAS y Windsor tarda más de 20 s en la
 * primera consulta de una ventana de anuncios de Meta (después la tiene en caché y
 * responde en ~2 s). Medido en producción 2026-10-02.
 */
export async function fetchWindsorRows(connector: string, fields: string, dateFrom: string, dateTo: string, timeoutMs: number = WINDSOR_TIMEOUT_MS): Promise<any[]> {
  const params = new URLSearchParams({ api_key: process.env.WINDSOR_API_KEY!, fields, date_from: dateFrom, date_to: dateTo });
  const json = await requestWithRetry(`${WINDSOR_BASE_URL}/${connector}?${params.toString()}`, timeoutMs);
  const rows = Array.isArray(json) ? json : json?.data;
  if (!Array.isArray(rows)) throw new Error("Respuesta inesperada de Windsor.ai (ni array ni { data: [...] })");
  return rows;
}

/**
 * Opciones de los fetchers de anuncios (lib/windsorAds*.ts).
 * skipDiscovery: no pide la capa de descubrimiento (ventana de >= 12 meses para
 * encontrar anuncios sin actividad en el período, y la miniatura de Google). Es la
 * consulta más lenta, y quien solo necesita los anuncios CON actividad (el resumen
 * diario del cron) no la usa: un anuncio sin impresiones no se marca nunca.
 */
export interface FetchAdsOptions {
  skipDiscovery?: boolean;
  /** Omite la capa de seguidores (Meta/TikTok): para ventanas donde solo importan gasto, impresiones y clicks. */
  skipFollowers?: boolean;
  /** Rango explícito: pisa al preset `rangeKey`. */
  range?: ResolvedDateRange;
  /** Timeout por consulta (ms); por defecto WINDSOR_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Mensaje legible de un resultado rechazado de Promise.allSettled. */
export function reasonMessage(result: PromiseRejectedResult): string {
  return (result.reason as any)?.message || String(result.reason);
}
