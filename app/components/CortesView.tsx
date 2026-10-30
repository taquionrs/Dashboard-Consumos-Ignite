"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "./PageChrome";
import { fetchJson } from "@/lib/clientFetch";
import type { Session } from "@/lib/access";
import type { Corte, CorteResumen } from "@/lib/cortesCore";

/**
 * Cortes de finanzas: una foto congelada del consumo de pauta de un período
 * (por cuenta y campaña), lista para mandarse a Superlum y al P&L. Acá se genera,
 * se lista y se mira. Datos: /api/cortes.
 */

interface ListResponse {
  configured: boolean;
  cortes: CorteResumen[];
  hayMas: boolean;
}

const PRESETS: { key: string; label: string }[] = [
  { key: "month", label: "Este mes (hasta hoy)" },
  { key: "lastmonth", label: "Mes pasado" },
  { key: "7d", label: "Últimos 7 días" },
  { key: "14d", label: "Últimos 14 días" },
  { key: "28d", label: "Últimos 28 días" },
];

const TZ = "America/Argentina/Buenos_Aires";
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDay = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("es-AR", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const fmtMoney = (n: number | null) => (n === null ? "—" : n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }));
const clean = (err: any) => String(err?.message || err).replace(/^HTTP \d+ — /, "");
const periodo = (c: { desde: string; hasta: string; dias: number }) =>
  c.desde === c.hasta ? fmtDay(c.desde) : `${fmtDay(c.desde)} → ${fmtDay(c.hasta)} (${c.dias} días)`;

