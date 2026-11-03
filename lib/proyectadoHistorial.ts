import { readStoreConfig, redisPipeline } from "./redis";
import type { MediaPlanTarget } from "./mediaPlan";

/**
 * Historial del presupuesto proyectado por mes.
 *
 * La hoja de proyectados (Google Sheets, vía Windsor) solo dice lo que el equipo tiene cargado HOY: si al cargar un mes nuevo
 * se pisan o borran las filas del anterior, ese dato se pierde. Acá se guarda una foto de cada mes en Upstash Redis
 * (lib/redis.ts): el cron diario (app/api/cron/calentar) la actualiza mientras el mes está en curso (o es futuro) y, cuando el mes
 * ya pasó, queda congelada — no se vuelve a escribir (SET ... NX), aunque después alguien edite la hoja.
 * Al pedir un mes pasado, lib/mediaPlan.ts usa esta foto en vez de la hoja.
 *
 * Una clave por mes: `pulso:proyectado:AAAA-MM`. Los errores nunca incluyen la URL ni el token.
 *
 * SOLO SERVER-SIDE.
 */

const STORE = "almacenamiento del historial de proyectados";
const keyOf = (mes: string) => `pulso:proyectado:${mes}`;

export interface ProyectadoSnapshot {
  mes: string;
  guardadoEl: string;
  filas: MediaPlanTarget[];
}

/** "2026-10" y "2026-10-01" (los dos formatos que acepta la hoja) → "2026-10"; cualquier otra cosa → null. */
export function monthKeyOf(mes: string): string | null {
  const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(mes.trim());
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]}` : null;
}

export function currentMonthKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export interface GuardadoResult {
  configured: boolean;
  /** Meses escritos (en curso/futuros: se pisan en cada corrida; pasados: solo si no tenían foto). */
  guardados: string[];
  /** Meses pasados que ya tenían foto y se dejaron intactos. */
  congelados: string[];
}

/**
 * Guarda una foto por cada mes que tenga filas en `targets`. Una lectura vacía de la hoja no borra nada (no hay filas →
 * no se escribe ese mes). Tira si el almacenamiento falla (el cron lo informa).
 */
export async function guardarProyectados(targets: MediaPlanTarget[], now: Date = new Date()): Promise<GuardadoResult> {
  const cfg = readStoreConfig();
  if (!cfg) return { configured: false, guardados: [], congelados: [] };

  const porMes = new Map<string, MediaPlanTarget[]>();
  for (const t of targets) {
    const mes = monthKeyOf(t.mes);
    if (!mes) continue;
    porMes.set(mes, [...(porMes.get(mes) ?? []), { ...t, mes }]);
  }
  const actual = currentMonthKey(now);
  const meses = [...porMes.keys()].sort();
  if (meses.length === 0) return { configured: true, guardados: [], congelados: [] };

  const guardadoEl = now.toISOString();
  const cmds = meses.map((mes) => {
    const snap: ProyectadoSnapshot = { mes, guardadoEl, filas: porMes.get(mes)! };
    return mes < actual ? ["SET", keyOf(mes), JSON.stringify(snap), "NX"] : ["SET", keyOf(mes), JSON.stringify(snap)];
  });
  const out = await redisPipeline(cfg, cmds, STORE);
  const guardados: string[] = [];
  const congelados: string[] = [];
  meses.forEach((mes, i) => (out[i] === null && mes < actual ? congelados : guardados).push(mes));
  return { configured: true, guardados, congelados };
}

/** Fotos guardadas de esos meses. Nunca tira: sin almacenamiento o con error, devuelve un mapa vacío (se usa la hoja). */
export async function cargarProyectados(meses: string[]): Promise<Map<string, MediaPlanTarget[]>> {
  const out = new Map<string, MediaPlanTarget[]>();
  const cfg = readStoreConfig();
  if (!cfg || meses.length === 0) return out;
  try {
    const res = await redisPipeline(cfg, meses.map((m) => ["GET", keyOf(m)]), STORE);
    meses.forEach((mes, i) => {
      if (typeof res[i] !== "string") return;
      try {
        const snap = JSON.parse(res[i]) as ProyectadoSnapshot;
        if (Array.isArray(snap?.filas)) out.set(mes, snap.filas);
      } catch {
        // foto ilegible: se ignora y se usa la hoja
      }
    });
  } catch {
    // almacenamiento caído: la hoja sigue funcionando
  }
  return out;
}
