import { normAccountId } from "./matchKeys";
import type { Equivalencia } from "./equivalenciasCore";
import type { PlatformKey, SpendResponse } from "./types";

/**
 * Cortes de finanzas: una foto, congelada, del consumo de pauta de un período
 * (por cuenta, plataforma y campaña) con su presupuesto y las equivalencias con
 * Superlum de ese momento. Es lo que más adelante se envía a Superlum y al P&L.
 *
 * Núcleo PURO: sin Redis, sin fetch, sin la fecha del servidor (todo lo que
 * depende del "ahora" entra por parámetro). El almacenamiento está en
 * lib/cortes.ts y la generación en app/api/cortes/route.ts.
 *
 * Reglas que se respetan de Pulso y del P&L:
 * - Un dato que falta va `null`, nunca `0`: «sin presupuesto cargado» no es «presupuesto cero».
 * - El presupuesto de la hoja madre es del MES EN CURSO. Solo se compara con el
 *   consumo si el corte empieza el día 1 del mes en curso (mes a la fecha o mes
 *   completo). Un corte de otro período lleva el consumo real y deja el
 *   presupuesto, el remanente y el ritmo en `null`, con un aviso que lo explica.
 */

export const CORTE_VERSION = 1;

export interface CorteCampana {
  campaignId: string;
  campaignName: string;
  presupuesto: number | null;
  real: number;
}

export interface CortePlataforma {
  plataforma: PlatformKey;
  /** % de la cuenta que va a esa plataforma (suma ~100 entre las plataformas de la cuenta). */
  pct: number;
  presupuesto: number | null;
  real: number;
}

export interface CorteVinculo {
  clienteId: string;
  clienteNombre: string;
  proyectoId: string | null;
  proyectoNombre: string | null;
}

export interface CorteCuenta {
  accountId: string;
  nombre: string;
  presupuesto: number | null;
  real: number;
  /** presupuesto − real (puede ser negativo si se pasó). */
  remanente: number | null;
  /** Proyección a fin de mes sobre el presupuesto, en %: 100 = justo en ritmo. */
  ritmoPct: number | null;
  plataformas: CortePlataforma[];
  campanas: CorteCampana[];
  /** null = cuenta sin vincular en /equivalencias. */
  vinculo: CorteVinculo | null;
}

export interface CorteTotales {
  real: number;
  presupuesto: number | null;
  remanente: number | null;
  /** «Total presupuesto» que carga a mano el gerente de Finanzas (un solo número, no depende del período). */
  presupuestoManual: number | null;
  cuentasSinVincular: number;
}

export interface Corte {
  id: string;
  version: typeof CORTE_VERSION;
  desde: string;
  hasta: string;
  dias: number;
  generadoEn: string;
  generadoPor: string;
  /** Hasta cuándo es el dato: la caché puede tener unos minutos. */
  datosAl: string;
  fuente: "windsor";
  presupuestoComparable: boolean;
  totales: CorteTotales;
  cuentas: CorteCuenta[];
  avisos: string[];
}

export interface CorteResumen {
  id: string;
  desde: string;
  hasta: string;
  dias: number;
  generadoEn: string;
  generadoPor: string;
  totales: CorteTotales;
  cuentas: number;
  avisos: number;
}

const ID_RE = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}_\d{14}_[0-9a-f]{4}$/;
export const esIdDeCorte = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

const r2 = (n: number) => Math.round(n * 100) / 100;
const finito = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

