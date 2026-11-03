import { readStoreConfig, redisPipeline, type Cmd, type StoreConfig } from "./redis";
import { resumirCorte, type Corte, type CorteListado, type CorteResumen, type EnvioDeCorte } from "./cortesCore";

/**
 * Almacenamiento de los cortes de finanzas (forma y reglas en lib/cortesCore.ts).
 *
 * Upstash Redis (lib/redis.ts), la misma base del registro de usuarios y de equivalencias:
 *   pulso:cortes          hash  id → JSON del Corte completo
 *   pulso:cortes:resumen  hash  id → JSON del CorteResumen (para la lista, sin bajar cada corte entero)
 *   pulso:cortes:envios   hash  id → JSON del último EnvioDeCorte (el corte en sí no cambia al enviarse)
 *
 * Un corte NO se edita ni se borra desde acá: es una foto. Si hace falta rehacer un
 * período, se genera otro corte y el más nuevo es el vigente (el backend financiero
 * se queda con el más nuevo de cada cuenta y mes).
 *
 * SOLO SERVER-SIDE.
 */

const K = { full: "pulso:cortes", resumen: "pulso:cortes:resumen", envios: "pulso:cortes:envios" };
const STORE = "registro de cortes";
/** El pedido REST de Upstash tiene tope de tamaño; se avisa antes de que falle a medias. */
const MAX_BYTES = 900_000;
export const MAX_LISTA = 100;

export class CortesError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const CORTES_NOT_CONFIGURED = "El registro de cortes no está configurado: falta conectar Upstash Redis (KV_REST_API_URL y KV_REST_API_TOKEN).";

function store(): StoreConfig {
  const cfg = readStoreConfig();
  if (!cfg) throw new CortesError(503, CORTES_NOT_CONFIGURED);
  return cfg;
}
const pipeline = (cmds: Cmd[]) => redisPipeline(store(), cmds, STORE);

function parse<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function saveCorte(corte: Corte): Promise<void> {
  const body = JSON.stringify(corte);
  if (body.length > MAX_BYTES) {
    throw new CortesError(413, "El corte es demasiado grande para guardarlo (demasiadas campañas en el período). Probá con un período más corto.");
  }
  const [created] = await pipeline([["HSETNX", K.full, corte.id, body]]);
  if (!created) throw new CortesError(409, "Ya existe un corte con ese identificador. Probá de nuevo.");
  await pipeline([["HSET", K.resumen, corte.id, JSON.stringify(resumirCorte(corte))]]);
}

/** Guarda el resultado del último envío del corte `id` (el más nuevo reemplaza al anterior). */
export async function saveEnvio(id: string, envio: EnvioDeCorte): Promise<void> {
  await pipeline([["HSET", K.envios, id, JSON.stringify(envio)]]);
}

/** Los más nuevos primero, hasta MAX_LISTA, cada uno con el resultado de su último envío (o null). */
export async function listCortes(): Promise<{ cortes: CorteListado[]; hayMas: boolean }> {
  const [all, envios] = await pipeline([
    ["HGETALL", K.resumen],
    ["HGETALL", K.envios],
  ]);
  const porId = new Map<string, EnvioDeCorte>();
  // HGETALL por REST devuelve [campo, valor, campo, valor, ...].
  for (let i = 0; Array.isArray(envios) && i < envios.length; i += 2) {
    const e = parse<EnvioDeCorte>(envios[i + 1]);
    if (e) porId.set(String(envios[i]), e);
  }
  const cortes: CorteListado[] = [];
  for (let i = 0; Array.isArray(all) && i < all.length; i += 2) {
    const r = parse<CorteResumen>(all[i + 1]);
    if (r) cortes.push({ ...r, envio: porId.get(r.id) ?? null });
  }
  cortes.sort((a, b) => b.generadoEn.localeCompare(a.generadoEn));
  return { cortes: cortes.slice(0, MAX_LISTA), hayMas: cortes.length > MAX_LISTA };
}

export async function getCorte(id: string): Promise<Corte | null> {
  const [raw] = await pipeline([["HGET", K.full, id]]);
  return parse<Corte>(raw);
}
