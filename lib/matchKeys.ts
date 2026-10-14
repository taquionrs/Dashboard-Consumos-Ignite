/**
 * Claves para cruzar la hoja de proyectados con las cuentas y campañas que trae Windsor.
 *
 * Antes el cruce era por texto EXACTO: una diferencia que no se ve (guiones en el ID de cuenta de Google,
 * un espacio doble o de los que no se ven, mayúsculas, otra barra "|") dejaba la campaña en "Sin objetivo
 * cargado" sin ningún aviso. Ahora se normaliza de los dos lados.
 *
 * Sin dependencias del servidor.
 */

/** ID de cuenta solo con dígitos: "957-027-5909" y "9570275909" son la misma cuenta. */
export function normAccountId(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** Nombre de campaña sin diferencias que no se ven: espacios raros o repetidos, mayúsculas, barras parecidas. */
export function normCampaignName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[  -​ ⁠﻿]/g, " ")
    .replace(/[｜│¦∣]/g, "|")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Clave cuenta + campaña para el presupuesto por campaña. */
export function budgetKey(accountId: unknown, campaignName: unknown): string {
  return `${normAccountId(accountId)}:${normCampaignName(campaignName)}`;
}
