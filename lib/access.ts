/**
 * Páginas de Pulso, permisos y la sesión que el middleware le pasa a páginas y
 * rutas. Sin dependencias: lo importan también los componentes del navegador
 * (encabezado, pestañas, /usuarios). La verificación está en lib/auth.ts.
 */

// ---------------------------------------------------------------------------
// Páginas y permisos
// ---------------------------------------------------------------------------

export type PageKey = "finanzas" | "campanas" | "anuncios" | "comparacion" | "alertas";

export interface PageDef {
  key: PageKey;
  label: string;
  /** Pantalla (coincidencia exacta). */
  path: string;
  /** Rutas de datos que usa la pantalla (cubren también lo que cuelga: /api/alerts/<id>). */
  apis: string[];
}

/** En este orden se elige la pantalla de inicio de cada usuario. */
export const PAGES: PageDef[] = [
  { key: "finanzas", label: "Finanzas", path: "/", apis: ["/api/spend", "/api/finance-budget"] },
  { key: "campanas", label: "Medios · Campañas", path: "/medios", apis: ["/api/campaigns"] },
  { key: "anuncios", label: "Medios · Anuncios", path: "/medios/anuncios", apis: ["/api/ads"] },
  { key: "comparacion", label: "Medios · Comparación", path: "/medios/comparacion", apis: ["/api/platform-comparison"] },
  { key: "alertas", label: "Medios · Alertas", path: "/medios/alertas", apis: ["/api/alerts"] },
];
export const PAGE_KEYS = PAGES.map((p) => p.key);
export const MEDIOS_PAGES: PageKey[] = ["campanas", "anuncios", "comparacion", "alertas"];

/** Perfiles sugeridos al dar de alta (atajos en /usuarios; lo que se guarda son las páginas). */
export const PROFILES: { label: string; pages: PageKey[] }[] = [
  { label: "Finanzas", pages: ["finanzas"] },
  { label: "Medios/Ignite", pages: MEDIOS_PAGES },
];

export const USERS_PATH = "/usuarios";
const USERS_API = "/api/users";

/** Equivalencias cuenta publicitaria → cliente de Superlum: las maneja quien tiene la página Finanzas. */
export const EQUIVALENCIAS_PATH = "/equivalencias";
const EQUIVALENCIAS_API = "/api/equivalencias";

/** Cortes de finanzas (foto congelada de un período): también para quien tiene la página Finanzas. */
export const CORTES_PATH = "/cortes";
const CORTES_API = "/api/cortes";

/**
 * Únicas rutas sin SSO: las llama un cron de vercel.json, no una persona, y
 * cada una se protege sola con `Authorization: Bearer <CRON_SECRET>` (ver
 * app/api/cron/notify/route.ts). Lista explícita a propósito: una ruta de cron
 * o de calentamiento nueva se suma acá y TIENE que exigir CRON_SECRET; nada
 * queda abierto por estar bajo /api/cron/.
 */
export const CRON_PATHS = ["/api/cron/notify", "/api/cron/calentar"];
/** Login, vuelta del login y salida: tienen que poder abrirse sin sesión. */
export const AUTH_PREFIX = "/auth/";

export interface Access {
  pages: PageKey[];
  /** Puede dar de alta, cambiar y quitar usuarios en /usuarios. */
  admin: boolean;
}

const underPath = (pathname: string, base: string) => pathname === base || pathname.startsWith(base + "/");

/**
 * Qué pide `pathname`: una página, "admin" (gestión de usuarios), "any"
 * (cualquier usuario con acceso: imágenes, páginas de error) o "deny".
 *
 * ⚠️ Una ruta /api/* que no esté en PAGES responde 403 a todos: al crear una
 * ruta nueva hay que sumarla a `apis` de la página que la usa.
 */
export function requiredAccess(pathname: string): PageKey | "admin" | "any" | "deny" {
  for (const p of PAGES) {
    if (pathname === p.path || p.apis.some((api) => underPath(pathname, api))) return p.key;
  }
  if (underPath(pathname, EQUIVALENCIAS_PATH) || underPath(pathname, EQUIVALENCIAS_API)) return "finanzas";
  if (underPath(pathname, CORTES_PATH) || underPath(pathname, CORTES_API)) return "finanzas";
  if (underPath(pathname, USERS_PATH) || underPath(pathname, USERS_API)) return "admin";
  return pathname.startsWith("/api/") ? "deny" : "any";
}

export function canAccess(access: Access, needed: ReturnType<typeof requiredAccess>): boolean {
  if (needed === "any") return true;
  if (needed === "deny") return false;
  if (needed === "admin") return access.admin;
  return access.pages.includes(needed);
}

/** Pantalla de inicio: la primera página habilitada (o /usuarios para un admin sin páginas). */
export function homePath(access: Access): string | null {
  const first = PAGES.find((p) => access.pages.includes(p.key));
  if (first) return first.path;
  return access.admin ? USERS_PATH : null;
}

// ---------------------------------------------------------------------------
// Sesión que el middleware le pasa a páginas y rutas
// ---------------------------------------------------------------------------

/**
 * Headers con la identidad y los permisos verificados. El middleware los PISA
 * en cada pedido, así que un valor que mande el navegador nunca llega.
 */
export const USER_HEADER = "x-pulso-user";
export const PAGES_HEADER = "x-pulso-pages";
export const ADMIN_HEADER = "x-pulso-admin";

export interface Session extends Access {
  email: string;
}

/** Lee la sesión que dejó el middleware (`headers()` en páginas, `request.headers` en rutas). */
export function readSession(headers: Headers): Session {
  return {
    email: headers.get(USER_HEADER) ?? "",
    pages: (headers.get(PAGES_HEADER) ?? "").split(",").filter((p): p is PageKey => (PAGE_KEYS as string[]).includes(p)),
    admin: headers.get(ADMIN_HEADER) === "1",
  };
}
