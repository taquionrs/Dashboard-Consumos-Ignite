/**
 * Cliente mínimo de Upstash Redis vía su API REST (fetch, sin dependencias).
 * Lo comparten el registro de alertas (lib/alertLog.ts) y el de usuarios
 * (lib/users.ts). Corre también en el runtime Edge (middleware.ts).
 *
 * Variables (se aceptan los dos juegos de nombres; Vercel → Storage las agrega solas):
 *   KV_REST_API_URL + KV_REST_API_TOKEN   o   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *
 * Los errores NUNCA incluyen la URL ni el token.
 *
 * SOLO SERVER-SIDE.
 */

export interface StoreConfig {
  url: string;
  token: string;
}

export function readStoreConfig(): StoreConfig | null {
  const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
  const token = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!url || !token || !url.startsWith("https://")) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export type Cmd = Array<string | number>;

/**
 * Ejecuta varios comandos en un solo pedido. `what` nombra el almacenamiento en
 * los mensajes de error ("almacenamiento de alertas", "registro de usuarios").
 */
export async function redisPipeline(cfg: StoreConfig, commands: Cmd[], what: string): Promise<any[]> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
  } catch (err: any) {
    throw new Error(`No se pudo contactar al ${what}: ${String(err?.message || err).slice(0, 150)}`);
  }
  if (!res.ok) throw new Error(`El ${what} respondió HTTP ${res.status}.`);
  const out = await res.json().catch(() => null);
  if (!Array.isArray(out)) throw new Error(`Respuesta inesperada del ${what}.`);
  const failed = out.find((r) => r && r.error);
  if (failed) throw new Error(`${what.charAt(0).toUpperCase()}${what.slice(1)}: ${String(failed.error).slice(0, 150)}`);
  return out.map((r) => r?.result);
}
