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
  /** Suma del alcance de cada campaña: una misma persona alcanzada por dos campañas se cuenta dos veces. */
  alcance: number;
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

const vacio = (nombre: string): Grupo => ({ nombre, gasto: 0, impresiones: 0, clics: 0, conversiones: 0, alcance: 0, campanas: 0 });

function sumar(g: Grupo, c: CampaignRow) {
  g.gasto += c.spend;
  g.impresiones += c.impressions;
  g.clics += c.clicks;
  g.conversiones += c.conversions;
  g.alcance += c.reach ?? 0;
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
  /** Metas del plan de medios para esta línea (todas opcionales). Se comparan con lo real de las plataformas. */
  metas?: Metas;
}

export interface Metas {
  /** Impresiones esperadas en el plan. */
  impresiones?: number;
  /** Alcance esperado (personas). */
  alcance?: number;
  /** CPM de referencia, en pesos por mil impresiones. */
  cpm?: number;
}

export interface PresupuestoAnual {
  /** Desde cuándo se cuenta el gasto del plan (AAAA-MM-DD). */
  inicio: string;
  lineas: Linea[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface LineaConEjecucion extends Linea {
  /** Gasto de las plataformas (marcas de la línea) más lo cargado a mano. */
  ejecutado: number;
  /** De ese total, lo cargado a mano (UGC, envíos, shooting...). */
  aMano: number;
  /** Lo que midieron las plataformas para las marcas de la línea (sin lo cargado a mano). */
  plataformas: { gasto: number; impresiones: number; alcance: number; cpm: number | null };
  /** 0–100; null si el monto es 0. */
  pct: number | null;
  saldo: number;
}

export function ejecucionPorLinea(lineas: Linea[], porMarca: Grupo[], gastos: GastoManual[] = []): { lineas: LineaConEjecucion[]; sinAsignar: number } {
  const gastoMarca = new Map(porMarca.map((g) => [g.nombre, g.gasto]));
  const usadas = new Set<string>();
  const porNombre = new Map(porMarca.map((g) => [g.nombre, g]));
  const out = lineas.map((l) => {
    let plataformas = 0;
    let impresiones = 0;
    let alcance = 0;
    for (const m of l.marcas) {
      // Una marca en dos líneas se contaría dos veces: solo cuenta la primera.
      if (usadas.has(m)) continue;
      usadas.add(m);
      plataformas += gastoMarca.get(m) ?? 0;
      impresiones += porNombre.get(m)?.impresiones ?? 0;
      alcance += porNombre.get(m)?.alcance ?? 0;
    }
    const aMano = gastos.filter((g) => g.lineaId === l.id).reduce((s, g) => s + g.monto, 0);
    const ejecutado = plataformas + aMano;
    const real = { gasto: plataformas, impresiones, alcance, cpm: impresiones > 0 ? (plataformas / impresiones) * 1000 : null };
    return { ...l, ejecutado, aMano, plataformas: real, pct: l.monto > 0 ? (ejecutado / l.monto) * 100 : null, saldo: l.monto - ejecutado };
  });
  let sinAsignar = 0;
  for (const g of porMarca) if (!usadas.has(g.nombre)) sinAsignar += g.gasto;
  return { lineas: out, sinAsignar };
}

// ---------------------------------------------------------------------------
// Gastos fuera de las plataformas (UGC, envíos, shooting...)
// ---------------------------------------------------------------------------

export const CATEGORIAS_GASTO = ["UGC", "Envío", "Shooting", "Influencer", "Otro"] as const;
export type CategoriaGasto = (typeof CATEGORIAS_GASTO)[number];

export interface GastoManual {
  id: string;
  /** Día del gasto (AAAA-MM-DD). */
  fecha: string;
  /** Línea del presupuesto a la que cuenta. */
  lineaId: string;
  categoria: CategoriaGasto;
  /** Qué se pagó y a quién (ej. «Pago UGC - cafeyroma»). */
  detalle: string;
  /** Campaña o acción a la que pertenece, en texto libre (ej. «Oreo Bites Mundial»); puede ir vacío. */
  campana: string;
  monto: number;
  updatedAt?: string;
  updatedBy?: string;
}

/** Valida un gasto que llega del navegador. `lineaIds` = las líneas del presupuesto cargado. */
export function validarGasto(raw: unknown, lineaIds: string[]): Omit<GastoManual, "id" | "updatedAt" | "updatedBy"> | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Falta el gasto." };
  const r = raw as Record<string, unknown>;
  const fecha = typeof r.fecha === "string" ? r.fecha : "";
  if (!FECHA.test(fecha) || Number.isNaN(Date.parse(fecha + "T12:00:00Z"))) return { error: "La fecha del gasto no es válida (AAAA-MM-DD)." };
  const lineaId = typeof r.lineaId === "string" ? r.lineaId : "";
  if (!lineaIds.includes(lineaId)) return { error: "Elegí una línea del presupuesto." };
  const categoria = r.categoria as CategoriaGasto;
  if (!(CATEGORIAS_GASTO as readonly string[]).includes(categoria)) return { error: "Elegí una categoría." };
  const detalle = typeof r.detalle === "string" ? r.detalle.trim() : "";
  if (!detalle || detalle.length > 120) return { error: "Escribí qué se pagó (hasta 120 caracteres)." };
  const campana = typeof r.campana === "string" ? r.campana.trim() : "";
  if (campana.length > 60) return { error: "La campaña puede tener hasta 60 caracteres." };
  const monto = Number(r.monto);
  if (!Number.isFinite(monto) || monto <= 0 || monto > 1e12) return { error: "El monto tiene que ser mayor a cero." };
  return { fecha, lineaId, categoria, detalle, campana, monto: Math.round(monto * 100) / 100 };
}

/** Gastos cuyo día cae dentro del período (ambos extremos incluidos). */
export const gastosDelPeriodo = (gastos: GastoManual[], desde: string, hasta: string) => gastos.filter((g) => g.fecha >= desde && g.fecha <= hasta);

/** Total por campaña (texto libre), para ver cuánto se gastó fuera de plataformas en cada acción. */
export function gastosPorCampana(gastos: GastoManual[]): { campana: string; monto: number; gastos: number }[] {
  const m = new Map<string, { campana: string; monto: number; gastos: number }>();
  for (const g of gastos) {
    const k = g.campana || "Sin campaña";
    const e = m.get(k) ?? { campana: k, monto: 0, gastos: 0 };
    e.monto += g.monto;
    e.gastos += 1;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.monto - a.monto);
}

/** undefined = sin metas, null = algo inválido, objeto = metas limpias. */
function leerMetas(raw: unknown): Metas | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Metas = {};
  for (const k of ["impresiones", "alcance", "cpm"] as const) {
    const v = r[k];
    if (v === undefined || v === null || v === "" || v === 0) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e13) return null;
    out[k] = Math.round(n * 100) / 100;
  }
  return Object.keys(out).length ? out : undefined;
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
    const metas = leerMetas(l.metas);
    if (metas === null) return { error: `Las metas de «${nombre}» no son válidas (números mayores a cero).` };
    lineas.push({ id, nombre, monto: Math.round(monto), marcas: [...new Set(marcas as string[])], ...(metas ? { metas } : {}) });
  }
  return { inicio, lineas };
}
