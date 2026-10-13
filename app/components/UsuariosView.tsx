"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "./PageChrome";
import { fetchJson } from "@/lib/clientFetch";
import { PAGES, PROFILES, type PageKey, type Session } from "@/lib/access";
import type { AuditEntry, UserRecord } from "@/lib/users";

/**
 * Gestión de usuarios (solo administradores): quién entra a Pulso y a qué
 * páginas. Cloudflare deja iniciar sesión a cualquier cuenta @taquion.com.ar;
 * lo que ve cada una lo define esta pantalla. Datos: /api/users.
 */

interface UsersResponse {
  configured: boolean;
  users: UserRecord[];
  audit: AuditEntry[];
  fixedAdmins: string[];
  domains: string[];
}

interface Draft {
  pages: PageKey[];
  admin: boolean;
}

const TZ = "America/Argentina/Buenos_Aires";
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const sameDraft = (a: Draft, b: Draft) => a.admin === b.admin && a.pages.join() === b.pages.join();
const toggle = (pages: PageKey[], key: PageKey) =>
  PAGES.map((p) => p.key).filter((k) => (k === key ? !pages.includes(k) : pages.includes(k)));
const pagesLabel = (pages: PageKey[] = []) => PAGES.filter((p) => pages.includes(p.key)).map((p) => p.label).join(", ") || "ninguna página";

const AUDIT_VERB: Record<AuditEntry["action"], string> = { alta: "dio de alta a", cambio: "cambió el acceso de", baja: "quitó a" };

