"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "./PageChrome";
import { fetchJson } from "@/lib/clientFetch";
import { normAccountId } from "@/lib/matchKeys";
import type { Session } from "@/lib/access";
import type { SpendResponse } from "@/lib/types";
import type { Equivalencia } from "@/lib/equivalenciasCore";
import type { MaestroData } from "@/lib/maestroCore";
import type { EquivalenciaAudit } from "@/lib/equivalencias";

/**
 * Equivalencias: a qué cliente y proyecto de Superlum corresponde cada cuenta
 * publicitaria de Pulso. Es el paso previo a mandar los cortes de Finanzas a
 * Superlum y al P&L. Datos: /api/equivalencias (clientes y proyectos vienen del
 * Maestro de Superlum) y /api/spend (las cuentas de Pulso).
 */

interface EquivResponse {
  configured: boolean;
  maestro: MaestroData | null;
  warning: string | null;
  equivalencias: Equivalencia[];
  audit: EquivalenciaAudit[];
}

interface Draft {
  clienteId: string;
  proyectoId: string;
}

interface Cuenta {
  accountId: string;
  nombre: string;
  /** false si la cuenta tiene vínculo guardado pero Pulso ya no la trae. */
  enPulso: boolean;
}

const TZ = "America/Argentina/Buenos_Aires";
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clean = (err: any) => String(err?.message || err).replace(/^HTTP \d+ — /, "");
const AUDIT_VERB: Record<EquivalenciaAudit["action"], string> = { alta: "vinculó", cambio: "cambió el vínculo de", baja: "desvinculó" };