export default function CortesView({ session }: { session: Session }) {
  const [list, setList] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState("month");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Corte | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  function load() {
    fetchJson<ListResponse>("/api/cortes")
      .then(setList)
      .catch((err) => setError(clean(err)));
  }
  useEffect(load, []);

  const custom = preset === "custom";

  async function generar() {
    setGenerating(true);
    setGenError(null);
    try {
      const body = custom ? { desde, hasta } : { preset };
      const r = await fetchJson<{ ok: true; corte: Corte }>("/api/cortes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setDetail(r.corte);
      load();
    } catch (err) {
      setGenError(clean(err));
    } finally {
      setGenerating(false);
    }
  }

  async function abrir(id: string) {
    setLoadingId(id);
    setGenError(null);
    try {
      const r = await fetchJson<{ corte: Corte }>(`/api/cortes?id=${encodeURIComponent(id)}`);
      setDetail(r.corte);
    } catch (err) {
      setGenError(clean(err));
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div className="wrap">
      <PageHeader title="Pulso Ignite — Cortes" sub="Foto congelada del consumo de pauta de un período, lista para Superlum y el P&L" session={session} current="cortes" />

      {error && (
        <div className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span> <span>No se pudo cargar /api/cortes: {error}</span>
        </div>
      )}
      {list && !list.configured && (
        <div className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span>{" "}
          <span>
            <b>El registro de cortes no está configurado.</b> Falta conectar Upstash Redis (KV_REST_API_URL y KV_REST_API_TOKEN).
          </span>
        </div>
      )}

      {list?.configured && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Generar corte</h2>
              <div className="card-sub">
                Elegí el período. El corte guarda el consumo real de cada cuenta y campaña, el presupuesto (si el período empieza el día 1 de este mes) y a qué
                cliente de Superlum corresponde cada cuenta. No se puede editar ni borrar después.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            {PRESETS.map((p) => (
              <button key={p.key} className="chip" aria-pressed={preset === p.key} disabled={generating} onClick={() => setPreset(p.key)}>
                {p.label}
              </button>
            ))}
            <button className="chip" aria-pressed={custom} disabled={generating} onClick={() => setPreset("custom")}>
              Fechas propias
            </button>
          </div>
          {custom && (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12, fontSize: 12.5 }}>
              <label>
                Desde <input type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} disabled={generating} />
              </label>
              <label>
                Hasta <input type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} disabled={generating} />
              </label>
              <span style={{ color: "var(--text-muted)" }}>Hasta 366 días. Una fecha futura se corta en hoy.</span>
            </div>
          )}
          {genError && <div className="alert-form-error">{genError}</div>}
          <div className="alert-actions">
            <button className="btn primary" disabled={generating || (custom && (!desde || !hasta))} onClick={generar}>
              {generating ? "Consultando Windsor… puede tardar hasta un minuto" : "Generar corte"}
            </button>
          </div>
        </section>
      )}

      {detail && <DetalleCorte corte={detail} onClose={() => setDetail(null)} />}

      {list?.configured && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Cortes generados ({list.cortes.length}{list.hayMas ? "+" : ""})</h2>
              <div className="card-sub">Los más nuevos primero. Si hay dos del mismo período, vale el más nuevo.</div>
            </div>
          </div>
          <div className="table-scroll-x">
            <table className="datatable">
              <thead>
                <tr>
                  <th>Período</th>
                  <th>Generado</th>
                  <th className="num">Consumo real</th>
                  <th className="num">Presupuesto</th>
                  <th className="num">Cuentas</th>
                  <th className="num">Sin vincular</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.cortes.map((c) => (
                  <tr key={c.id}>
                    <td>{periodo(c)}</td>
                    <td style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {fmtDateTime(c.generadoEn)} · {c.generadoPor}
                    </td>
                    <td className="num">{fmtMoney(c.totales.real)}</td>
                    <td className="num">{fmtMoney(c.totales.presupuesto)}</td>
                    <td className="num">{c.cuentas}</td>
                    <td className="num">{c.totales.cuentasSinVincular}</td>
                    <td>
                      <button className="btn" disabled={loadingId !== null} onClick={() => abrir(c.id)}>
                        {loadingId === c.id ? "Abriendo…" : "Ver"}
                      </button>
                    </td>
                  </tr>
                ))}
                {list.cortes.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ color: "var(--text-muted)" }}>
                      Todavía no hay cortes. Generá el primero arriba.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function DetalleCorte({ corte, onClose }: { corte: Corte; onClose: () => void }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Corte {periodo(corte)}</h2>
          <div className="card-sub">
            Generado {fmtDateTime(corte.generadoEn)} por {corte.generadoPor} · datos de Windsor al {fmtDateTime(corte.datosAl)}
          </div>
        </div>
        <button className="btn" onClick={onClose}>
          Cerrar
        </button>
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12, fontSize: 13 }}>
        <span>
          Consumo real <b>{fmtMoney(corte.totales.real)}</b>
        </span>
        <span>
          Presupuesto <b>{fmtMoney(corte.totales.presupuesto)}</b>
        </span>
        <span>
          Remanente <b>{fmtMoney(corte.totales.remanente)}</b>
        </span>
        <span>
          Total presupuesto manual <b>{fmtMoney(corte.totales.presupuestoManual)}</b>
        </span>
      </div>
      {corte.avisos.length > 0 && (
        <ul style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 12.5, color: "var(--text-muted)" }}>
          {corte.avisos.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
      <div className="table-scroll-x">
        <table className="datatable">
          <thead>
            <tr>
              <th>Cuenta</th>
              <th>Cliente · Proyecto (Superlum)</th>
              <th className="num">Presupuesto</th>
              <th className="num">Real</th>
              <th className="num">Remanente</th>
              <th className="num">Ritmo</th>
              <th className="num">Campañas</th>
            </tr>
          </thead>
          <tbody>
            {corte.cuentas.map((c) => (
              <tr key={c.accountId}>
                <td>
                  {c.nombre}
                  <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{c.accountId}</div>
                </td>
                <td>
                  {c.vinculo ? (
                    <>
                      {c.vinculo.clienteNombre}
                      {c.vinculo.proyectoNombre ? <span style={{ color: "var(--text-muted)" }}> · {c.vinculo.proyectoNombre}</span> : null}
                    </>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>sin vincular</span>
                  )}
                </td>
                <td className="num">{fmtMoney(c.presupuesto)}</td>
                <td className="num">{fmtMoney(c.real)}</td>
                <td className="num">{fmtMoney(c.remanente)}</td>
                <td className="num">{c.ritmoPct === null ? "—" : `${Math.round(c.ritmoPct)}%`}</td>
                <td className="num">{c.campanas.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
