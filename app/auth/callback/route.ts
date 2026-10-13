import { NextResponse, type NextRequest } from "next/server";
import {
  allowedDomains,
  AUTH_NOT_CONFIGURED,
  cookieOptions,
  htmlPage,
  isAllowedEmail,
  LOGIN_COOKIE,
  normalizeEmail,
  readAuthSettings,
  SESSION_COOKIE,
  signCookie,
  verifyCookie,
} from "@/lib/auth";
import { callbackUrl, exchangeCode, LoginError } from "@/lib/oidc";

export const dynamic = "force-dynamic";

interface LoginTx {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
}

/**
 * GET /auth/callback?code&state → vuelta del login de Cloudflare Access.
 * Valida state, cambia el código por el ID token (lib/oidc.ts) y emite la
 * cookie de sesión de Pulso. Qué páginas ve la persona lo decide después el
 * registro de usuarios (middleware.ts): sin alta, ve el aviso "sin acceso".
 */
export async function GET(request: NextRequest) {
  const settings = readAuthSettings();
  if (!settings) return htmlPage(503, "Pulso no está disponible", AUTH_NOT_CONFIGURED);

  const fail = (status: number, detail: string, logout = false) => {
    const res = htmlPage(status, "No se pudo iniciar sesión", detail, [
      { href: "/auth/login", label: "Volver a ingresar" },
      ...(logout ? [{ href: "/auth/logout", label: "Cerrar sesión y entrar con otra cuenta" }] : []),
    ]);
    res.cookies.set(LOGIN_COOKIE, "", cookieOptions(0));
    return res;
  };

  const params = request.nextUrl.searchParams;
  const providerError = params.get("error");
  if (providerError) return fail(403, `Cloudflare Access no autorizó el ingreso (${providerError.slice(0, 60)}).`, true);

  const tx = await verifyCookie<LoginTx>(request.cookies.get(LOGIN_COOKIE)?.value, settings.sessionSecret);
  const state = params.get("state");
  const code = params.get("code");
  if (!tx || !state || state !== tx.state || !code) {
    return fail(400, "El intento de ingreso venció o no es válido. Volvé a entrar a Pulso.");
  }

  let claims;
  try {
    claims = await exchangeCode(settings, { code, redirectUri: callbackUrl(request.url), verifier: tx.verifier, nonce: tx.nonce });
  } catch (err: any) {
    return fail(err instanceof LoginError ? err.status : 502, String(err?.message || err));
  }

  const email = normalizeEmail(claims.email);
  if (!email || claims.email_verified === false) return fail(403, "Cloudflare Access no informó un email verificado.", true);
  if (!isAllowedEmail(email)) {
    return fail(403, `Solo pueden entrar cuentas ${allowedDomains().map((d) => "@" + d).join(" o ")}.`, true);
  }

  const maxAge = settings.sessionHours * 3600;
  const res = NextResponse.redirect(new URL(tx.next || "/", request.url));
  res.cookies.set(SESSION_COOKIE, await signCookie({ email }, settings.sessionSecret, maxAge), cookieOptions(maxAge));
  res.cookies.set(LOGIN_COOKIE, "", cookieOptions(0));
  return res;
}
