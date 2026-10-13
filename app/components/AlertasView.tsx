"use client";

import { MediosHeader, MediosSubnav } from "./PageChrome";
import type { Session } from "@/lib/access";
import { ErrorPanel, LoadingPanel, announceReady } from "./StatusUI";
import { useEffect, useMemo, useState } from "react";
import { fetchJson } from "@/lib/clientFetch";
import { ALERT_TYPE_LABEL, STATUS_LABEL, type AlertRecord, type AlertType, type ModerationStatus, type RunRecord } from "@/lib/alertTypes";

/**
 * Centro de trazabilidad de alertas de Medios/Ignite: registro de cada alerta
 * que envió el cron (martes y jueves, 8:00 hs) para que el analista o el
 * gerente de Medios las revise, las marque como revisadas o las descarte con
 * un motivo. Nada se borra: cada cambio queda en el historial de la alerta.
 *
 * Los datos salen de GET /api/alerts; la moderación va a PATCH /api/alerts/<id>.
 * "Quién modera" es la cuenta del SSO: la pone el servidor, no se escribe acá
 * (ver app/api/alerts/[id]/route.ts).
 */

interface LogResponse {
  configured: boolean;
  alerts: AlertRecord[];
  runs: RunRecord[];
  error?: string;
}

const TZ = "America/Argentina/Buenos_Aires";
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtShort = (iso: string) => new Date(iso).toLocaleDateString("es-AR", { timeZone: TZ, day: "numeric", month: "short" });

type StatusFilter = "all" | ModerationStatus;
const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "Todas" },
  { key: "pending", label: "Pendientes" },
  { key: "reviewed", label: "Revisadas" },
  { key: "dismissed", label: "Descartadas" },
];

interface Group {
  runId: string;
  sentAt: string;
  run?: RunRecord;
  alerts: AlertRecord[];
}

