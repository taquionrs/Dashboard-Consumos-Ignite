"use client";

import { useEffect, useRef, useState } from "react";
import { AREA_LABEL, NOVEDADES, TIPO_LABEL, countUnseen, isUnseen } from "@/lib/novedades";

/**
 * Campanita de novedades del encabezado: un puntito con la cantidad de cosas que
 * todavía no se vieron y, al tocarla, el panel con los cambios (lib/novedades.ts).
 *
 * "Lo que ya viste" se recuerda en ESTE navegador (localStorage), no por usuario.
 * Si el navegador no permite guardar, la campanita
 * funciona igual (siempre muestra todo como nuevo).
 */

const SEEN_KEY = "pulso.novedades.visto";

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}
function writeSeen(id: string) {
  try {
    window.localStorage.setItem(SEEN_KEY, id);
  } catch {
    // sin almacenamiento local: no se recuerda lo visto
  }
}

const fmtFecha = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("es-AR", { day: "numeric", month: "long" });
};

export default function NovedadesBell() {
  const [seenId, setSeenId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  // Qué se había visto cuando se abrió el panel: así se marca lo nuevo aunque el puntito ya se apague.
  const [seenAtOpen, setSeenAtOpen] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSeenId(readSeen());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const newest = NOVEDADES[0]?.id ?? null;
  // Antes de leer el navegador no se muestra el número (evita un parpadeo y diferencias con el servidor).
  const unseen = ready ? countUnseen(seenId, NOVEDADES) : 0;

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setSeenAtOpen(seenId);
    setOpen(true);
    if (newest) {
      writeSeen(newest);
      setSeenId(newest);
    }
  }

  return (
    <div className="novedades-wrap" ref={wrapRef}>
      <button
        type="button"
        className="novedades-btn"
        onClick={toggle}
        aria-label={unseen > 0 ? `Novedades de Pulso: ${unseen} sin ver` : "Novedades de Pulso"}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Novedades de Pulso"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unseen > 0 && <span className="novedades-badge">{unseen > 9 ? "9+" : unseen}</span>}
      </button>

      {open && (
        <div className="novedades-panel" role="dialog" aria-label="Novedades de Pulso">
          <div className="novedades-head">
            <b>Novedades de Pulso</b>
            <button type="button" className="novedades-close" onClick={() => setOpen(false)} aria-label="Cerrar">
              ×
            </button>
          </div>
          <ul className="novedades-list">
            {NOVEDADES.map((n) => {
              const fresh = isUnseen(n.id, seenAtOpen, NOVEDADES);
              return (
                <li key={n.id} className={"novedad" + (fresh ? " fresh" : "")}>
                  <div className="novedad-meta">
                    <span className={"novedad-tipo " + n.tipo}>{TIPO_LABEL[n.tipo]}</span>
                    <span>{AREA_LABEL[n.area]}</span>
                    <span>·</span>
                    <span>{fmtFecha(n.fecha)}</span>
                    {fresh && <span className="novedad-new">Sin ver</span>}
                  </div>
                  <div className="novedad-titulo">{n.titulo}</div>
                  <div className="novedad-detalle">{n.detalle}</div>
                  {n.ruta && (
                    <a className="novedad-ir" href={n.ruta}>
                      Ir a la pantalla →
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
