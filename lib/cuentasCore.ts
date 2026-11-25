/**
 * Vista Cuentas: reglas puras (sin red ni base) para ordenar el gasto de pauta por marca,
 * ocasión y objetivo, y para compararlo con el presupuesto del año por línea.
 *
 * La clasificación sale del NOMBRE de la campaña, que en Taquión sigue una convención:
 *   TQN_<OCASIÓN>_META_<OBJETIVO>_..._<MARCA>...   (ej. TQN_ASADO_D_DOMINGO_META_CONV_TRAFICO_FRIGORAR 35%OFF_RAPPI_EPA_DDL)
 * Lo que no se reconoce queda en «Sin clasificar» y se lista aparte: nunca se adivina.
 *
 * Importable desde el servidor y desde el navegador.
 */

import type { CampaignRow } from "./types";

// ---------------------------------------------------------------------------
// Clasificación por nombre de campaña
// ---------------------------------------------------------------------------

export const SIN_CLASIFICAR = "Sin clasificar";
export const MULTIMARCA = "Multimarca";

export type Objetivo = "Awareness" | "Consideración" | "Conversión" | typeof SIN_CLASIFICAR;

export interface Clasificacion {
  marca: string;
  ocasion: string;
  objetivo: Objetivo;
  /** Rappi / PedidosYa cuando el nombre lo dice; null si no. */
  destino: string | null;
}

const MARCAS: { nombre: string; test: (t: string) => boolean }[] = [
  { nombre: "EPA", test: (t) => t === "EPA" },
  { nombre: "Torpedo", test: (t) => t.startsWith("TORPEDO") },
  { nombre: "Oreo", test: (t) => t.startsWith("OREO") },
  { nombre: "Kit Kat", test: (t) => t.startsWith("KITKAT") },
  { nombre: "Chomp", test: (t) => t.startsWith("CHOMP") },
  { nombre: "Sin Parar", test: (t) => t.startsWith("SINPARAR") },
];

/** Nombres de marca que se pueden usar al definir una línea de presupuesto. */
export const MARCAS_CONOCIDAS = MARCAS.map((m) => m.nombre);

const OCASIONES: Record<string, string> = {
  AON: "Always On",
  ASADO_D_DOMINGO: "Asado del Domingo",
  HALLOWEEN: "Halloween",
  DIA_LOCO: "Día Loco",
  HORAS_LOCAS: "Horas Locas",
  CYBER_MONDAY: "Cyber Monday",
  CYBER: "Cyber Monday",
  BLACK_FRIDAY: "Black Friday",
  TURBO_DIA_10: "Turbo Día 10",
  A_COMERCIAL: "Acción comercial",
  ACCION_COMERCIAL: "Acción comercial",
  SSN: "35% OFF",
};

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