/** Días del mes de una fecha AAAA-MM-DD. */
export function diasDelMes(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** El corte compara con el presupuesto solo si empieza el día 1 del mes en curso (`hoy` = AAAA-MM-DD). */
export function esPresupuestoComparable(desde: string, hasta: string, hoy: string): boolean {
  return desde.endsWith("-01") && desde.slice(0, 7) === hoy.slice(0, 7) && hasta.slice(0, 7) === desde.slice(0, 7);
}

export interface ArmarCorteInput {
  spend: SpendResponse;
  desde: string;
  hasta: string;
  dias: number;
  /** AAAA-MM-DD de hoy (fecha de Pulso). */
  hoy: string;
  ahora: Date;
  /** Cuatro caracteres hexa, para que dos cortes del mismo período en el mismo segundo no choquen. */
  sufijo: string;
  generadoPor: string;
  /** Edad del dato de Windsor, en ms (0 si es recién consultado). */
  edadDatoMs: number;
  presupuestoManual: number | null;
  /** null = no se pudieron leer: el corte sale igual, con todas las cuentas sin vincular y un aviso. */
  equivalencias: Equivalencia[] | null;
  avisosExtra?: string[];
}

export function armarCorte(input: ArmarCorteInput): Corte {
  const { spend, desde, hasta, dias, hoy, ahora } = input;
  const comparable = esPresupuestoComparable(desde, hasta, hoy);
  const diasMes = diasDelMes(desde);
  const vinculos = new Map((input.equivalencias ?? []).map((e) => [e.accountId, e]));
  const avisos: string[] = [...(input.avisosExtra ?? [])];

  const cuentas: CorteCuenta[] = [];
  for (const c of spend.clients) {
    const accountId = normAccountId(c.accountId);
    // Un cliente sin account_id es del dataset de ejemplo: no es una cuenta real, no entra a un corte.
    if (!accountId) continue;
    const real = r2(finito(c.spend8));
    const bruto = finito(c.budget);
    const presupuesto = comparable && bruto > 0 ? r2(bruto) : null;
    const eq = vinculos.get(accountId);

    const plataformas: CortePlataforma[] = [];
    for (const [key, pctRaw] of Object.entries(c.mix)) {
      const pct = finito(pctRaw);
      if (pct <= 0) continue;
      plataformas.push({
        plataforma: key as PlatformKey,
        pct: r2(pct),
        presupuesto: presupuesto === null ? null : r2((presupuesto * pct) / 100),
        real: r2((real * pct) / 100),
      });
    }

    cuentas.push({
      accountId,
      nombre: c.name,
      presupuesto,
      real,
      remanente: presupuesto === null ? null : r2(presupuesto - real),
      ritmoPct: presupuesto === null || dias <= 0 ? null : r2((((real / dias) * diasMes) / presupuesto) * 100),
      plataformas,
      campanas: (c.campaigns ?? []).map((k) => ({
        campaignId: k.campaignId,
        campaignName: k.campaignName,
        presupuesto: comparable && finito(k.budget) > 0 ? r2(k.budget) : null,
        real: r2(finito(k.spend)),
      })),
      vinculo: eq ? { clienteId: eq.clienteId, clienteNombre: eq.clienteNombre, proyectoId: eq.proyectoId, proyectoNombre: eq.proyectoNombre } : null,
    });
  }
  cuentas.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

  const conPresupuesto = cuentas.filter((c) => c.presupuesto !== null);
  const totalPresupuesto = conPresupuesto.length ? r2(conPresupuesto.reduce((s, c) => s + (c.presupuesto ?? 0), 0)) : null;
  const totalReal = r2(cuentas.reduce((s, c) => s + c.real, 0));
  const sinVincular = cuentas.filter((c) => !c.vinculo).length;

  if (!comparable) {
    avisos.push("El presupuesto de la hoja es del mes en curso: solo se compara con el consumo si el corte empieza el día 1 de este mes. En este corte quedó vacío.");
  } else if (conPresupuesto.length < cuentas.length) {
    avisos.push(`${cuentas.length - conPresupuesto.length} cuenta(s) sin presupuesto cargado en la hoja: el total de presupuesto no las incluye.`);
  }
  if (input.equivalencias === null) avisos.push("No se pudieron leer las equivalencias con Superlum: todas las cuentas figuran sin vincular.");
  else if (sinVincular > 0) avisos.push(`${sinVincular} cuenta(s) sin vincular en Equivalencias: no se podrán asignar a un proyecto de Superlum.`);
  if (cuentas.length === 0) avisos.push("Windsor no devolvió cuentas con datos para este período.");
  if (spend.warnings?.length) avisos.push(...spend.warnings);

  const datosAl = new Date(ahora.getTime() - Math.max(0, input.edadDatoMs)).toISOString();
  const stamp = ahora.toISOString().replace(/\D/g, "").slice(0, 14);

  return {
    id: `${desde}_${hasta}_${stamp}_${input.sufijo}`,
    version: CORTE_VERSION,
    desde,
    hasta,
    dias,
    generadoEn: ahora.toISOString(),
    generadoPor: input.generadoPor,
    datosAl,
    fuente: "windsor",
    presupuestoComparable: comparable,
    totales: {
      real: totalReal,
      presupuesto: totalPresupuesto,
      remanente: totalPresupuesto === null ? null : r2(totalPresupuesto - cuentas.filter((c) => c.presupuesto !== null).reduce((s, c) => s + c.real, 0)),
      presupuestoManual: input.presupuestoManual,
      cuentasSinVincular: sinVincular,
    },
    cuentas,
    avisos,
  };
}

export function resumirCorte(c: Corte): CorteResumen {
  return {
    id: c.id,
    desde: c.desde,
    hasta: c.hasta,
    dias: c.dias,
    generadoEn: c.generadoEn,
    generadoPor: c.generadoPor,
    totales: c.totales,
    cuentas: c.cuentas.length,
    avisos: c.avisos.length,
  };
}
