import { parseMaestro, type MaestroData } from "./maestroCore";

/**
 * Lectura del Maestro de Superlum: la lista de clientes y proyectos contra la
 * que se vinculan las cuentas publicitarias (lib/equivalencias.ts).
 *
 * Variables:
 *   MAESTRO_TOKEN  token de lectura que da Superlum. ES UNA CREDENCIAL: solo en el hosting.
 *   MAESTRO_URL    opcional; por omisión https://superlum.netlify.app/api/integrations/maestro
 *
 * El token nunca aparece en un mensaje de error.
 *
 * SOLO SERVER-SIDE.
 */

const DEFAULT_URL = "https://superlum.netlify.app/api/integrations/maestro";

export const MAESTRO_NOT_CONFIGURED = "Falta la variable de entorno MAESTRO_TOKEN: sin ella Pulso no puede leer los clientes y proyectos de Superlum.";

export function readMaestroConfig(): { url: string; token: string } | null {
  const token = (process.env.MAESTRO_TOKEN || "").trim();
  const url = (process.env.MAESTRO_URL || DEFAULT_URL).trim();
  if (!token || !url.startsWith("https://")) return null;
  return { url, token };
}

export async function fetchMaestro(): Promise<{ data: MaestroData | null; warning?: string }> {
  const cfg = readMaestroConfig();
  if (!cfg) return { data: null, warning: MAESTRO_NOT_CONFIGURED };
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
  } catch (err: any) {
    return { data: null, warning: `No se pudo contactar a Superlum: ${String(err?.message || err).slice(0, 150)}` };
  }
  if (res.status === 401) return { data: null, warning: "Superlum rechazó el token (MAESTRO_TOKEN no es el correcto o se rotó)." };
  if (res.status === 503) return { data: null, warning: "Superlum tiene la integración con el Maestro deshabilitada." };
  if (res.status === 429) return { data: null, warning: "Superlum recibió demasiados pedidos seguidos: probá de nuevo en un minuto." };
  if (!res.ok) return { data: null, warning: `Superlum respondió HTTP ${res.status}.` };
  const data = parseMaestro(await res.json().catch(() => null));
  if (!data) return { data: null, warning: "La respuesta de Superlum no tiene la forma esperada (clientes y proyectos)." };
  return { data };
}
