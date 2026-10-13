import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, readAuthSettings, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /auth/logout → borra la sesión de Pulso y cierra también la de Cloudflare Access. */
export async function GET(request: NextRequest) {
  const settings = readAuthSettings();
  const res = NextResponse.redirect(settings ? settings.logoutUrl : new URL("/", request.url));
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return res;
}
