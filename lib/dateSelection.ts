"use client";

import { useState } from "react";

/**
 * Período elegido en el selector de fecha de las pantallas (compartido por Finanzas, Campañas, Anuncios y
 * Comparación): un preset o un rango propio desde/hasta. `rangeQs` es el pedazo de query para las rutas /api
 * (`range=7d` o `range=custom&from=...&to=...`).
 */

export type DatePreset = "today" | "yesterday" | "7d" | "14d" | "28d" | "month" | "lastmonth" | "custom";

export const DATE_PRESETS: { key: Exclude<DatePreset, "custom">; label: string }[] = [
  { key: "today", label: "Hoy" },
  { key: "yesterday", label: "Ayer" },
  { key: "7d", label: "Últimos 7 días" },
  { key: "14d", label: "Últimos 14 días" },
  { key: "28d", label: "Últimos 28 días" },
  { key: "month", label: "Este mes" },
  { key: "lastmonth", label: "Mes anterior" },
];

export interface DateSelection {
  preset: DatePreset;
  /** Solo con preset "custom": AAAA-MM-DD. */
  from: string;
  to: string;
}

export const MAX_CUSTOM_DAYS = 366;

/** dd/mm/aaaa a partir de AAAA-MM-DD. */
export function fmtDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function selectionLabel(sel: DateSelection): string {
  if (sel.preset === "custom") return `${fmtDay(sel.from)} → ${fmtDay(sel.to)}`;
  return DATE_PRESETS.find((p) => p.key === sel.preset)?.label ?? "Este mes";
}

export function selectionQuery(sel: DateSelection): string {
  return sel.preset === "custom" ? `range=custom&from=${sel.from}&to=${sel.to}` : `range=${sel.preset}`;
}

export function useDateSelection() {
  const [sel, setSel] = useState<DateSelection>({ preset: "month", from: "", to: "" });
  return { sel, setSel, rangeQs: selectionQuery(sel) };
}
