import { normAccountId } from "./matchKeys";
import type { MaestroData } from "./maestroCore";

/**
 * Equivalencias: a qué cliente (y proyecto) de Superlum corresponde cada cuenta
 * publicitaria de Pulso. Es lo que permite, más adelante, mandar los cortes de
 * Finanzas a Superlum y al P&L asignados al proyecto correcto.
 *
 * Núcleo PURO: sin Redis ni fetch. El almacenamiento está en lib/equivalencias.ts.
 *
 * Identidad: la cuenta se guarda por su ID con solo dígitos (normAccountId), así
 * "957-027-5909" y "9570275909" son la misma. El cliente y el proyecto se guardan
 * por el `id` de Superlum (no cambia si alguien los renombra); el nombre es la
 * copia de cuando se vinculó, para mostrar.
 */

export interface Equivalencia {
  accountId: string;
  clienteId: string;
  clienteNombre: string;
  proyectoId: string | null;
  proyectoNombre: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface EquivalenciaInput {
  accountId: string;
  clienteId: string;
  proyectoId: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_ID = 100;

/** Valida el cuerpo de un alta o cambio. No mira a Superlum: eso lo hace resolverVinculo. */
export function validateEquivalenciaInput(body: unknown): Result<EquivalenciaInput> {
  if (!body || typeof body !== "object") return { ok: false, error: "Cuerpo inválido." };
  const b = body as Record<string, unknown>;
  const accountId = normAccountId(b.accountId);
  if (!accountId || accountId.length > 30) return { ok: false, error: "El ID de la cuenta no es válido." };
  if (typeof b.clienteId !== "string" || !b.clienteId.trim() || b.clienteId.length > MAX_ID) {
    return { ok: false, error: "Elegí el cliente de Superlum." };
  }
  let proyectoId: string | null = null;
  if (b.proyectoId != null && b.proyectoId !== "") {
    if (typeof b.proyectoId !== "string" || b.proyectoId.length > MAX_ID) return { ok: false, error: "El proyecto no es válido." };
    proyectoId = b.proyectoId;
  }
  return { ok: true, value: { accountId, clienteId: b.clienteId.trim(), proyectoId } };
}

/**
 * Comprueba contra la lista del Maestro que el cliente existe y que el proyecto
 * (si se eligió) es de ese cliente, y toma los nombres de ahí: el navegador no
 * decide qué nombre queda guardado.
 */
export function resolverVinculo(
  input: EquivalenciaInput,
  maestro: MaestroData
): Result<Pick<Equivalencia, "accountId" | "clienteId" | "clienteNombre" | "proyectoId" | "proyectoNombre">> {
  const cliente = maestro.clientes.find((c) => c.id === input.clienteId);
  if (!cliente) return { ok: false, error: "Ese cliente no figura en Superlum (puede haberse borrado). Actualizá la pantalla." };
  let proyecto = null;
  if (input.proyectoId !== null) {
    proyecto = maestro.proyectos.find((p) => p.id === input.proyectoId) ?? null;
    if (!proyecto) return { ok: false, error: "Ese proyecto no figura en Superlum (puede haberse borrado). Actualizá la pantalla." };
    if (proyecto.clienteId !== cliente.id) return { ok: false, error: `El proyecto «${proyecto.nombre}» no es de ${cliente.nombre}.` };
  }
  return {
    ok: true,
    value: {
      accountId: input.accountId,
      clienteId: cliente.id,
      clienteNombre: cliente.nombre,
      proyectoId: proyecto?.id ?? null,
      proyectoNombre: proyecto?.nombre ?? null,
    },
  };
}

/** Cuántas de las cuentas de Pulso ya tienen cliente, y cuáles faltan. */
export function resumenDeVinculos(accountIds: string[], equivalencias: Equivalencia[]) {
  const vinculadas = new Set(equivalencias.map((e) => e.accountId));
  const ids = [...new Set(accountIds.map(normAccountId).filter(Boolean))];
  const sinVincular = ids.filter((id) => !vinculadas.has(id));
  return { total: ids.length, vinculadas: ids.length - sinVincular.length, sinVincular };
}
