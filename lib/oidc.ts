import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthSettings } from "./auth";

/**
 * Lado cliente del login OIDC (Authorization Code + PKCE) contra la aplicación
 * "Access for SaaS" de Pulso en Cloudflare Zero Trust. El ID token se valida
 * con jose: firma RS256 contra las claves públicas de Cloudflare, emisor,
 * audiencia (client id), vencimiento y nonce.
 *
 * Lo usan app/auth/login y app/auth/callback.
 */

interface OidcConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
  /** Cloudflare publica la lista con este nombre (sin "_supported"). */
  token_endpoint_auth_methods?: string[];
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
let discovery: { issuer: string; at: number; config: OidcConfig } | null = null;
let jwks: { url: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;

export class LoginError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function getConfig(issuer: string): Promise<OidcConfig> {
  if (discovery && discovery.issuer === issuer && Date.now() - discovery.at < DISCOVERY_TTL_MS) return discovery.config;
  let config: OidcConfig | null = null;
  try {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (res.ok) config = await res.json();
  } catch {
    config = null;
  }
  if (!config?.authorization_endpoint || !config.token_endpoint || !config.jwks_uri) {
    throw new LoginError(503, "No se pudo leer la configuración OIDC de Cloudflare Access.");
  }
  if (String(config.issuer ?? "").replace(/\/+$/, "") !== issuer) {
    throw new LoginError(500, "El emisor que publica Cloudflare Access no coincide con OIDC_ISSUER.");
  }
  discovery = { issuer, at: Date.now(), config };
  return config;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

/** PKCE (RFC 7636): code_challenge = BASE64URL(SHA-256(code_verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export async function authorizationUrl(settings: AuthSettings, redirectUri: string, p: { state: string; nonce: string; challenge: string }): Promise<string> {
  const config = await getConfig(settings.issuer);
  const url = new URL(config.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", p.state);
  url.searchParams.set("nonce", p.nonce);
  url.searchParams.set("code_challenge", p.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Cambia el código por tokens y devuelve los claims del ID token ya validado. */
export async function exchangeCode(settings: AuthSettings, p: { code: string; redirectUri: string; verifier: string; nonce: string }): Promise<JWTPayload> {
  const config = await getConfig(settings.issuer);
  const body = new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const methods = config.token_endpoint_auth_methods_supported ?? config.token_endpoint_auth_methods;
  if (Array.isArray(methods) && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
    body.set("client_id", settings.clientId);
    body.set("client_secret", settings.clientSecret);
  } else {
    headers.Authorization = "Basic " + btoa(`${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`);
  }

  let idToken: unknown = null;
  try {
    const res = await fetch(config.token_endpoint, { method: "POST", headers, body: body.toString(), cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (res.ok) idToken = (await res.json())?.id_token;
  } catch {
    idToken = null;
  }
  if (typeof idToken !== "string") {
    throw new LoginError(502, "Cloudflare Access no aceptó el código de login. Volvé a entrar a Pulso.");
  }

  if (!jwks || jwks.url !== config.jwks_uri) jwks = { url: config.jwks_uri, set: createRemoteJWKSet(new URL(config.jwks_uri)) };
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(idToken, jwks.set, {
      issuer: settings.issuer,
      audience: settings.clientId,
      algorithms: ["RS256"],
      clockTolerance: 60,
    }));
  } catch {
    throw new LoginError(403, "El token de login no es válido.");
  }
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.nonce !== p.nonce || (auds.length > 1 && claims.azp !== settings.clientId)) {
    throw new LoginError(403, "El token de login no es válido.");
  }
  return claims;
}

/** Origen de Pulso para la URL de vuelta del login: PULSO_PUBLIC_URL o el del pedido. */
export function publicOrigin(requestUrl: string): string {
  const publicUrl = process.env.PULSO_PUBLIC_URL?.trim();
  return new URL(publicUrl || requestUrl).origin;
}

export const callbackUrl = (requestUrl: string) => `${publicOrigin(requestUrl)}/auth/callback`;

/** Solo rutas internas de Pulso como destino después del login: evita redirecciones abiertas. */
export function safeNext(value: string | null): string {
  const base = "https://pulso.invalid";
  try {
    const u = new URL(value && value.startsWith("/") ? value : "/", base);
    if (u.origin !== base || u.pathname.startsWith("/auth/")) return "/";
    return (u.pathname + u.search).slice(0, 500);
  } catch {
    return "/";
  }
}
