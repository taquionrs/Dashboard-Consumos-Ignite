import { normalizeEmail } from "./auth";
import { normAccountId } from "./matchKeys";
import { readStoreConfig, redisPipeline, type Cmd, type StoreConfig } from "./redis";
import type { Equivalencia } from "./equivalenciasCore";

/**
 * Almacenamiento de las equivalencias cuenta publicitaria → cliente/proyecto de
 * Superlum (reglas y validación en lib/equivalenciasCore.ts).
 *
 * Upstash Redis (lib/redis.ts), la misma base del registro de usuarios y de alertas:
 *   pulso:equivalencias        hash  accountId (solo dígitos) → JSON de Equivalencia
 *   pulso:equivalencias:audit  lista de AuditEntry (más nuevas primero, se guardan MAX_AUDIT)
 *
 * Cada alta, cambio y baja queda en la auditoría (quién, cuándo, qué).
 *
 * SOLO SERVER-SIDE.
 */

const K = { map: "pulso:equivalencias", audit: "pulso:equivalencias:audit" };
const MAX_AUDIT = 200;
const STORE = "registro de equivalencias";

export interface EquivalenciaAudit {
  at: string;
  by: string;
  action: "alta" | "cambio" | "baja";
  accountId: string;
  clienteNombre?: string;
  proyectoNombre?: string | null;
}

export class EquivalenciasError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const EQUIVALENCIAS_NOT_CONFIGURED =
  "El registro de equivalencias no está configurado: falta conectar Upstash Redis (KV_REST_API_URL y KV_REST_API_TOKEN).";

function store(): StoreConfig {
  const cfg = readStoreConfig();
  if (!cfg) throw new EquivalenciasError(503, EQUIVALENCIAS_NOT_CONFIGURED);
  return cfg;
}
const pipeline = (cmds: Cmd[]) => redisPipeline(store(), cmds, STORE);

function parseRecord(raw: unknown): Equivalencia | null {
  if (typeof raw !== "string") return null;
  try {
    const r = JSON.parse(raw);
    if (!r || typeof r.accountId !== "string" || typeof r.clienteId !== "string") return null;
    return r as Equivalencia;
  } catch {
    return null;
  }
}

export async function listEquivalencias(): Promise<{ equivalencias: Equivalencia[]; audit: EquivalenciaAudit[] }> {
  const [all, audit] = await pipeline([
    ["HGETALL", K.map],
    ["LRANGE", K.audit, 0, MAX_AUDIT - 1],
  ]);
  const equivalencias: Equivalencia[] = [];
  // HGETALL por REST devuelve [campo, valor, campo, valor, ...].
  for (let i = 0; Array.isArray(all) && i < all.length; i += 2) {
    const rec = parseRecord(all[i + 1]);
    if (rec) equivalencias.push(rec);
  }
  equivalencias.sort((a, b) => a.clienteNombre.localeCompare(b.clienteNombre, "es") || a.accountId.localeCompare(b.accountId));
  const entries = (Array.isArray(audit) ? audit : []).map((raw) => {
    try {
      return JSON.parse(raw) as EquivalenciaAudit;
    } catch {
      return null;
    }
  });
  return { equivalencias, audit: entries.filter((e): e is EquivalenciaAudit => e !== null) };
}

const auditCmds = (entry: EquivalenciaAudit): Cmd[] => [
  ["LPUSH", K.audit, JSON.stringify(entry)],
  ["LTRIM", K.audit, 0, MAX_AUDIT - 1],
];

/** Alta o cambio. Una cuenta tiene un solo cliente: vincularla de nuevo reemplaza la anterior. */
export async function saveEquivalencia(
  value: Pick<Equivalencia, "accountId" | "clienteId" | "clienteNombre" | "proyectoId" | "proyectoNombre">,
  actor: string
): Promise<Equivalencia> {
  const [raw] = await pipeline([["HGET", K.map, value.accountId]]);
  const prev = parseRecord(raw);
  const now = new Date().toISOString();
  const by = normalizeEmail(actor);
  const rec: Equivalencia = { ...value, updatedAt: now, updatedBy: by };
  await pipeline([
    ["HSET", K.map, value.accountId, JSON.stringify(rec)],
    ...auditCmds({ at: now, by, action: prev ? "cambio" : "alta", accountId: value.accountId, clienteNombre: value.clienteNombre, proyectoNombre: value.proyectoNombre }),
  ]);
  return rec;
}

/** Baja. false si no existía. */
export async function removeEquivalencia(rawAccountId: string, actor: string): Promise<boolean> {
  const accountId = normAccountId(rawAccountId);
  if (!accountId) return false;
  const [removed] = await pipeline([["HDEL", K.map, accountId]]);
  if (!removed) return false;
  await pipeline(auditCmds({ at: new Date().toISOString(), by: normalizeEmail(actor), action: "baja", accountId }));
  return true;
}
