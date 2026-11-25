import { normalizeEmail } from "./auth";
import { readStoreConfig, redisPipeline, type Cmd, type StoreConfig } from "./redis";
import type { PresupuestoAnual } from "./cuentasCore";

/**
 * Almacenamiento del presupuesto del año por línea (vista Cuentas; reglas en lib/cuentasCore.ts).
 *
 * Upstash Redis (lib/redis.ts), la misma base de usuarios, alertas y equivalencias:
 *   pulso:cuentas:presupuesto        JSON de PresupuestoAnual (un solo documento)
 *   pulso:cuentas:presupuesto:audit  lista de CuentasAudit (más nuevas primero, se guardan MAX_AUDIT)
 *
 * Cada cambio queda en la auditoría: quién, cuándo y cuánto sumaba el total antes y después.
 *
 * SOLO SERVER-SIDE.
 */

const K = { doc: "pulso:cuentas:presupuesto", audit: "pulso:cuentas:presupuesto:audit" };
const MAX_AUDIT = 100;
const STORE = "registro del presupuesto de Cuentas";

export interface CuentasAudit {
  at: string;
  by: string;
  lineas: number;
  totalAntes: number | null;
  totalDespues: number;
}

export class CuentasError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const CUENTAS_NOT_CONFIGURED =
  "El presupuesto de Cuentas no se puede guardar: falta conectar Upstash Redis (KV_REST_API_URL y KV_REST_API_TOKEN).";

function store(): StoreConfig {
  const cfg = readStoreConfig();
  if (!cfg) throw new CuentasError(503, CUENTAS_NOT_CONFIGURED);
  return cfg;
}
const pipeline = (cmds: Cmd[]) => redisPipeline(store(), cmds, STORE);

const total = (p: PresupuestoAnual | null) => (p ? p.lineas.reduce((s, l) => s + l.monto, 0) : null);

function parse(raw: unknown): PresupuestoAnual | null {
  if (typeof raw !== "string") return null;
  try {
    const p = JSON.parse(raw);
    return p && typeof p.inicio === "string" && Array.isArray(p.lineas) ? (p as PresupuestoAnual) : null;
  } catch {
    return null;
  }
}

/** null si todavía no se cargó nada (o si Redis no está configurado: ver readStoreConfig). */
export async function getPresupuesto(): Promise<PresupuestoAnual | null> {
  if (!readStoreConfig()) return null;
  const [raw] = await pipeline([["GET", K.doc]]);
  return parse(raw);
}

export async function savePresupuesto(value: Pick<PresupuestoAnual, "inicio" | "lineas">, actor: string): Promise<PresupuestoAnual> {
  const [raw] = await pipeline([["GET", K.doc]]);
  const prev = parse(raw);
  const now = new Date().toISOString();
  const by = normalizeEmail(actor);
  const doc: PresupuestoAnual = { ...value, updatedAt: now, updatedBy: by };
  const entry: CuentasAudit = { at: now, by, lineas: doc.lineas.length, totalAntes: total(prev), totalDespues: total(doc) ?? 0 };
  await pipeline([
    ["SET", K.doc, JSON.stringify(doc)],
    ["LPUSH", K.audit, JSON.stringify(entry)],
    ["LTRIM", K.audit, 0, MAX_AUDIT - 1],
  ]);
  return doc;
}

export async function listAudit(): Promise<CuentasAudit[]> {
  if (!readStoreConfig()) return [];
  const [rows] = await pipeline([["LRANGE", K.audit, 0, MAX_AUDIT - 1]]);
  return (Array.isArray(rows) ? rows : []).flatMap((r) => {
    try {
      return [JSON.parse(r) as CuentasAudit];
    } catch {
      return [];
    }
  });
}
