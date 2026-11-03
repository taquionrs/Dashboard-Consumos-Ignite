import { createHmac } from "crypto";
import type { Corte, EnvioDeCorte } from "./cortesCore";

/**
 * Envío de un corte a Superlum (que lo valida y lo reenvía al backend financiero). El contrato
 * completo está en `docs/integracion-pulso-cortes.md` del repo superlum-prod.
 *
 *   POST <SUPERLUM_PULSO_URL>
 *   x-pulso-signature: sha256=<HMAC-SHA256 del cuerpo EXACTO, con PULSO_SHARED_SECRET>
 *   { "evento": "corte.pulso", "enviadoEl": "<ahora>", "corte": { …el corte guardado… } }
 *
 * La firma se calcula sobre el texto exacto que viaja: se arma el cuerpo una sola vez y se manda
 * ese mismo texto. Superlum rechaza un pedido cuyo `enviadoEl` tenga más de 10 minutos, así que la
 * hora se pone al enviar, nunca al generar el corte.
 *
 * Aquí viven la firma y la lectura de la respuesta (puras, con `crypto` de Node); la ruta que
 * llama está en app/api/cortes/[id]/enviar/route.ts. SOLO SERVER-SIDE.
 */

export const SUPERLUM_PULSO_URL_POR_DEFECTO = "https://superlum.netlify.app/api/integrations/pulso/corte";
/** Mismo mínimo que exige Superlum: uno más corto se rechaza allá con 503. */
export const SECRETO_MINIMO = 32;

/** El secreto compartido, si está cargado y es largo. Es una credencial: nunca se loguea ni se devuelve. */
export function leerSecreto(env: Record<string, string | undefined> = process.env): string | null {
  const s = (env.PULSO_SHARED_SECRET ?? "").trim();
  return s.length >= SECRETO_MINIMO ? s : null;
}

/** La dirección de Superlum, o null si la configurada no es https. */
export function urlDeSuperlum(env: Record<string, string | undefined> = process.env): string | null {
  const u = (env.SUPERLUM_PULSO_URL ?? SUPERLUM_PULSO_URL_POR_DEFECTO).trim();
  return u.startsWith("https://") ? u : null;
}

/** El cuerpo exacto del pedido. La hora entra por parámetro para poder probarlo. */
export function armarCuerpo(corte: Corte, ahora: Date): string {
  return JSON.stringify({ evento: "corte.pulso", enviadoEl: ahora.toISOString(), corte });
}

/** `sha256=<hex>` del cuerpo, igual que `firmaDe` de Superlum. */
export function firmar(secreto: string, cuerpo: string): string {
  return `sha256=${createHmac("sha256", secreto).update(cuerpo, "utf8").digest("hex")}`;
}

type Resumen = Omit<EnvioDeCorte, "enviadoEn" | "enviadoPor">;

const MENSAJE_POR_ESTADO: Record<number, string> = {
  401: "Superlum rechazó la firma: el secreto de Pulso y el de Superlum no coinciden.",
  503: "La integración con Pulso no está habilitada en Superlum (falta cargar el secreto allá) o el backend financiero no está disponible.",
  413: "El corte es demasiado grande para enviarlo.",
  429: "Superlum recibió demasiados pedidos seguidos: probá de nuevo en un minuto.",
};

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Lee la respuesta de Superlum: `{ ok: true, data: {…} }` si salió bien, `{ ok: false, error: { message } }`
 * si no. Un cuerpo ilegible no se interpreta como éxito. `ok` es true solo si el estado es 2xx y Superlum
 * dice que el backend aceptó el corte.
 */
export function resumirRespuesta(status: number, body: unknown): Resumen {
  const raiz = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = raiz.data && typeof raiz.data === "object" ? (raiz.data as Record<string, unknown>) : null;
  const error = raiz.error && typeof raiz.error === "object" ? (raiz.error as Record<string, unknown>) : null;

  if (status >= 200 && status < 300 && data && data.ok === true) {
    const omitidas = Array.isArray(data.omitidas)
      ? data.omitidas
          .map((o) => (o && typeof o === "object" ? { cuenta_id: texto((o as Record<string, unknown>).cuenta_id), motivo: texto((o as Record<string, unknown>).motivo) } : null))
          .filter((o): o is { cuenta_id: string; motivo: string } => o !== null && o.cuenta_id !== null && o.motivo !== null)
      : [];
    return {
      ok: true,
      status,
      mensaje: texto(data.mensaje) ?? "Superlum recibió el corte.",
      aplicadas: typeof data.aplicadas === "number" ? data.aplicadas : null,
      omitidas,
      advertencias: Array.isArray(data.advertencias) ? data.advertencias.filter((a): a is string => typeof a === "string") : [],
      reemplaza: texto(data.reemplaza),
    };
  }

  return {
    ok: false,
    status,
    mensaje: texto(error?.message) ?? MENSAJE_POR_ESTADO[status] ?? `Superlum respondió HTTP ${status} sin un motivo legible.`,
    aplicadas: null,
    omitidas: [],
    advertencias: [],
    reemplaza: null,
  };
}

/** El envío que no llegó a obtener respuesta (red caída, tiempo agotado). */
export function envioSinRespuesta(motivo: string): Resumen {
  return { ok: false, status: null, mensaje: `No se pudo contactar a Superlum: ${motivo.slice(0, 150)}`, aplicadas: null, omitidas: [], advertencias: [], reemplaza: null };
}
