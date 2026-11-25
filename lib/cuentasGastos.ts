import { randomUUID } from "crypto";
import { normalizeEmail } from "./auth";
import { readStoreConfig, redisPipeline, type Cmd, type StoreConfig } from "./redis";
import { CuentasError, CUENTAS_NOT_CONFIGURED } from "./cuentas";
import type { GastoManual } from "./cuentasCore";

/**
 * Gastos fuera de las plataformas (UGC, envíos, shooting...) de la vista Cuentas.
 * Reglas y validación en lib/cuentasCore.ts.
 *
 * Upstash Redis (lib/redis.ts):
 *   pulso:cuentas:gastos        hash  id → JSON de GastoManual
 *   pulso:cuentas:gastos:audit  lista de GastoAudit (más nuevas primero, se guardan MAX_AUDIT)
 *
 * Cada alta, cambio y baja queda en la auditoría (quién, cuándo, qué).
 *
 * SOLO SERVER-SIDE.
 */

const K = { map: "pulso:cuentas:gastos", audit: "pulso:cuentas:gastos:audit" };
const MAX_AUDIT = 200;
const STORE = "registro de gastos de Cuentas";
const ID = /^[0-9a-f-]{36}$/;

export interface GastoAudit {
  at: string;
  by: string;
  action: "alta" | "cambio" | "baja";
  id: string;
  detalle: string;
  monto: number;
}

export const esIdDeGasto = (id: unknown): id is string => typeof id === "string" && ID.test(id);

function store(): StoreConfig {
  const cfg = readStoreConfig();
  if (!cfg) throw new CuentasError(503, CUENTAS_NOT_CONFIGURED);
  return cfg;
}
const pipeline = (cmds: Cmd[]) => redisPipeline(store(), cmds, STORE);

function parse(raw: unknown): GastoManual | null {
  if (typeof raw !== "string") return null;
  try {
    const g = JSON.parse(raw);
    return g && typeof g.id === "string" && typeof g.monto === "number" && typeof g.fecha === "string" ? (g as GastoManual) : null;
  } catch {
    return null;
  }
}

/** Todos los gastos, del más nuevo al más viejo. Vacío si Redis no está configurado. */
export async function listGastos(): Promise<GastoManual[]> {
  if (!readStoreConfig()) return [];
  const [all] = await pipeline([["HGETALL", K.map]]);
  const out: GastoManual[] = [];
  // HGETALL por REST devuelve [campo, valor, campo, valor, ...].
  for (let i = 0; Array.isArray(all) && i < all.length; i += 2) {
    const g = parse(all[i + 1]);
    if (g) out.push(g);
  }
  return out.sort((a, b) => b.fecha.localeCompare(a.fecha) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

const auditCmds = (e: GastoAudit): Cmd[] => [
  ["LPUSH", K.audit, JSON.stringify(e)],
  ["LTRIM", K.audit, 0, MAX_AUDIT - 1],
];

/** Alta (sin `id`) o cambio (con `id` de un gasto que existe). */
export async function saveGasto(value: Omit<GastoManual, "id" | "updatedAt" | "updatedBy">, actor: string, id?: string): Promise<GastoManual> {
  let action: GastoAudit["action"] = "alta";
  if (id !== undefined) {
    const [raw] = await pipeline([["HGET", K.map, id]]);
    if (!parse(raw)) throw new CuentasError(404, "Ese gasto no existe.");
    action = "cambio";
  }
  const now = new Date().toISOString();
  const by = normalizeEmail(actor);
  const gasto: GastoManual = { ...value, id: id ?? randomUUID(), updatedAt: now, updatedBy: by };
  await pipeline([["HSET", K.map, gasto.id, JSON.stringify(gasto)], ...auditCmds({ at: now, by, action, id: gasto.id, detalle: gasto.detalle, monto: gasto.monto })]);
  return gasto;
}

/** Baja. false si no existía. */
export async function removeGasto(id: string, actor: string): Promise<boolean> {
  const [raw] = await pipeline([["HGET", K.map, id]]);
  const prev = parse(raw);
  if (!prev) return false;
  await pipeline([["HDEL", K.map, id], ...auditCmds({ at: new Date().toISOString(), by: normalizeEmail(actor), action: "baja", id, detalle: prev.detalle, monto: prev.monto })]);
  return true;
}
