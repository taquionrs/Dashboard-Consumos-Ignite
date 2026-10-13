import { NextResponse, type NextRequest } from "next/server";
import { AUTH_NOT_CONFIGURED, cookieOptions, htmlPage, LOGIN_COOKIE, LOGIN_TTL_S, readAuthSettings, signCookie } from "@/lib/auth";
import { authorizationUrl, callbackUrl, LoginError, pkceChallenge, randomToken, safeNext } from "@/lib/oidc";

export const dynamic = "force-dynamic";

/**
 * GET /auth/login?next=/ruta → redirige al login de Cloudflare Access (OIDC +
 * PKCE). state, nonce y el verificador de PKCE quedan en una cookie firmada de
 * 10 minutos que lee /auth/callback.
 */
export async function GET(request: NextRequest) {
  const settings = readAuthSettings();
  if (!settings) return htmlPage(503, "Pulso no está disponible", AUTH_NOT_CONFIGURED);

  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  try {
    const target = await authorizationUrl(settings, callbackUrl(request.url), { state, nonce, challenge: await pkceChallenge(verifier) });
    const tx = await signCookie({ state, nonce, verifier, next: safeNext(request.nextUrl.searchParams.get("next")) }, settings.sessionSecret, LOGIN_TTL_S);
    const res = NextResponse.redirect(target);
    res.cookies.set(LOGIN_COOKIE, tx, cookieOptions(LOGIN_TTL_S));
    return res;
  } catch (err: any) {
    return htmlPage(err instanceof LoginError ? err.status : 503, "No se pudo iniciar sesión", String(err?.message || err));
  }
}
