/**
 * fetch + JSON para los componentes cliente. Si la ruta responde con error,
 * incluye el motivo que manda el servidor (`{ error }`) en vez de solo
 * "HTTP 502" — así la pantalla de error dice qué pasó realmente.
 *
 * Un solo reintento ante 5xx o error de red: Windsor.ai a veces responde 500 en la
 * primera consulta de un período nuevo y a la segunda ya la tiene lista (medido en
 * producción). Un abort (cambio de pantalla o timeout) NO se reintenta.
 */
async function attempt<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") detail = body.error;
    } catch {
      // body sin JSON — alcanza con el status
    }
    const err = new Error(`HTTP ${res.status}${detail ? " — " + detail : ""}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    return await attempt<T>(url, init);
  } catch (err: any) {
    if (err?.name === "AbortError" || init?.signal?.aborted) throw err;
    const isGet = !init?.method || init.method.toUpperCase() === "GET";
    const retryable = isGet && (err?.status === undefined || err.status >= 500);
    if (!retryable) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    if (init?.signal?.aborted) throw err;
    return attempt<T>(url, init);
  }
}
