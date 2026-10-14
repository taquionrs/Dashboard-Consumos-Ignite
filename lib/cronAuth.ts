import { timingSafeEqual } from "crypto";

/**
 * Autorización de las rutas de cron (las únicas que el login con SSO deja pasar, ver CRON_PATHS en
 * lib/access.ts): exigen `Authorization: Bearer <CRON_SECRET>`, que Vercel agrega solo al invocar el cron
 * cuando la variable existe. Sin CRON_SECRET la ruta queda cerrada: nunca se abre por omisión.
 */
export function cronAuthorized(request: Request): boolean | "unconfigured" {
  const secret = process.env.CRON_SECRET;
  if (!secret) return "unconfigured";
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
