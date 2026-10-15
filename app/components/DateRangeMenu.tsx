"use client";

import { useEffect, useRef, useState } from "react";
import { DATE_PRESETS, MAX_CUSTOM_DAYS, selectionLabel, type DateSelection } from "@/lib/dateSelection";

/**
 * Selector de período de todas las pantallas: presets (Hoy, Ayer, Últimos 7 días, Este mes...) y "Personalizado"
 * con fechas desde/hasta. El rango propio recién se aplica al tocar "Aplicar" (y se valida ahí): antes las fechas
 * se guardaban pero la pantalla seguía mostrando "Este mes".
 */

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function validate(from: string, to: string): string | null {
  if (!from || !to) return "Elegí las dos fechas: desde y hasta.";
  if (from > to) return "La fecha desde no puede ser posterior a la fecha hasta.";
  if (to > todayISO()) return "La fecha hasta no puede ser futura.";
  const days = Math.round((new Date(to + "T00:00:00").getTime() - new Date(from + "T00:00:00").getTime()) / 86400000) + 1;
  if (days > MAX_CUSTOM_DAYS) return `El rango puede tener hasta ${MAX_CUSTOM_DAYS} días.`;
  return null;
}

export default function DateRangeMenu({ value, onChange }: { value: DateSelection; onChange: (next: DateSelection) => void }) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function apply() {
    const problem = validate(from, to);
    setError(problem);
    if (problem) return;
    onChange({ preset: "custom", from, to });
    setOpen(false);
  }

  return (
    <div className="dropdown-wrap" ref={ref}>
      <button className="chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {selectionLabel(value)} <span style={{ fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div className="date-menu" role="menu">
          {DATE_PRESETS.map((d) => (
            <button
              key={d.key}
              role="menuitem"
              aria-current={value.preset === d.key}
              onClick={() => {
                onChange({ preset: d.key, from: "", to: "" });
                setOpen(false);
              }}
            >
              {d.label}
            </button>
          ))}
          <div className="date-menu-divider" />
          <div className="date-menu-note">
            Windsor.ai sincroniza una vez al día — &quot;Hoy&quot; y &quot;Ayer&quot; pueden no reflejar todavía la sincronización más
            reciente.
          </div>
          <div className="date-menu-divider" />
          <button role="menuitem" aria-current={value.preset === "custom"} onClick={() => setCustomOpen((v) => !v)}>
            Personalizado <span style={{ fontSize: 10 }}>{customOpen ? "▴" : "▸"}</span>
          </button>
          {customOpen && (
            <div className="date-custom">
              <label>
                Desde
                <input type="date" value={from} max={todayISO()} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                Hasta
                <input type="date" value={to} max={todayISO()} onChange={(e) => setTo(e.target.value)} />
              </label>
              <button className="date-apply" onClick={apply}>
                Aplicar
              </button>
              {error && <div className="date-error">{error}</div>}
              <div className="date-menu-note">
                El presupuesto proyectado que se muestra es siempre el del mes en curso, sea cual sea el período.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
