"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SOPORTE } from "@/lib/soporte";

/**
 * Estados de las pantallas de Pulso: cargando (con etapas), error con a quién avisar,
 * y el "Listo" cuando termina de cargar algo que tardó.
 */

export type SourceState = "loading" | "done" | "error";
export interface SourceStatus {
  label: string;
  state: SourceState;
}

function useElapsedSeconds(): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setS((Date.now() - t0) / 1000), 500);
    return () => clearInterval(id);
  }, []);
  return s;
}

function stageFor(seconds: number, what: string): { title: string; detail: string } {
  if (seconds < 3) return { title: `Cargando ${what}…`, detail: "Estamos pidiendo los datos." };
  if (seconds < 10) return { title: "En proceso…", detail: `Consultando las plataformas para traer ${what}.` };
  if (seconds < 25) return { title: "Ya casi…", detail: "La primera consulta de un período nuevo puede tardar un poco más." };
  return { title: "Está tardando más de lo habitual", detail: "Seguimos intentando. Si no carga, te vamos a avisar acá con qué hacer." };
}

/**
 * Carga en curso: dice qué se está cargando, en qué etapa va, qué fuente ya llegó y
 * cuál falta. `children` es el esqueleto de la pantalla (opcional).
 */
export function LoadingPanel({ what, sources, children }: { what: string; sources?: SourceStatus[]; children?: ReactNode }) {
  const seconds = useElapsedSeconds();
  const stage = stageFor(seconds, what);
  const pct = Math.min(92, Math.round(100 * (1 - Math.exp(-seconds / 12))));
  return (
    <>
      <div className="status-panel" role="status" aria-live="polite">
        <div className="status-head">
          <span className="status-spinner" aria-hidden="true" />
          <div>
            <div className="status-title">{stage.title}</div>
            <div className="status-detail">{stage.detail}</div>
          </div>
        </div>
        <div className="status-bar" aria-hidden="true">
          <div className="status-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        {sources && sources.length > 0 && (
          <div className="status-sources">
            {sources.map((s) => (
              <span key={s.label} className={"status-source " + s.state}>
                {s.state === "done" ? "✓ " : s.state === "error" ? "✕ " : "… "}
                {s.label}
                <span className="status-source-state">{s.state === "done" ? " listo" : s.state === "error" ? " con problemas" : " en proceso"}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {children}
    </>
  );
}

/**
 * Cartel de falla: qué pasó, a quién avisar y cuánto se estima que tarda el arreglo.
 * `detail` es el texto técnico (queda en un desplegable y viaja en el email).
 */
export function ErrorPanel({ what, detail, onRetry, compact }: { what: string; detail?: string; onRetry?: () => void; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const here = typeof window !== "undefined" ? window.location.href : "";
  const subject = `Pulso: falló ${what}`;
  const body = [
    `Hola ${SOPORTE.nombre.split(" ")[0]},`,
    ``,
    `En Pulso falló la pantalla de ${what}.`,
    `Pantalla: ${here}`,
    `Hora: ${new Date().toLocaleString("es-AR")}`,
    detail ? `Detalle: ${detail}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const mailto = `mailto:${SOPORTE.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // sin permiso de portapapeles: el detalle sigue visible en el desplegable
    }
  }

  return (
    <div className={"error-panel" + (compact ? " compact" : "")} role="alert">
      <div className="error-title">Ups, algo falló</div>
      <p>
        No pudimos cargar <b>{what}</b>. Contactá a <b>{SOPORTE.nombre}</b> por email o por mensaje de Gmail
        {" "}(<a href={mailto}>{SOPORTE.email}</a>).
      </p>
      <p>
        Luego de tu aviso, estimamos que en <b>{SOPORTE.tiempoEstimado}</b> podemos volver a tener esta pantalla solucionada. De lo
        contrario, {SOPORTE.nombre.split(" ")[0]} te avisa.
      </p>
      <div className="error-actions">
        {onRetry && (
          <button type="button" className="btn-primary" onClick={onRetry}>
            Reintentar
          </button>
        )}
        <a className="btn-secondary" href={mailto}>
          Avisar por email
        </a>
        {detail && (
          <button type="button" className="btn-secondary" onClick={copy}>
            {copied ? "Copiado" : "Copiar detalle"}
          </button>
        )}
      </div>
      {detail && (
        <details className="error-detail">
          <summary>Detalle técnico (para {SOPORTE.nombre.split(" ")[0]})</summary>
          <code>{detail}</code>
        </details>
      )}
    </div>
  );
}

/** Aviso corto "Listo" al terminar de cargar algo que tardó (lo muestra ReadyToastHost). */
export function announceReady(what: string, startedAt: number, minMs = 1500) {
  if (typeof window === "undefined") return;
  if (Date.now() - startedAt < minMs) return;
  window.dispatchEvent(new CustomEvent("pulso:ready", { detail: { what } }));
}

export function ReadyToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function onReady(e: Event) {
      const what = (e as CustomEvent<{ what: string }>).detail?.what ?? "Pulso";
      setMsg(`Listo 🙌🏻 ✅ ${what}`);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 3000);
    }
    window.addEventListener("pulso:ready", onReady);
    return () => {
      window.removeEventListener("pulso:ready", onReady);
      if (timer) clearTimeout(timer);
    };
  }, []);
  if (!msg) return null;
  return (
    <div className="ready-toast" role="status" aria-live="polite">
      {msg}
    </div>
  );
}
