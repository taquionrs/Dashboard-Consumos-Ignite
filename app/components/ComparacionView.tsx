"use client";

import { fetchJson } from "@/lib/clientFetch";
import { MediosHeader, MediosSubnav } from "./PageChrome";
import type { Session } from "@/lib/access";
import { ErrorPanel, LoadingPanel, announceReady } from "./StatusUI";
import { useEffect, useRef, useState } from "react";
import type { PlatformComparisonResponse, PlatformKey } from "@/lib/types";

const PLATFORM_VAR: Partial<Record<PlatformKey, string>> = {
  google: "--plat-google",
  meta: "--plat-meta",
  tiktok: "--plat-tiktok",
  linkedin: "--plat-linkedin",
};

type DatePreset = "today" | "yesterday" | "7d" | "14d" | "28d" | "month" | "lastmonth" | "custom";
const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: "today", label: "Hoy" },
  { key: "yesterday", label: "Ayer" },
  { key: "7d", label: "Últimos 7 días" },
  { key: "14d", label: "Últimos 14 días" },
  { key: "28d", label: "Últimos 28 días" },
  { key: "month", label: "Este mes" },
  { key: "lastmonth", label: "Mes anterior" },
];

function fmtMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString("es-AR");
}
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("es-AR");
}

export default function ComparacionView({ session }: { session: Session }) {
  const [datePreset, setDatePreset] = useState<DatePreset>("month");
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState<PlatformComparisonResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dateMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dateMenuOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (dateMenuRef.current && !dateMenuRef.current.contains(e.target as Node)) {
        setDateMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [dateMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    setData(null);
    setError(null);
    const range = datePreset === "custom" ? "month" : datePreset;
    fetchJson<any>(`/api/platform-comparison?range=${range}`)
      .then((body: PlatformComparisonResponse) => {
        if (cancelled) return;
        setData(body);
        announceReady("Comparación cargada", startedAt);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message || err));
      });
    return () => {
      cancelled = true;
    };
  }, [datePreset, reloadKey]);

  const loading = !data && !error;
  const platforms = data?.platforms ?? [];
  const dateLabel = DATE_PRESETS.find((d) => d.key === datePreset)?.label ?? "Este mes";
  const platformsWithCpl = platforms.filter((p) => p.cpl > 0);
  const maxCpl = Math.max(1, ...platformsWithCpl.map((p) => p.cpl));
  const cheapest = platformsWithCpl.length > 1 ? [...platformsWithCpl].sort((a, b) => a.cpl - b.cpl)[0] : undefined;
  const priciest = platformsWithCpl.length > 1 ? [...platformsWithCpl].sort((a, b) => b.cpl - a.cpl)[0] : undefined;

  return (
    <div className="wrap">
      <MediosHeader sub="¿Dónde está rindiendo mejor la inversión? — equipo Medios, Taquión" session={session} />
      <MediosSubnav current="/medios/comparacion" session={session} />

      {data?.warnings?.map((w, i) => (
        <div className="mock-note" key={i}>
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span> <span>{w}</span>
        </div>
      ))}
      {data?.source === "mock" && !data.warnings && (
        <div className="mock-note">
          <span className="tq-arrow">↘</span>{" "}
          <span>
            <b>Datos de ejemplo.</b> En cuanto haya cuentas reales conectadas en Windsor.ai, se comparan acá.
          </span>
        </div>
      )}

      <div className="controls-row">
        <div className="controls-left">
          <div className="dropdown-wrap" ref={dateMenuRef}>
            <button className="chip" aria-expanded={dateMenuOpen} onClick={() => setDateMenuOpen((v) => !v)}>
              {dateLabel} <span style={{ fontSize: 10 }}>▾</span>
            </button>
            {dateMenuOpen && (
              <div className="date-menu" role="menu">
                {DATE_PRESETS.map((d) => (
                  <button
                    key={d.key}
                    role="menuitem"
                    aria-current={datePreset === d.key}
                    onClick={() => {
                      setDatePreset(d.key);
                      setDateMenuOpen(false);
                    }}
                  >
                    {d.label}
                  </button>
                ))}
                <div className="date-menu-divider" />
                <div className="date-menu-note">
                  Windsor.ai sincroniza una vez al día — &quot;Hoy&quot; y &quot;Ayer&quot; pueden no reflejar todavía la
                  sincronización más reciente.
                </div>
                <div className="date-menu-divider" />
                <button role="menuitem" aria-current={datePreset === "custom"} onClick={() => setDatePreset("custom")}>
                  Personalizado <span style={{ fontSize: 10 }}>{datePreset === "custom" ? "▴" : "▸"}</span>
                </button>
                {datePreset === "custom" && (
                  <div className="date-custom">
                    <label>
                      Desde
                      <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                    </label>
                    <label>
                      Hasta
                      <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                    </label>
                    <button className="date-apply" onClick={() => setDateMenuOpen(false)}>
                      Aplicar
                    </button>
                    <div className="date-menu-note">
                      El rango se guarda, pero todavía no hay histórico real conectado — sigue mostrando &quot;Este mes&quot;.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {loading && <LoadingPanel what="la comparación de plataformas" />}
      {error && <ErrorPanel what="Comparación de plataformas" detail={error} onRetry={() => setReloadKey((k) => k + 1)} />}

      {data && (
      <>
      <div className="card">
        <h2>Costo por resultado (CPL), por plataforma</h2>
        <div className="card-sub">Barra más corta = más eficiente. Sin conversiones en el período, la plataforma no entra en el gráfico.</div>
        {platformsWithCpl.length === 0 ? (
          <div style={{ color: "var(--text-muted)", marginTop: 14 }}>Ninguna plataforma tuvo conversiones en este período.</div>
        ) : (
          <div style={{ marginTop: 14 }}>
            {platformsWithCpl.map((p) => (
              <div className="plat-compare-row" key={p.platformKey}>
                <div className="plat-compare-label">
                  <span className="plat-dot" style={{ background: `var(${PLATFORM_VAR[p.platformKey] ?? "--accent"})` }} />
                  {p.label}
                </div>
                <div className="plat-compare-track">
                  <div
                    className="plat-compare-fill"
                    style={{ width: `${(p.cpl / maxCpl) * 100}%`, background: `var(${PLATFORM_VAR[p.platformKey] ?? "--accent"})` }}
                  />
                </div>
                <div className="plat-compare-cpl num">{fmtMoney(p.cpl)}</div>
              </div>
            ))}
          </div>
        )}
        {cheapest && priciest && cheapest.platformKey !== priciest.platformKey && (
          <div className="insight-box">
            <b>{cheapest.label}</b> tiene el CPL más bajo este período — {fmtMoney(priciest.cpl - cheapest.cpl)} menos que{" "}
            <b>{priciest.label}</b>.
          </div>
        )}
      </div>

      <div className="card">
        <h2>Resumen por plataforma</h2>
        <div className="table-scroll-x" style={{ marginTop: 10 }}>
          <table className="dense">
            <thead>
              <tr>
                <th>Plataforma</th>
                <th className="num">Gasto</th>
                <th className="num">Conversiones</th>
                <th className="num">CPL</th>
              </tr>
            </thead>
            <tbody>
              {platforms.map((p) => (
                <tr key={p.platformKey}>
                  <td>
                    <span className="plat-dot" style={{ background: `var(${PLATFORM_VAR[p.platformKey] ?? "--accent"})` }} />
                    {p.label}
                  </td>
                  <td className="num">{fmtMoney(p.spend)}</td>
                  <td className="num">{fmtInt(p.conversions)}</td>
                  <td className="num">{p.cpl > 0 ? fmtMoney(p.cpl) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}

      <footer className="foot">
        <span>Fuente de datos: {data?.source === "mock" ? "mock" : "Windsor.ai (en vivo)"}</span>
        <span>Perfil Medios — comparación entre plataformas conectadas</span>
      </footer>
    </div>
  );
}