export default function UsuariosView({ session }: { session: Session }) {
  const [data, setData] = useState<UsersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ email: string; message: string } | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newDraft, setNewDraft] = useState<Draft>({ pages: [], admin: false });
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    fetchJson<UsersResponse>("/api/users")
      .then((d) => {
        setData(d);
        setDrafts({});
      })
      .catch((err) => setError(String(err?.message || err)));
  }
  useEffect(load, []);

  async function save(email: string, draft: Draft) {
    await fetchJson("/api/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, ...draft }),
    });
    load();
  }

  async function saveRow(email: string) {
    setBusy(email);
    setRowError(null);
    try {
      await save(email, drafts[email]);
    } catch (err: any) {
      setRowError({ email, message: String(err?.message || err).replace(/^HTTP \d+ — /, "") });
    } finally {
      setBusy(null);
    }
  }

  async function removeRow(email: string) {
    if (!window.confirm(`¿Quitar el acceso de ${email} a Pulso?`)) return;
    setBusy(email);
    setRowError(null);
    try {
      await fetchJson(`/api/users?email=${encodeURIComponent(email)}`, { method: "DELETE" });
      load();
    } catch (err: any) {
      setRowError({ email, message: String(err?.message || err).replace(/^HTTP \d+ — /, "") });
    } finally {
      setBusy(null);
    }
  }

  async function addUser() {
    const email = newEmail.trim().toLowerCase();
    setFormError(null);
    if (data?.users.some((u) => u.email === email) || data?.fixedAdmins.includes(email)) {
      setFormError("Ese usuario ya está en la lista: cambiá su acceso desde la tabla.");
      return;
    }
    setBusy("__new__");
    try {
      await save(email, newDraft);
      setNewEmail("");
      setNewDraft({ pages: [], admin: false });
    } catch (err: any) {
      setFormError(String(err?.message || err).replace(/^HTTP \d+ — /, ""));
    } finally {
      setBusy(null);
    }
  }

  const domains = (data?.domains ?? ["taquion.com.ar"]).map((d) => "@" + d).join(" o ");

  return (
    <div className="wrap">
      <PageHeader title="Pulso Ignite — Usuarios" sub="Quién entra a Pulso y a qué páginas — solo administradores" session={session} current="usuarios" />

      {error && (
        <div className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span> <span>No se pudo cargar /api/users: {error}</span>
        </div>
      )}
      {data && !data.configured && (
        <div className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span>{" "}
          <span>
            <b>El registro de usuarios no está configurado.</b> Falta conectar Upstash Redis (KV_REST_API_URL y KV_REST_API_TOKEN). Mientras tanto
            solo entran los administradores fijos (ADMIN_EMAILS).
          </span>
        </div>
      )}

      {data?.configured && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Dar de alta</h2>
              <div className="card-sub">Cuenta {domains}. El acceso rige en segundos, sin que la persona tenga que volver a entrar.</div>
            </div>
          </div>
          <div className="alert-form" style={{ marginTop: 0 }}>
            <label>
              Email
              <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder={`nombre${domains.split(" ")[0]}`} maxLength={254} />
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)" }}>
              Perfil:
              {PROFILES.map((p) => (
                <button
                  key={p.label}
                  className="chip"
                  aria-pressed={newDraft.pages.join() === p.pages.join()}
                  onClick={() => setNewDraft({ ...newDraft, pages: p.pages })}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <PageChecks draft={newDraft} onChange={setNewDraft} disabled={busy !== null} />
            {formError && <div className="alert-form-error">{formError}</div>}
            <div className="alert-actions">
              <button className="btn primary" disabled={busy !== null || !newEmail.trim()} onClick={addUser}>
                {busy === "__new__" ? "Guardando…" : "Dar de alta"}
              </button>
            </div>
          </div>
        </section>
      )}

      {data && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Usuarios ({data.fixedAdmins.length + data.users.length})</h2>
              <div className="card-sub">Nadie puede cambiar su propio acceso. Los administradores fijos se configuran en ADMIN_EMAILS.</div>
            </div>
          </div>
          <div className="table-scroll-x">
            <table className="datatable">
              <thead>
                <tr>
                  <th>Email</th>
                  {PAGES.map((p) => (
                    <th key={p.key}>{p.label.replace("Medios · ", "")}</th>
                  ))}
                  <th>Admin</th>
                  <th>Última modificación</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.fixedAdmins.map((email) => (
                  <tr key={email}>
                    <td>
                      {email} <span style={{ color: "var(--text-muted)" }}>· administrador fijo</span>
                    </td>
                    {PAGES.map((p) => (
                      <td key={p.key}>
                        <input type="checkbox" checked disabled aria-label={p.label} />
                      </td>
                    ))}
                    <td>
                      <input type="checkbox" checked disabled aria-label="Administrador" />
                    </td>
                    <td style={{ color: "var(--text-muted)" }}>ADMIN_EMAILS</td>
                    <td></td>
                  </tr>
                ))}
                {data.users
                  .filter((u) => !data.fixedAdmins.includes(u.email))
                  .map((u) => {
                    const saved: Draft = { pages: u.pages, admin: u.admin };
                    const draft = drafts[u.email] ?? saved;
                    const own = u.email === session.email;
                    const locked = own || busy !== null;
                    const setDraft = (d: Draft) => setDrafts({ ...drafts, [u.email]: d });
                    return (
                      <tr key={u.email}>
                        <td>
                          {u.email}
                          {own && <span style={{ color: "var(--text-muted)" }}> · vos</span>}
                          {rowError?.email === u.email && <div className="alert-form-error">{rowError.message}</div>}
                        </td>
                        {PAGES.map((p) => (
                          <td key={p.key}>
                            <input
                              type="checkbox"
                              aria-label={`${p.label} — ${u.email}`}
                              checked={draft.pages.includes(p.key)}
                              disabled={locked}
                              onChange={() => setDraft({ ...draft, pages: toggle(draft.pages, p.key) })}
                            />
                          </td>
                        ))}
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Administrador — ${u.email}`}
                            checked={draft.admin}
                            disabled={locked}
                            onChange={() => setDraft({ ...draft, admin: !draft.admin })}
                          />
                        </td>
                        <td style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                          {fmtDateTime(u.updatedAt)} · {u.updatedBy}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {!own && (
                            <>
                              <button className="btn primary" disabled={locked || sameDraft(draft, saved)} onClick={() => saveRow(u.email)}>
                                {busy === u.email ? "Guardando…" : "Guardar"}
                              </button>{" "}
                              <button className="btn" disabled={locked} onClick={() => removeRow(u.email)}>
                                Quitar
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
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
              <div className="card-sub">Altas, cambios y bajas de acceso, con quién los hizo.</div>
            </div>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6, fontSize: 12.5 }}>
            {data.audit.map((a, i) => (
              <li key={i}>
                <span style={{ color: "var(--text-muted)" }}>{fmtDateTime(a.at)}</span> · <b>{a.by}</b> {AUDIT_VERB[a.action]} <b>{a.email}</b>
                {a.action !== "baja" && (
                  <span style={{ color: "var(--text-muted)" }}>
                    {" "}
                    — {pagesLabel(a.pages)}
                    {a.admin ? " + administrador" : ""}
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

function PageChecks({ draft, onChange, disabled }: { draft: Draft; onChange: (d: Draft) => void; disabled: boolean }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5 }}>
      {PAGES.map((p) => (
        <label key={p.key} style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-primary)" }}>
          <input type="checkbox" checked={draft.pages.includes(p.key)} disabled={disabled} onChange={() => onChange({ ...draft, pages: toggle(draft.pages, p.key) })} />
          {p.label}
        </label>
      ))}
      <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-primary)" }}>
        <input type="checkbox" checked={draft.admin} disabled={disabled} onChange={() => onChange({ ...draft, admin: !draft.admin })} />
        Administrador (gestiona usuarios)
      </label>
    </div>
  );
}
