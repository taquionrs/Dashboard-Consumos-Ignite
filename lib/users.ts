import { fixedAdmins, isAllowedEmail, normalizeEmail, PAGE_KEYS, allowedDomains, type Access, type PageKey } from "./auth";
import { readStoreConfig, redisPipeline, type Cmd, type StoreConfig } from "./redis";

/**
 * Registro de usuarios de Pulso: quién entra y a qué páginas. Lo administran
 * los administradores desde /usuarios; Cloudflare solo decide quién puede
 * iniciar sesión (cuentas @taquion.com.ar).
 *
 * Reglas:
 * - Los administradores fijos (ADMIN_EMAILS) ven todo y no se pueden quitar ni
 *   cambiar desde la pantalla: así nunca se pierde el acceso de administración.
 * - Nadie puede cambiar ni quitar su propio acceso.
 * - Cada alta, cambio y baja queda en la auditoría (quién, cuándo, qué).
 *
 * Almacenamiento: Upstash Redis (lib/redis.ts), el mismo del registro de alertas.
 *   pulso:users         hash  email → JSON de UserRecord
 *   pulso:users:audit   lista de AuditEntry (más nuevas primero, se guardan MAX_AUDIT)
 *
 * Corre también en el runtime Edge (middleware.ts → resolveAccess).
 */

const K = { users: "pulso:users", audit: "pulso:users:audit" };
const MAX_AUDIT = 200;
const STORE = "registro de usuarios";

export interface UserRecord extends Access {
  email: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface AuditEntry {
  at: string;
  by: string;
  action: "alta" | "cambio" | "baja";
  email: string;
  pages?: PageKey[];
  admin?: boolean;
}

export class UsersError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const USERS_NOT_CONFIGURED =
  "El registro de usuarios no está configurado: falta conectar Upstash Redis (KV_REST_API_URL y KV_REST_API_TOKEN).";

function store(): StoreConfig {
  const cfg = readStoreConfig();
  if (!cfg) throw new UsersError(503, USERS_NOT_CONFIGURED);
  return cfg;
}
const pipeline = (cmds: Cmd[]) => redisPipeline(store(), cmds, STORE);

const sortPages = (pages: PageKey[]) => PAGE_KEYS.filter((k) => pages.includes(k));

function parseRecord(raw: unknown): UserRecord | null {
  if (typeof raw !== "string") return null;
  try {
    const r = JSON.parse(raw);
    if (!r || typeof r.email !== "string") return null;
    return { ...r, pages: sortPages(Array.isArray(r.pages) ? r.pages : []), admin: r.admin === true };
  } catch {
    return null;
  }
}

// Permisos por email: evita una consulta a Redis en cada pedido (imágenes,
// datos). Un alta, cambio o baja rige como mucho ACCESS_CACHE_MS después.
const ACCESS_CACHE_MS = 10 * 1000;
const accessCache = new Map<string, { access: Access | null; until: number }>();

/** Permisos de `email`, o null si no figura en el registro. */
export async function resolveAccess(rawEmail: string): Promise<Access | null> {
  const email = normalizeEmail(rawEmail);
  if (fixedAdmins().includes(email)) return { pages: PAGE_KEYS, admin: true };

  const hit = accessCache.get(email);
  if (hit && hit.until > Date.now()) return hit.access;
  const [raw] = await pipeline([["HGET", K.users, email]]);
  const rec = parseRecord(raw);
  const access = rec && (rec.pages.length > 0 || rec.admin) ? { pages: rec.pages, admin: rec.admin } : null;
  if (accessCache.size > 500) accessCache.clear();
  accessCache.set(email, { access, until: Date.now() + ACCESS_CACHE_MS });
  return access;
}

export async function listUsers(): Promise<{ users: UserRecord[]; audit: AuditEntry[] }> {
  const [all, audit] = await pipeline([
    ["HGETALL", K.users],
    ["LRANGE", K.audit, 0, MAX_AUDIT - 1],
  ]);
  const users: UserRecord[] = [];
  // HGETALL por REST devuelve [campo, valor, campo, valor, ...].
  for (let i = 0; Array.isArray(all) && i < all.length; i += 2) {
    const rec = parseRecord(all[i + 1]);
    if (rec) users.push(rec);
  }
  users.sort((a, b) => a.email.localeCompare(b.email));
  const entries = (Array.isArray(audit) ? audit : []).map((raw) => {
    try {
      return JSON.parse(raw) as AuditEntry;
    } catch {
      return null;
    }
  });
  return { users, audit: entries.filter((e): e is AuditEntry => e !== null) };
}

export interface UserInput extends Access {
  email: string;
}

/** Valida el cuerpo de un alta o cambio. */
export function validateUserInput(body: unknown): { ok: true; value: UserInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Cuerpo inválido." };
  const b = body as Record<string, unknown>;
  const email = normalizeEmail(b.email);
  if (!isAllowedEmail(email)) {
    return { ok: false, error: `El email tiene que ser una cuenta de ${allowedDomains().map((d) => "@" + d).join(" o ")}.` };
  }
  if (!Array.isArray(b.pages) || b.pages.some((p) => !(PAGE_KEYS as unknown[]).includes(p))) {
    return { ok: false, error: "Páginas inválidas." };
  }
  if (typeof b.admin !== "boolean") return { ok: false, error: "Indicá si es administrador." };
  const pages = sortPages(b.pages as PageKey[]);
  if (pages.length === 0 && !b.admin) return { ok: false, error: "Elegí al menos una página (o marcalo como administrador)." };
  return { ok: true, value: { email, pages, admin: b.admin } };
}

function assertEditable(email: string, actor: string) {
  if (fixedAdmins().includes(email)) {
    throw new UsersError(403, "Es un administrador fijo (ADMIN_EMAILS): no se puede cambiar ni quitar desde Pulso.");
  }
  if (email === normalizeEmail(actor)) throw new UsersError(403, "No podés cambiar ni quitar tu propio acceso. Pedíselo a otro administrador.");
}

const auditCmds = (entry: AuditEntry): Cmd[] => [
  ["LPUSH", K.audit, JSON.stringify(entry)],
  ["LTRIM", K.audit, 0, MAX_AUDIT - 1],
];

/** Alta o cambio. */
export async function saveUser(input: UserInput, actor: string): Promise<UserRecord> {
  assertEditable(input.email, actor);
  const [raw] = await pipeline([["HGET", K.users, input.email]]);
  const prev = parseRecord(raw);
  const now = new Date().toISOString();
  const by = normalizeEmail(actor);
  const rec: UserRecord = {
    email: input.email,
    pages: input.pages,
    admin: input.admin,
    createdAt: prev?.createdAt ?? now,
    createdBy: prev?.createdBy ?? by,
    updatedAt: now,
    updatedBy: by,
  };
  await pipeline([
    ["HSET", K.users, input.email, JSON.stringify(rec)],
    ...auditCmds({ at: now, by, action: prev ? "cambio" : "alta", email: input.email, pages: rec.pages, admin: rec.admin }),
  ]);
  accessCache.delete(input.email);
  return rec;
}

/** Baja. false si no existía. */
export async function removeUser(rawEmail: string, actor: string): Promise<boolean> {
  const email = normalizeEmail(rawEmail);
  assertEditable(email, actor);
  const [removed] = await pipeline([["HDEL", K.users, email]]);
  if (!removed) return false;
  await pipeline(auditCmds({ at: new Date().toISOString(), by: normalizeEmail(actor), action: "baja", email }));
  accessCache.delete(email);
  return true;
}
