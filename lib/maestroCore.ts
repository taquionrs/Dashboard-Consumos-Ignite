/**
 * Forma de lo que devuelve el Maestro de Superlum (clientes y proyectos de
 * Taquion, solo lectura) y cómo leerlo. Núcleo PURO: sin fetch ni env, así se
 * prueba solo. La llamada HTTP está en lib/maestro.ts.
 *
 * De todo lo que trae el Maestro, Pulso se queda con lo que necesita para
 * vincular una cuenta publicitaria: id y nombre del cliente, id y nombre del
 * proyecto y a qué cliente pertenece. Los contactos, ventas y fechas no se
 * guardan acá.
 */

export interface MaestroCliente {
  id: string;
  nombre: string;
  estado: string | null;
}

export interface MaestroProyecto {
  id: string;
  nombre: string;
  estado: string | null;
  /** null si el cliente del proyecto está en la papelera de Superlum. */
  clienteId: string | null;
}

export interface MaestroData {
  generadoEl: string | null;
  clientes: MaestroCliente[];
  proyectos: MaestroProyecto[];
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Lee la respuesta del GET del Maestro. Acepta el cuerpo con o sin el envoltorio
 * `{ ok, data }`. Devuelve null si no tiene la forma esperada (nunca inventa
 * una lista vacía donde no hay datos). Una fila sin id o sin nombre se descarta.
 */
export function parseMaestro(body: unknown): MaestroData | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  if (!Array.isArray(data.clientes) || !Array.isArray(data.proyectos)) return null;

  const clientes: MaestroCliente[] = [];
  for (const raw of data.clientes) {
    const c = raw as Record<string, unknown> | null;
    const id = text(c?.id);
    const nombre = text(c?.nombre);
    if (id && nombre) clientes.push({ id, nombre, estado: text(c?.estado) });
  }

  const proyectos: MaestroProyecto[] = [];
  for (const raw of data.proyectos) {
    const p = raw as Record<string, unknown> | null;
    const id = text(p?.id);
    const nombre = text(p?.nombre);
    if (!id || !nombre) continue;
    const cliente = p?.cliente && typeof p.cliente === "object" ? (p.cliente as Record<string, unknown>) : null;
    proyectos.push({ id, nombre, estado: text(p?.estado), clienteId: text(cliente?.id) });
  }

  clientes.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  proyectos.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  return { generadoEl: text(data.generadoEl), clientes, proyectos };
}