export default function EquivalenciasView({ session }: { session: Session }) {
  const [data, setData] = useState<EquivResponse | null>(null);
  const [spend, setSpend] = useState<SpendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spendError, setSpendError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ accountId: string; message: string } | null>(null);
  const [soloSinVincular, setSoloSinVincular] = useState(false);

  function load() {
    fetchJson<EquivResponse>("/api/equivalencias")
      .then((d) => {
        setData(d);
        setDrafts({});
      })
      .catch((err) => setError(clean(err)));
  }
  useEffect(load, []);
  useEffect(() => {
    fetchJson<SpendResponse>("/api/spend")
      .then(setSpend)
      .catch((err) => setSpendError(clean(err)));
  }, []);

  const byAccount = useMemo(() => new Map((data?.equivalencias ?? []).map((e) => [e.accountId, e])), [data]);

  const cuentas: Cuenta[] = useMemo(() => {
    const list = new Map<string, Cuenta>();
    for (const c of spend?.clients ?? []) {
      const id = normAccountId(c.accountId);
      if (id && !list.has(id)) list.set(id, { accountId: id, nombre: c.name, enPulso: true });
    }
    for (const e of data?.equivalencias ?? []) {
      if (!list.has(e.accountId)) list.set(e.accountId, { accountId: e.accountId, nombre: "(cuenta que Pulso ya no trae)", enPulso: false });
    }
    return [...list.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }, [spend, data]);

  const sinVincular = cuentas.filter((c) => !byAccount.has(c.accountId)).length;
  const visibles = soloSinVincular ? cuentas.filter((c) => !byAccount.has(c.accountId)) : cuentas;
  const maestro = data?.maestro ?? null;

  const savedDraft = (accountId: string): Draft => {
    const e = byAccount.get(accountId);
    return { clienteId: e?.clienteId ?? "", proyectoId: e?.proyectoId ?? "" };
  };

  async function save(accountId: string) {
    const d = drafts[accountId] ?? savedDraft(accountId);
    setBusy(accountId);
    setRowError(null);
    try {
      await fetchJson("/api/equivalencias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, clienteId: d.clienteId, proyectoId: d.proyectoId || null }),
      });
      load();
    } catch (err) {
      setRowError({ accountId, message: clean(err) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(accountId: string) {
    if (!window.confirm("¿Quitar el vínculo de esta cuenta con su cliente de Superlum?")) return;
    setBusy(accountId);
    setRowError(null);
    try {
      await fetchJson(`/api/equivalencias?accountId=${encodeURIComponent(accountId)}`, { method: "DELETE" });
      load();
    } catch (err) {
      setRowError({ accountId, message: clean(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="wrap">
      <PageHeader
        title="Pulso Ignite — Equivalencias"
        sub="A qué cliente y proyecto de Superlum corresponde cada cuenta publicitaria"
        session={session}
        current="equivalencias"
      />

      {error && (
        <div className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span> <span>No se pudo cargar /api/equivalencias: {error}</span>
        </div>
      )}
      {spendError && (
        <div className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span> <span>No se pudieron cargar las cuentas de Pulso: {spendError}</span>
        </div>
      )}
      {data && !data.configured && (
        <div className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span>{" "}
          <span>
            <b>El registro de equivalencias no está configurado.</b> Falta conectar Upstash Redis (KV_REST_API_URL y KV_REST_API_TOKEN).
          </span>
        </div>
      )}
      {data && !maestro && (
        <div className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span>{" "}
          <span>
            <b>No se pudo leer la lista de clientes de Superlum.</b> {data.warning}
          </span>
        </div>
      )}

      {data && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>
                Cuentas ({cuentas.length - sinVincular} de {cuentas.length} vinculadas)
              </h2>
              <div className="card-sub">
                Elegí el cliente de Superlum de cada cuenta y, si corresponde, el proyecto. Una cuenta tiene un solo cliente.
              </div>
            </div>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: "var(--text-primary)" }}>
              <input type="checkbox" checked={soloSinVincular} onChange={() => setSoloSinVincular(!soloSinVincular)} />
              Solo sin vincular ({sinVincular})
            </label>
          </div>
          <div className="table-scroll-x">
            <table className="datatable">
              <thead>
                <tr>
                  <th>Cuenta de Pulso</th>
                  <th>Cliente de Superlum</th>
                  <th>Proyecto</th>
                  <th>Última modificación</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((c) => {
                  const saved = byAccount.get(c.accountId);
                  const base = savedDraft(c.accountId);
                  const d = drafts[c.accountId] ?? base;
                  const changed = d.clienteId !== base.clienteId || d.proyectoId !== base.proyectoId;
                  const proyectos = (maestro?.proyectos ?? []).filter((p) => p.clienteId === d.clienteId);
                  const locked = busy !== null || !maestro || !data.configured;
                  const setDraft = (next: Draft) => setDrafts({ ...drafts, [c.accountId]: next });
                  return (
                    <tr key={c.accountId}>
                      <td>
                        {c.nombre}
                        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{c.accountId}</div>
                        {rowError?.accountId === c.accountId && <div className="alert-form-error">{rowError.message}</div>}
                      </td>
                      <td>
                        <select
                          aria-label={`Cliente de ${c.nombre}`}
                          value={d.clienteId}
                          disabled={locked}
                          onChange={(e) => setDraft({ clienteId: e.target.value, proyectoId: "" })}
                        >
                          <option value="">— sin vincular —</option>
                          {saved && !maestro?.clientes.some((x) => x.id === saved.clienteId) && (
                            <option value={saved.clienteId}>{saved.clienteNombre} (ya no figura en Superlum)</option>
                          )}
                          {(maestro?.clientes ?? []).map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.nombre}
                              {x.estado ? ` · ${x.estado}` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          aria-label={`Proyecto de ${c.nombre}`}
                          value={d.proyectoId}
                          disabled={locked || !d.clienteId}
                          onChange={(e) => setDraft({ ...d, proyectoId: e.target.value })}
                        >
                          <option value="">— sin proyecto —</option>
                          {proyectos.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.nombre}
                              {p.estado ? ` · ${p.estado}` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {saved ? `${fmtDateTime(saved.updatedAt)} · ${saved.updatedBy}` : "—"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="btn primary" disabled={locked || !d.clienteId || !changed} onClick={() => save(c.accountId)}>
                          {busy === c.accountId ? "Guardando…" : "Guardar"}
                        </button>{" "}
                        {saved && (
                          <button className="btn" disabled={locked} onClick={() => remove(c.accountId)}>
                            Quitar
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visibles.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ color: "var(--text-muted)" }}>
                      {spend ? "No hay cuentas para mostrar." : "Cargando cuentas…"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && data.audit.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Últimos cambios</h2>
              <div className="card-sub">Vínculos hechos, cambiados y quitados, con quién los hizo.</div>
            </div>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6, fontSize: 12.5 }}>
            {data.audit.map((a, i) => (
              <li key={i}>
                <span style={{ color: "var(--text-muted)" }}>{fmtDateTime(a.at)}</span> · <b>{a.by}</b> {AUDIT_VERB[a.action]} la cuenta <b>{a.accountId}</b>
                {a.action !== "baja" && (
                  <span style={{ color: "var(--text-muted)" }}>
                    {" "}
                    — {a.clienteNombre}
                    {a.proyectoNombre ? ` · ${a.proyectoNombre}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
