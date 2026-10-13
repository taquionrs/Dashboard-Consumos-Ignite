import { jwtVerify, SignJWT } from "jose";
import { NextResponse } from "next/server";
import { PAGE_KEYS, type PageKey, type Session } from "./access";

export * from "./access";

/**
 * Login con SSO y permisos de Pulso. Corre en el runtime Edge (middleware.ts),
 * así que acá no se importa nada de Node.
 *
 * - QUIÉN puede iniciar sesión lo decide Cloudflare Zero Trust: Pulso es una
 *   aplicación "Access for SaaS" (OIDC) cuya política deja pasar las cuentas
 *   @taquion.com.ar. El login (Authorization Code + PKCE) está en lib/oidc.ts y
 *   app/auth/*; al volver, Pulso emite su propia cookie de sesión firmada.
 * - QUÉ puede ver cada persona lo decide el registro de usuarios de Pulso
 *   (lib/users.ts), que los administradores manejan en /usuarios: página por
 *   página. Quien pasa el login pero no está en el registro no ve nada.
 *
 * Mismo esquema que el Tablero de Seguimiento Táctico (repo tablero-frigor).
 * Paso a paso de la configuración: docs/how-to/configurar-sso-cloudflare.md.
 */

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export interface AuthSettings {
  /** https://<equipo>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id> */
  issuer: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  sessionHours: number;
  /** Cierra también la sesión de Cloudflare Access. */
  logoutUrl: string;
}

export const splitList = (v: string | undefined) =>
  (v ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** null = falta configuración (en producción no entra nadie: ver middleware.ts). */
export function readAuthSettings(): AuthSettings | null {
  const issuer = (process.env.OIDC_ISSUER ?? "").trim().replace(/\/+$/, "");
  const clientId = (process.env.OIDC_CLIENT_ID ?? "").trim();
  const clientSecret = process.env.OIDC_CLIENT_SECRET ?? "";
  const sessionSecret = process.env.SESSION_SECRET ?? "";
  if (!/^https:\/\/[^/]+\/.+/.test(issuer) || !clientId || !clientSecret || sessionSecret.length < 32) return null;
  const hours = parseInt(process.env.SESSION_HOURS ?? "", 10);
  return {
    issuer,
    clientId,
    clientSecret,
    sessionSecret,
    sessionHours: Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 24) : 12,
    logoutUrl: new URL(issuer).origin + "/cdn-cgi/access/logout",
  };
}

export const AUTH_NOT_CONFIGURED =
  "El login (Cloudflare Access) no está configurado en este entorno: faltan OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET o SESSION_SECRET (32+ caracteres).";

/** Dominios de las cuentas que pueden entrar (los mismos que deja pasar la política de Cloudflare). */
export function allowedDomains(): string[] {
  const list = splitList(process.env.ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, ""));
  return list.length ? list : ["taquion.com.ar"];
}

/** Administradores fijos: no se pueden quitar ni cambiar desde /usuarios. Ven todas las páginas. */
export function fixedAdmins(): string[] {
  return splitList(process.env.ADMIN_EMAILS).filter(isValidEmail);
}

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export const normalizeEmail = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
export const isValidEmail = (email: string) => email.length <= 254 && EMAIL_RE.test(email);
export const isAllowedEmail = (email: string) => isValidEmail(email) && allowedDomains().includes(email.slice(email.lastIndexOf("@") + 1));

// ---------------------------------------------------------------------------
// Cookies firmadas (sesión y login en curso)
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "pulso_session";
export const LOGIN_COOKIE = "pulso_login";
export const LOGIN_TTL_S = 10 * 60;

const key = (secret: string) => new TextEncoder().encode(secret);

/** Firma (HS256) un payload que vence en `ttlSeconds`. El contenido no es secreto, pero no se puede alterar. */
export async function signCookie(payload: Record<string, unknown>, secret: string, ttlSeconds: number): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(key(secret));
}

/** El payload si la firma es válida y no venció; si no, null. */
export async function verifyCookie<T>(token: string | undefined, secret: string): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
    return payload as T;
  } catch {
    return null;
  }
}

export const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});

// ---------------------------------------------------------------------------
// Desarrollo local
// ---------------------------------------------------------------------------

/**
 * Desarrollo local (`next dev`, sin la configuración de OIDC): se entra como
 * PULSO_DEV_EMAIL con las páginas de PULSO_DEV_PAGES (por omisión todas, y
 * admin). Nunca en producción (Vercel, Netlify y `next start` corren con
 * NODE_ENV=production): ahí, sin configuración, no entra nadie.
 */
export function devSession(): Session | null {
  if (process.env.NODE_ENV === "production") return null;
  const raw = process.env.PULSO_DEV_PAGES;
  const pages = raw === undefined ? PAGE_KEYS : splitList(raw).filter((p): p is PageKey => (PAGE_KEYS as string[]).includes(p));
  return {
    email: normalizeEmail(process.env.PULSO_DEV_EMAIL) || "dev@taquion.com.ar",
    pages,
    admin: raw === undefined || splitList(raw).includes("admin"),
  };
}

// ---------------------------------------------------------------------------
// Avisos en HTML (sin React: el pedido no llegó a la app)
// ---------------------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function htmlPage(status: number, title: string, detail: string, links: { href: string; label: string }[] = []): NextResponse {
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Pulso</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#1f2933;line-height:1.5}
h1{font-size:20px}p{color:#52606d}a{color:#1f6feb;margin-right:16px}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
${links.length ? `<p>${links.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join("")}</p>` : ""}
</body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
