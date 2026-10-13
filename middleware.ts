import { NextResponse, type NextRequest } from "next/server";
import {
  ADMIN_HEADER,
  AUTH_NOT_CONFIGURED,
  AUTH_PREFIX,
  canAccess,
  CRON_PATHS,
  devSession,
  homePath,
  htmlPage,
  PAGES_HEADER,
  readAuthSettings,
  requiredAccess,
  SESSION_COOKIE,
  USER_HEADER,
  verifyCookie,
  type Session,
} from "@/lib/auth";
import { resolveAccess, UsersError } from "@/lib/users";

/**
 * Login con SSO y permisos por página para TODO Pulso — pantallas y /api/* —
 * salvo las rutas de cron (CRON_PATHS; se protegen con CRON_SECRET) y
 * /auth/* (el login mismo). Reglas en lib/auth.ts, usuarios en lib/users.ts.
 *
 * - Sin sesión: las pantallas van al login de Cloudflare; /api/* responde 401.
 * - Con sesión pero fuera del registro de usuarios: aviso "sin acceso" / 403.
 * - Sin permiso para esa página: lleva a la primera página que sí tiene; /api/* 403.
 */

// Los archivos de build (_next/static, _next/image) quedan fuera: son código del
// front, no datos, y verificarlos en cada pedido solo suma latencia.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

const LOGOUT_LINK = { href: "/auth/logout", label: "Cerrar sesión y entrar con otra cuenta" };

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (CRON_PATHS.includes(pathname)) return NextResponse.next();
  const isApi = pathname.startsWith("/api/");

  // Un solo dominio: la cookie de sesión vive en él y es el que figura como
  // URL de vuelta del login en Cloudflare (p. ej. *.vercel.app → pulso.taquion.com.ar).
  const publicUrl = process.env.PULSO_PUBLIC_URL?.trim();
  if (publicUrl && !isApi && request.method === "GET" && new URL(publicUrl).host !== request.nextUrl.host) {
    return NextResponse.redirect(new URL(pathname + search, publicUrl));
  }
  if (pathname.startsWith(AUTH_PREFIX)) return NextResponse.next();

  // CSRF: los cambios (POST, PUT, PATCH, DELETE) solo desde el propio Pulso.
  if (isApi && request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if ((origin && origin !== request.nextUrl.origin) || (site && site !== "same-origin" && site !== "none")) {
      return json(403, "Origen no permitido.");
    }
  }

  let session: Session;
  const settings = readAuthSettings();
  if (!settings) {
    const dev = devSession();
    if (!dev) return deny(isApi, 503, "Pulso no está disponible", AUTH_NOT_CONFIGURED);
    session = dev;
  } else {
    const cookie = await verifyCookie<{ email?: unknown }>(request.cookies.get(SESSION_COOKIE)?.value, settings.sessionSecret);
    const email = typeof cookie?.email === "string" ? cookie.email : "";
    if (!email) {
      if (isApi || request.method !== "GET") return json(401, "No iniciaste sesión o la sesión venció. Recargá la página para volver a ingresar.");
      return NextResponse.redirect(new URL(`/auth/login?next=${encodeURIComponent(pathname + search)}`, request.url));
    }
    let access;
    try {
      access = await resolveAccess(email);
    } catch (err: any) {
      return deny(isApi, err instanceof UsersError ? err.status : 503, "Pulso no está disponible", String(err?.message || err));
    }
    if (!access) {
      return deny(isApi, 403, "Sin acceso a Pulso", `La cuenta ${email} no tiene acceso a Pulso. Pedile el alta a un administrador.`, [LOGOUT_LINK]);
    }
    session = { email, ...access };
  }

  const needed = requiredAccess(pathname);
  if (!canAccess(session, needed)) {
    if (isApi) return json(403, "Tu usuario no tiene acceso a este recurso.");
    const home = homePath(session);
    if (home && home !== pathname) return NextResponse.redirect(new URL(home, request.url));
    return htmlPage(403, "Sin acceso", "Tu usuario no tiene acceso a esta pantalla.", [LOGOUT_LINK]);
  }

  // Identidad y permisos verificados para páginas y rutas (lib/auth.ts →
  // readSession). Se pisan siempre: lo que mande el navegador nunca pasa.
  const headers = new Headers(request.headers);
  headers.set(USER_HEADER, session.email);
  headers.set(PAGES_HEADER, session.pages.join(","));
  headers.set(ADMIN_HEADER, session.admin ? "1" : "0");
  return NextResponse.next({ request: { headers } });
}

function json(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function deny(isApi: boolean, status: number, title: string, detail: string, links?: { href: string; label: string }[]) {
  return isApi ? json(status, detail) : htmlPage(status, title, detail, links);
}