function titulo(s: string): string {
  return s
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function clasificarCampana(nombre: string): Clasificacion {
  const n = normalizar(nombre).trim();

  // Ocasión: lo que va entre TQN_ y _META.
  let ocasion = SIN_CLASIFICAR;
  const mOc = /^TQN_(.+?)_META(?:_|$)/.exec(n);
  if (mOc) ocasion = OCASIONES[mOc[1]] ?? titulo(mOc[1]);

  // Objetivo: lo que sigue a META_.
  let objetivo: Objetivo = SIN_CLASIFICAR;
  const mObj = /_META_(CONS_AWA|CONS_VIS|CONV|CON)(?:_|$)/.exec(n);
  if (mObj) objetivo = mObj[1] === "CONS_AWA" ? "Awareness" : mObj[1] === "CONS_VIS" ? "Consideración" : "Conversión";

  // Destino de la acción comercial.
  const tokens = n.replace(/SIN[ _]PARAR/g, "SINPARAR").split(/[^A-Z0-9]+/).filter(Boolean);
  const destino = tokens.includes("RAPPI") ? "Rappi" : tokens.includes("PEYA") || tokens.includes("PEDIDOSYA") ? "PedidosYa" : null;

  // Marca: una sola → esa; varias o "MULTI" → Multimarca (el gasto de una campaña multimarca no se puede repartir sin ver cada anuncio).
  const marcas = MARCAS.filter((m) => tokens.some(m.test)).map((m) => m.nombre);
  let marca = SIN_CLASIFICAR;
  if (tokens.includes("MULTI") || marcas.length > 1) marca = MULTIMARCA;
  else if (marcas.length === 1) marca = marcas[0];

  return { marca, ocasion, objetivo, destino };
}

// ---------------------------------------------------------------------------
// Agregación
// ---------------------------------------------------------------------------

export interface Grupo {
  nombre: string;
  gasto: number;
  impresiones: number;
  clics: number;
  conversiones: number;
  campanas: number;
}

export interface Matriz {
  filas: string[];
  columnas: string[];
  /** valores[fila][columna] = gasto */
  valores: Record<string, Record<string, number>>;
}

export interface Resumen {
  total: Grupo;
  porMarca: Grupo[];
  porOcasion: Grupo[];
  porObjetivo: Grupo[];
  marcaPorOcasion: Matriz;
  /** Campañas con gasto a las que no se les reconoció marca, ocasión u objetivo. */
  sinClasificar: { nombre: string; gasto: number; falta: string[] }[];
}

const vacio = (nombre: string): Grupo => ({ nombre, gasto: 0, impresiones: 0, clics: 0, conversiones: 0, campanas: 0 });

function sumar(g: Grupo, c: CampaignRow) {
  g.gasto += c.spend;
  g.impresiones += c.impressions;
  g.clics += c.clicks;
  g.conversiones += c.conversions;
  g.campanas += 1;
}

function agrupar(rows: { c: CampaignRow; k: string }[]): Grupo[] {
  const m = new Map<string, Grupo>();
  for (const { c, k } of rows) {
    let g = m.get(k);
    if (!g) m.set(k, (g = vacio(k)));
    sumar(g, c);
  }
  // Más gasto primero; «Sin clasificar» siempre al final para que no tape lo reconocido.
  return [...m.values()].sort((a, b) => Number(a.nombre === SIN_CLASIFICAR) - Number(b.nombre === SIN_CLASIFICAR) || b.gasto - a.gasto);
}

export function resumir(campanas: CampaignRow[]): Resumen {
  const con = campanas.map((c) => ({ c, k: clasificarCampana(c.campaignName) }));
  const total = vacio("Total");
  for (const { c } of con) sumar(total, c);

  const matriz: Matriz = { filas: [], columnas: [], valores: {} };
  for (const { c, k } of con) {
    (matriz.valores[k.marca] ??= {})[k.ocasion] = (matriz.valores[k.marca]?.[k.ocasion] ?? 0) + c.spend;
  }
  const porMarca = agrupar(con.map(({ c, k }) => ({ c, k: k.marca })));
  const porOcasion = agrupar(con.map(({ c, k }) => ({ c, k: k.ocasion })));
  matriz.filas = porMarca.map((g) => g.nombre);
  matriz.columnas = porOcasion.map((g) => g.nombre);

  const sinClasificar = con
    .filter(({ c, k }) => c.spend > 0 && (k.marca === SIN_CLASIFICAR || k.ocasion === SIN_CLASIFICAR || k.objetivo === SIN_CLASIFICAR))
    .map(({ c, k }) => ({
      nombre: c.campaignName,
      gasto: c.spend,
      falta: [k.marca === SIN_CLASIFICAR && "marca", k.ocasion === SIN_CLASIFICAR && "ocasión", k.objetivo === SIN_CLASIFICAR && "objetivo"].filter(Boolean) as string[],
    }))
    .sort((a, b) => b.gasto - a.gasto);

  return { total, porMarca, porOcasion, porObjetivo: agrupar(con.map(({ c, k }) => ({ c, k: k.objetivo }))), marcaPorOcasion: matriz, sinClasificar };
}

// ---------------------------------------------------------------------------
// Presupuesto del año por línea
// ---------------------------------------------------------------------------

export interface Linea {
  id: string;
  nombre: string;
  /** Monto del año, en pesos. */
  monto: number;
  /** Marcas cuyo gasto cuenta contra esta línea. Vacío = gasto que no sale de las plataformas (shooting, activaciones): se carga a mano más adelante. */
  marcas: string[];
}

export interface PresupuestoAnual {
  /** Desde cuándo se cuenta el gasto del plan (AAAA-MM-DD). */
  inicio: string;
  lineas: Linea[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface LineaConEjecucion extends Linea {
  /** null = línea sin marcas (no sale de las plataformas). */
  ejecutado: number | null;
  /** 0–100; null si no hay ejecutado o el monto es 0. */
  pct: number | null;
  saldo: number | null;
}

export function ejecucionPorLinea(lineas: Linea[], porMarca: Grupo[]): { lineas: LineaConEjecucion[]; sinAsignar: number } {
  const gastoMarca = new Map(porMarca.map((g) => [g.nombre, g.gasto]));
  const usadas = new Set<string>();
  const out = lineas.map((l) => {
    if (l.marcas.length === 0) return { ...l, ejecutado: null, pct: null, saldo: null };
    let ejecutado = 0;
    for (const m of l.marcas) {
      // Una marca en dos líneas se contaría dos veces: solo cuenta la primera.
      if (usadas.has(m)) continue;
      usadas.add(m);
      ejecutado += gastoMarca.get(m) ?? 0;
    }
    return { ...l, ejecutado, pct: l.monto > 0 ? (ejecutado / l.monto) * 100 : null, saldo: l.monto - ejecutado };
  });
  let sinAsignar = 0;
  for (const g of porMarca) if (!usadas.has(g.nombre)) sinAsignar += g.gasto;
  return { lineas: out, sinAsignar };
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Valida lo que llega del navegador. Devuelve el presupuesto limpio o el motivo. */
export function validarPresupuesto(raw: unknown): PresupuestoAnual | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Falta el presupuesto." };
  const r = raw as Record<string, unknown>;
  const inicio = typeof r.inicio === "string" ? r.inicio : "";
  if (!FECHA.test(inicio) || Number.isNaN(Date.parse(inicio + "T12:00:00Z"))) return { error: "La fecha de inicio del plan no es válida (AAAA-MM-DD)." };
  if (!Array.isArray(r.lineas) || r.lineas.length === 0) return { error: "Cargá al menos una línea." };
  if (r.lineas.length > 20) return { error: "Hasta 20 líneas." };
  const lineas: Linea[] = [];
  const ids = new Set<string>();
  for (const [i, x] of (r.lineas as unknown[]).entries()) {
    const l = (x ?? {}) as Record<string, unknown>;
    const nombre = typeof l.nombre === "string" ? l.nombre.trim() : "";
    if (!nombre || nombre.length > 60) return { error: `La línea ${i + 1} necesita un nombre (hasta 60 caracteres).` };
    const monto = Number(l.monto);
    if (!Number.isFinite(monto) || monto < 0 || monto > 1e12) return { error: `El monto de «${nombre}» no es válido.` };
    const marcas = Array.isArray(l.marcas) ? l.marcas : [];
    if (!marcas.every((m) => typeof m === "string" && MARCAS_CONOCIDAS.includes(m))) return { error: `«${nombre}» tiene una marca que no se reconoce.` };
    let id = typeof l.id === "string" && /^[a-z0-9-]{1,40}$/.test(l.id) ? l.id : `l${i + 1}`;
    while (ids.has(id)) id += "x";
    ids.add(id);
    lineas.push({ id, nombre, monto: Math.round(monto), marcas: [...new Set(marcas as string[])] });
  }
  return { inicio, lineas };
}