export default function AlertasView({ session }: { session: Session }) {
  const [data, setData] = useState<LogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | AlertType>("all");
  const [query, setQuery] = useState("");
  const [openMessages, setOpenMessages] = useState<Set<string>>(new Set());
  const [openHistory, setOpenHistory] = useState<Set<string>>(new Set());
  const [moderating, setModerating] = useState<{ id: string; status: ModerationStatus } | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    setData(null);
    setError(null);
    fetchJson<LogResponse>("/api/alerts")
      .then((body) => {
        if (cancelled) return;
        setData(body);
        announceReady("Alertas cargadas", startedAt);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message || err));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const alerts = data?.alerts ?? [];
  const runs = data?.runs ?? [];

  const counts = useMemo(() => {
    const c = { total: alerts.length, pending: 0, reviewed: 0, dismissed: 0 };
    for (const a of alerts) c[a.status]++;
    return c;
  }, [alerts]);

  // Cuántas veces apareció la misma alerta (misma huella) en envíos distintos.
  const recurrence = useMemo(() => {
    const byFp = new Map<string, AlertRecord[]>();
    for (const a of alerts) byFp.set(a.fingerprint, [...(byFp.get(a.fingerprint) ?? []), a]);
    for (const list of byFp.values()) list.sort((x, y) => x.sentAt.localeCompare(y.sentAt));
    return byFp;
  }, [alerts]);

  const filtering = statusFilter !== "all" || typeFilter !== "all" || query.trim() !== "";
  const groups: Group[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = alerts.filter(
      (a) =>
        (statusFilter === "all" || a.status === statusFilter) &&
        (typeFilter === "all" || a.type === typeFilter) &&
        (!q || (a.title + " " + a.lines.join(" ")).toLowerCase().includes(q))
    );
    const byRun = new Map<string, AlertRecord[]>();
    for (const a of visible) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a]);
    const out: Group[] = [];
    const seen = new Set<string>();
    for (const r of runs) {
      seen.add(r.id);
      const list = byRun.get(r.id) ?? [];
      if (list.length > 0 || !filtering) out.push({ runId: r.id, sentAt: r.sentAt, run: r, alerts: list });
    }
    // Alertas de envíos más viejos que los que lista la API: se agrupan igual.
    for (const [runId, list] of byRun) if (!seen.has(runId)) out.push({ runId, sentAt: list[0].sentAt, alerts: list });
    return out.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  }, [alerts, runs, statusFilter, typeFilter, query, filtering]);

  function toggle(set: Set<string>, id: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  function startModerate(a: AlertRecord, status: ModerationStatus) {
    setModerating({ id: a.id, status });
    setNote("");
    setFormError(null);
  }

  async function submitModeration() {
    if (!moderating) return;
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetchJson<{ ok: boolean; alert: AlertRecord }>(`/api/alerts/${moderating.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: moderating.status, note }),
      });
      setData((prev) => (prev ? { ...prev, alerts: prev.alerts.map((x) => (x.id === res.alert.id ? res.alert : x)) } : prev));
      setModerating(null);
    } catch (err: any) {
      setFormError(String(err?.message || err).replace(/^HTTP \d+ — /, ""));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wrap">
      <MediosHeader sub="Alertas enviadas: trazabilidad y moderación — equipo Medios, Taquión" session={session} />
      <MediosSubnav current="/medios/alertas" session={session} />

      {error && <ErrorPanel what="Alertas" detail={error} onRetry={() => setReloadKey((k) => k + 1)} />}
      {!error && !data && <LoadingPanel what="el registro de alertas" />}

      {data && !data.configured && (
        <div className="alerts-setup">
          <h2>Falta activar el registro de alertas</h2>
          <p>
            El resumen se sigue enviando al espacio IGNITE, pero todavía no hay dónde guardar cada alerta para trazarla. Se activa en 2 minutos:
          </p>
          <ol>
            <li>En Vercel, abrí el proyecto → <b>Storage</b> → <b>Create Database</b> → <b>Upstash Redis</b> (plan gratuito).</li>
            <li>Conectala a este proyecto (entornos Production y Preview). Vercel agrega solo las variables <code>KV_REST_API_URL</code> y <code>KV_REST_API_TOKEN</code>.</li>
            <li>Hacé un <b>Redeploy</b> de producción.</li>
          </ol>
          <p>Desde el próximo envío del resumen, cada alerta queda registrada acá.</p>
        </div>
      )}

      {data && data.configured && (
        <>
          <div className="alerts-summary">
            <div className="stat-chip"><span className="stat-label">Registradas</span><span className="stat-value num">{counts.total}</span></div>
            <div className="stat-chip"><span className="stat-label">Pendientes</span><span className="stat-value num">{counts.pending}</span></div>
            <div className="stat-chip"><span className="stat-label">Revisadas</span><span className="stat-value num">{counts.reviewed}</span></div>
            <div className="stat-chip"><span className="stat-label">Descartadas</span><span className="stat-value num">{counts.dismissed}</span></div>
          </div>

          <div className="alerts-filters">
            <div className="chip-row" role="group" aria-label="Filtrar por estado">
              {STATUS_FILTERS.map((f) => (
                <button key={f.key} className="chip" aria-pressed={statusFilter === f.key} onClick={() => setStatusFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <select className="alerts-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as "all" | AlertType)} aria-label="Filtrar por tipo">
              <option value="all">Todos los tipos</option>
              {(Object.keys(ALERT_TYPE_LABEL) as AlertType[]).map((t) => (
                <option key={t} value={t}>{ALERT_TYPE_LABEL[t]}</option>
              ))}
            </select>
            <input className="alerts-search" type="search" placeholder="Buscar campaña, anuncio o cuenta…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>

          {runs.length === 0 && alerts.length === 0 && (
            <div className="loading-state">Todavía no se registró ningún envío. El próximo resumen (martes o jueves, 8:00 hs) va a aparecer acá.</div>
          )}
          {groups.length === 0 && (runs.length > 0 || alerts.length > 0) && <div className="loading-state">Ninguna alerta coincide con los filtros.</div>}

          {groups.map((g) => (
            <section className="alert-run" key={g.runId}>
              <div className="alert-run-head">
                <div>
                  <div className="alert-run-title">📊 {cap(g.run?.dateLabel ?? fmtDateTime(g.sentAt))}</div>
                  <div className="alert-run-sub">
                    Enviado {fmtDateTime(g.sentAt)} · {g.run ? (g.run.alertCount === 0 ? "sin alertas" : `${g.run.alertCount} alerta${g.run.alertCount === 1 ? "" : "s"}`) : "envío anterior"}
                    {g.run?.windowLabel ? ` · ${g.run.windowLabel}` : ""}
                  </div>
                </div>
                {g.run && (
                  <div className="alert-deliveries">
                    {g.run.deliveries.map((d) => (
                      <span key={d.channel} className={"pill " + (d.ok ? "good" : "critical")} title={d.detail}>
                        <span className="dot" />
                        {d.channel === "googleChat" ? "Google Chat" : "Email"}
                        {d.detail ? ` · ${d.detail}` : ""}
                      </span>
                    ))}
                    {g.run.messages.length > 0 && (
                      <button type="button" className="link-btn" onClick={() => toggle(openMessages, g.runId, setOpenMessages)}>
                        {openMessages.has(g.runId) ? "Ocultar mensaje enviado" : "Ver mensaje enviado"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {g.run && g.run.unavailable.length > 0 && (
                <div className="alert-unavailable">⚠️ Datos que no se pudieron obtener en este envío: {g.run.unavailable.join(" · ")}</div>
              )}
              {g.run && openMessages.has(g.runId) && (
                <pre className="alert-messages">{g.run.messages.join("\n\n— — — — —\n\n")}</pre>
              )}

              {g.alerts.length === 0 && !filtering && <div className="alert-none">✅ Este envío no tuvo alertas.</div>}

              {g.alerts.map((a) => {
                const list = recurrence.get(a.fingerprint) ?? [a];
                const rank = list.findIndex((x) => x.id === a.id) + 1;
                const isModerating = moderating?.id === a.id;
                return (
                  <article className={"alert-card " + a.status} key={a.id}>
                    <div className="alert-head">
                      <span className={"pill " + (a.severity === "critical" ? "critical" : "warning")}>
                        <span className="dot" />
                        {a.severity === "critical" ? "Crítica" : "Atención"}
                      </span>
                      <span className="alert-type">{ALERT_TYPE_LABEL[a.type]}</span>
                      <span className={"pill status-" + a.status}>
                        <span className="dot" />
                        {STATUS_LABEL[a.status]}
                      </span>
                    </div>
                    <div className="alert-title">{a.title}</div>
                    {a.lines.map((l, i) => (
                      <div className="alert-line" key={i}>{l}</div>
                    ))}

                    <div className="alert-meta">
                      {list.length > 1 && (
                        <span title="Misma alerta en envíos distintos">
                          🔁 Se repite: {rank}.ª vez de {list.length} (desde {fmtShort(list[0].sentAt)})
                        </span>
                      )}
                      {!a.listed && <span title="Se detectó, pero quedó fuera de la lista del mensaje por el límite de filas">📋 No figuró en el mensaje (límite de filas)</span>}
                    </div>

                    {a.status !== "pending" && (
                      <div className="alert-review">
                        {a.status === "reviewed" ? "✔ Revisada" : "✖ Descartada"} por <b>{a.reviewedBy}</b>
                        {a.reviewedAt ? ` · ${fmtDateTime(a.reviewedAt)}` : ""}
                        {a.note && <div className="alert-note">“{a.note}”</div>}
                      </div>
                    )}

                    {!isModerating && (
                      <div className="alert-actions">
                        {a.status !== "reviewed" && <button className="btn" onClick={() => startModerate(a, "reviewed")}>Marcar revisada</button>}
                        {a.status !== "dismissed" && <button className="btn" onClick={() => startModerate(a, "dismissed")}>Descartar</button>}
                        {a.status !== "pending" && <button className="btn" onClick={() => startModerate(a, "pending")}>Reabrir</button>}
                        {a.history.length > 0 && (
                          <button type="button" className="link-btn" onClick={() => toggle(openHistory, a.id, setOpenHistory)}>
                            {openHistory.has(a.id) ? "Ocultar historial" : `Historial (${a.history.length})`}
                          </button>
                        )}
                      </div>
                    )}

                    {openHistory.has(a.id) && (
                      <ul className="alert-history">
                        {[...a.history].reverse().map((h, i) => (
                          <li key={i}>
                            {fmtDateTime(h.at)} · <b>{h.by}</b>: {STATUS_LABEL[h.from]} → {STATUS_LABEL[h.to]}
                            {h.note ? ` — “${h.note}”` : ""}
                          </li>
                        ))}
                      </ul>
                    )}

                    {isModerating && moderating && (
                      <div className="alert-form">
                        <div className="alert-form-title">
                          {moderating.status === "reviewed" ? "Marcar como revisada" : moderating.status === "dismissed" ? "Descartar alerta" : "Reabrir alerta"}
                        </div>
                        <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                          Queda registrado como <b>{session.email}</b>
                        </div>
                        <label>
                          Nota {moderating.status === "dismissed" ? "(obligatoria: ¿por qué se descarta?)" : "(opcional)"}
                          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
                        </label>
                        {formError && <div className="alert-form-error">{formError}</div>}
                        <div className="alert-actions">
                          <button className="btn primary" disabled={saving} onClick={submitModeration}>{saving ? "Guardando…" : "Guardar"}</button>
                          <button className="btn" disabled={saving} onClick={() => setModerating(null)}>Cancelar</button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
