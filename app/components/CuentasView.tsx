"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "./PageChrome";
import { fetchJson } from "@/lib/clientFetch";
import type { Session } from "@/lib/access";
import { CATEGORIAS_GASTO, MARCAS_CONOCIDAS, SIN_CLASIFICAR, type GastoManual, type Grupo, type Linea, type LineaConEjecucion, type PresupuestoAnual, type Resumen } from "@/lib/cuentasCore";
import type { CuentasAudit } from "@/lib/cuentas";

/**
 * Cuentas: el gasto real de Meta ordenado como lo hace la planilla del equipo (por marca, ocasión y
 * objetivo) y comparado con el presupuesto del año por línea (ejecutado, % y saldo).
 * Datos: /api/cuentas. El presupuesto se edita acá mismo y queda guardado con quién lo cambió.
 */

interface Respuesta {
  configured: boolean;
  presupuesto: PresupuestoAnual | null;
  audit: CuentasAudit[];
  gastos: GastoManual[];
  gastosPorCampana: { campana: string; monto: number; gastos: number }[];
  periodo: { desde: string; hasta: string; dias: number };
  fuente?: string;
  cuentas?: { accountId: string; accountName: string; gasto: number }[];
  cuenta?: string | null;
  resumen?: Resumen;
  ejecucion?: { lineas: LineaConEjecucion[]; sinAsignar: number } | null;
  warnings?: string[];
}

const PRESETS: { key: string; label: string }[] = [
  { key: "plan", label: "Todo el plan" },
  { key: "month", label: "Este mes" },
  { key: "lastmonth", label: "Mes pasado" },
  { key: "28d", label: "Últimos 28 días" },
];

const TZ = "America/Argentina/Buenos_Aires";
const fmtDay = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("es-AR", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString("es-AR", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtMoney = (n: number | null) => (n === null ? "—" : n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }));
const fmtNum = (n: number) => n.toLocaleString("es-AR", { maximumFractionDigits: 0 });
const fmtPct = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })} %`);
const clean = (err: any) => String(err?.message || err).replace(/^HTTP \d+ — /, "");
const muted = { color: "var(--text-muted)" } as const;

export default function CuentasView({ session }: { session: Session }) {
  const [preset, setPreset] = useState("plan");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [cuenta, setCuenta] = useState<string | null>(null);
  const [data, setData] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editando, setEditando] = useState(false);

  const custom = preset === "custom";
  const listo = !custom || (desde && hasta);

  const cargar = useCallback(() => {
    if (!listo) return;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams(custom ? { range: "custom", from: desde, to: hasta } : { range: preset });
    if (cuenta) q.set("cuenta", cuenta);
    fetchJson<Respuesta>(`/api/cuentas?${q}`)
      .then(setData)
      .catch((err) => setError(clean(err)))
      .finally(() => setLoading(false));
  }, [preset, desde, hasta, cuenta, custom, listo]);
  useEffect(cargar, [cargar]);

  // La primera vez, quedarse con la cuenta de Froneri si aparece: las propias de Taquión no son parte del plan.
  const [cuentaElegida, setCuentaElegida] = useState(false);
  useEffect(() => {
    if (!cuentaElegida && data?.cuentas) {
      setCuentaElegida(true);
      const f = data.cuentas.find((c) => /froneri/i.test(c.accountName));
      if (f) setCuenta(f.accountId);
    }
  }, [data, cuentaElegida]);

  const r = data?.resumen;

  return (
    <div className="wrap">
      <PageHeader title="Pulso Ignite — Cuentas" sub="Gasto de pauta por marca, ocasión y objetivo, contra el presupuesto del año" session={session} current="cuentas" />

      <section className="card">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {PRESETS.map((p) => (
            <button key={p.key} className="chip" aria-pressed={preset === p.key} onClick={() => setPreset(p.key)}>
              {p.label}
            </button>
          ))}
          <button className="chip" aria-pressed={custom} onClick={() => setPreset("custom")}>
            Fechas propias
          </button>
          {data?.cuentas && data.cuentas.length > 0 && (
            <label style={{ fontSize: 12.5, marginLeft: "auto" }}>
              Cuenta{" "}
              <select value={cuenta ?? ""} onChange={(e) => setCuenta(e.target.value || null)}>
                <option value="">Todas las de Meta</option>
                {data.cuentas.map((c) => (
                  <option key={c.accountId} value={c.accountId}>
                    {c.accountName}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {custom && (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10, fontSize: 12.5 }}>
            <label>
              Desde <input type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} />
            </label>
            <label>
              Hasta <input type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} />
            </label>
            <span style={muted}>Hasta 366 días.</span>
          </div>
        )}
        {data && (
          <div style={{ ...muted, fontSize: 12.5, marginTop: 10 }}>
            {fmtDay(data.periodo.desde)} → {fmtDay(data.periodo.hasta)} ({data.periodo.dias} días) · Fuente: {data.fuente ?? "Meta Ads"} (Windsor.ai). Solo Meta por ahora: TikTok, YouTube y programmatic todavía no entran.
          </div>
        )}
      </section>

      {loading && (
        <div className="mock-note">
          <span>Consultando Windsor… puede tardar hasta un minuto.</span>
        </div>
      )}
      {error && (
        <div className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span> <span>{error}</span>
        </div>
      )}
      {data?.warnings?.map((w, i) => (
        <div key={i} className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span> <span>{w}</span>
        </div>
      ))}
      {data && !data.configured && (
        <div className="mock-note">
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span>{" "}
          <span>
            <b>El presupuesto no se puede guardar:</b> falta conectar Upstash Redis (KV_REST_API_URL y KV_REST_API_TOKEN).
          </span>
        </div>
      )}

      {data && (
        <PresupuestoCard
          data={data}
          editando={editando}
          onEditar={setEditando}
          onGuardado={() => {
            setEditando(false);
            cargar();
          }}
        />
      )}

      {data?.presupuesto && <GastosCard data={data} onCambio={cargar} />}

      {r && !loading && (
        <>
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Gasto del período: {fmtMoney(r.total.gasto)}</h2>
                <div className="card-sub">
                  {fmtNum(r.total.campanas)} campañas · {fmtNum(r.total.impresiones)} impresiones · {fmtNum(r.total.conversiones)} resultados. Marca, ocasión y objetivo se leen del nombre de cada campaña.
                </div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20 }}>
              <Desglose titulo="Por marca" grupos={r.porMarca} total={r.total.gasto} nota="«Multimarca» = campañas con más de una marca: no se pueden repartir sin ver cada anuncio." />
              <Desglose titulo="Por ocasión" grupos={r.porOcasion} total={r.total.gasto} />
              <Desglose titulo="Por objetivo" grupos={r.porObjetivo} total={r.total.gasto} />
            </div>
          </section>

          <Matriz r={r} />

          {r.sinClasificar.length > 0 && (
            <section className="card">
              <div className="card-head">
                <div>
                  <h2>Campañas que no se pudieron clasificar ({r.sinClasificar.length})</h2>
                  <div className="card-sub">
                    El nombre no sigue la convención (TQN_ocasión_META_objetivo_…_marca) o usa una ocasión nueva. Se cuentan en «{SIN_CLASIFICAR}» y no se reparten por adivinanza.
                  </div>
                </div>
              </div>
              <div className="table-scroll-x">
                <table className="datatable">
                  <thead>
                    <tr>
                      <th>Campaña</th>
                      <th>Falta</th>
                      <th className="num">Gasto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.sinClasificar.map((c) => (
                      <tr key={c.nombre}>
                        <td>{c.nombre}</td>
                        <td style={muted}>{c.falta.join(", ")}</td>
                        <td className="num">{fmtMoney(c.gasto)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Desglose({ titulo, grupos, total, nota }: { titulo: string; grupos: Grupo[]; total: number; nota?: string }) {
  return (
    <div>
      <h3 style={{ fontSize: 13, marginBottom: 6 }}>{titulo}</h3>
      <table className="datatable">
        <thead>
          <tr>
            <th>{titulo.replace("Por ", "")}</th>
            <th className="num">Gasto</th>
            <th className="num">%</th>
          </tr>
        </thead>
        <tbody>
          {grupos.map((g) => (
            <tr key={g.nombre}>
              <td style={g.nombre === SIN_CLASIFICAR ? muted : undefined}>{g.nombre}</td>
              <td className="num">{fmtMoney(g.gasto)}</td>
              <td className="num">{total > 0 ? fmtPct((g.gasto / total) * 100) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {nota && <div style={{ ...muted, fontSize: 11.5, marginTop: 6 }}>{nota}</div>}
    </div>
  );
}

function Matriz({ r }: { r: Resumen }) {
  const { filas, columnas, valores } = r.marcaPorOcasion;
  if (filas.length === 0) return null;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Marca por ocasión</h2>
          <div className="card-sub">Cuánto gastó cada marca en cada ocasión.</div>
        </div>
      </div>
      <div className="table-scroll-x">
        <table className="datatable">
          <thead>
            <tr>
              <th>Marca</th>
              {columnas.map((c) => (
                <th key={c} className="num">
                  {c}
                </th>
              ))}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f}>
                <td>{f}</td>
                {columnas.map((c) => (
                  <td key={c} className="num">
                    {valores[f]?.[c] ? fmtMoney(valores[f][c]) : "—"}
                  </td>
                ))}
                <td className="num">
                  <b>{fmtMoney(Object.values(valores[f] ?? {}).reduce((s, v) => s + v, 0))}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PresupuestoCard({ data, editando, onEditar, onGuardado }: { data: Respuesta; editando: boolean; onEditar: (v: boolean) => void; onGuardado: () => void }) {
  const p = data.presupuesto;
  const ej = data.ejecucion;
  const totalMonto = p ? p.lineas.reduce((s, l) => s + l.monto, 0) : 0;
  const totalEjec = ej ? ej.lineas.reduce((s, l) => s + l.ejecutado, 0) : 0;
  const totalMano = ej ? ej.lineas.reduce((s, l) => s + l.aMano, 0) : 0;

  if (editando || !p) {
    return <Editor inicial={p} puedeGuardar={data.configured} onCancelar={p ? () => onEditar(false) : undefined} onGuardado={onGuardado} />;
  }
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Presupuesto del año por línea</h2>
          <div className="card-sub">
            Plan desde {fmtDay(p.inicio)}. Lo ejecutado suma el gasto de Meta de las marcas de cada línea más los gastos cargados a mano, en el período elegido arriba
            {data.periodo.desde !== p.inicio ? " (para ver el acumulado del plan, elegí «Todo el plan»)" : ""}.
          </div>
        </div>
        <button className="btn" onClick={() => onEditar(true)}>
          Editar presupuesto
        </button>
      </div>
      <div className="table-scroll-x">
        <table className="datatable">
          <thead>
            <tr>
              <th>Línea</th>
              <th>Marcas</th>
              <th className="num">Presupuesto</th>
              <th className="num">Ejecutado</th>
              <th className="num">De eso, a mano</th>
              <th className="num">% ejecutado</th>
              <th className="num">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {(ej?.lineas ?? p.lineas.map((l) => ({ ...l, ejecutado: 0, aMano: 0, pct: null, saldo: l.monto }))).map((l) => (
              <tr key={l.id}>
                <td>{l.nombre}</td>
                <td style={muted}>{l.marcas.length ? l.marcas.join(", ") : "Solo gastos cargados a mano"}</td>
                <td className="num">{fmtMoney(l.monto)}</td>
                <td className="num">{fmtMoney(l.ejecutado)}</td>
                <td className="num" style={muted}>{l.aMano ? fmtMoney(l.aMano) : "—"}</td>
                <td className="num">{fmtPct(l.pct)}</td>
                <td className="num" style={l.saldo < 0 ? { color: "var(--status-critical, #c0392b)" } : undefined}>
                  {fmtMoney(l.saldo)}
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <b>Total</b>
              </td>
              <td></td>
              <td className="num">
                <b>{fmtMoney(totalMonto)}</b>
              </td>
              <td className="num">
                <b>{ej ? fmtMoney(totalEjec) : "—"}</b>
              </td>
              <td className="num" style={muted}>
                {ej && totalMano ? fmtMoney(totalMano) : "—"}
              </td>
              <td className="num">
                <b>{ej && totalMonto > 0 ? fmtPct((totalEjec / totalMonto) * 100) : "—"}</b>
              </td>
              <td className="num">
                <b>{ej ? fmtMoney(totalMonto - totalEjec) : "—"}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {ej && ej.sinAsignar > 0 && (
        <div style={{ ...muted, fontSize: 12, marginTop: 8 }}>
          {fmtMoney(ej.sinAsignar)} de gasto no entra en ninguna línea (campañas multimarca, sin clasificar o de una marca que ninguna línea tiene). Por eso el total ejecutado de las líneas puede ser menor al gasto del período.
        </div>
      )}
      {p.updatedAt && (
        <div style={{ ...muted, fontSize: 11.5, marginTop: 8 }}>
          Último cambio: {fmtDateTime(p.updatedAt)} · {p.updatedBy}
          {data.audit.length > 1 ? ` · ${data.audit.length} cambios en total` : ""}
        </div>
      )}
    </section>
  );
}

function Editor({ inicial, puedeGuardar, onCancelar, onGuardado }: { inicial: PresupuestoAnual | null; puedeGuardar: boolean; onCancelar?: () => void; onGuardado: () => void }) {
  const [inicio, setInicio] = useState(inicial?.inicio ?? "");
  const [lineas, setLineas] = useState<Linea[]>(inicial?.lineas ?? [{ id: "l1", nombre: "", monto: 0, marcas: [] }]);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cambiar = (i: number, patch: Partial<Linea>) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const marcaEn = (i: number, m: string) =>
    cambiar(i, { marcas: lineas[i].marcas.includes(m) ? lineas[i].marcas.filter((x) => x !== m) : [...lineas[i].marcas, m] });

  async function guardar() {
    setGuardando(true);
    setErr(null);
    try {
      await fetchJson("/api/cuentas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inicio, lineas }) });
      onGuardado();
    } catch (e) {
      setErr(clean(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{inicial ? "Editar presupuesto del año" : "Cargar el presupuesto del año"}</h2>
          <div className="card-sub">
            Una línea por rubro (por ejemplo EPA!, Torpedo, Conversión, Activaciones). Tildá las marcas cuyo gasto cuenta en cada línea; una línea sin marcas (shooting, activaciones) se alimenta solo con los gastos que cargues a mano más abajo.
            Una marca tildada en dos líneas solo cuenta en la primera.
          </div>
        </div>
      </div>
      <label style={{ fontSize: 12.5 }}>
        El plan empieza el <input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} />
      </label>
      <div style={{ display: "grid", gap: 10, margin: "12px 0" }}>
        {lineas.map((l, i) => (
          <div key={l.id} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid var(--border)", paddingBottom: 10 }}>
            <input placeholder="Nombre de la línea" value={l.nombre} onChange={(e) => cambiar(i, { nombre: e.target.value })} style={{ width: 190 }} />
            <input type="number" min={0} placeholder="Monto en pesos" value={l.monto || ""} onChange={(e) => cambiar(i, { monto: Number(e.target.value) })} style={{ width: 150 }} />
            {MARCAS_CONOCIDAS.map((m) => (
              <label key={m} style={{ fontSize: 12.5 }}>
                <input type="checkbox" checked={l.marcas.includes(m)} onChange={() => marcaEn(i, m)} /> {m}
              </label>
            ))}
            {lineas.length > 1 && (
              <button className="btn" onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}>
                Quitar
              </button>
            )}
          </div>
        ))}
        <div>
          <button className="btn" disabled={lineas.length >= 20} onClick={() => setLineas((ls) => [...ls, { id: `l${Date.now() % 100000}`, nombre: "", monto: 0, marcas: [] }])}>
            + Agregar línea
          </button>
        </div>
      </div>
      {err && <div className="alert-form-error">{err}</div>}
      {!puedeGuardar && <div className="alert-form-error">No se puede guardar: falta conectar Upstash Redis.</div>}
      <div className="alert-actions">
        <button className="btn primary" disabled={guardando || !puedeGuardar || !inicio} onClick={guardar}>
          {guardando ? "Guardando…" : "Guardar presupuesto"}
        </button>
        {onCancelar && (
          <button className="btn" disabled={guardando} onClick={onCancelar}>
            Cancelar
          </button>
        )}
      </div>
    </section>
  );
}

const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });

interface Formulario {
  id?: string;
  fecha: string;
  lineaId: string;
  categoria: string;
  detalle: string;
  campana: string;
  monto: string;
}

function GastosCard({ data, onCambio }: { data: Respuesta; onCambio: () => void }) {
  const p = data.presupuesto!;
  const vacio: Formulario = { fecha: hoy(), lineaId: p.lineas.find((l) => l.marcas.length === 0)?.id ?? p.lineas[0].id, categoria: "UGC", detalle: "", campana: "", monto: "" };
  const [f, setF] = useState<Formulario>(vacio);
  const [abierto, setAbierto] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nombreLinea = (id: string) => p.lineas.find((l) => l.id === id)?.nombre ?? "(línea quitada)";
  const total = data.gastos.reduce((s, g) => s + g.monto, 0);

  async function enviar() {
    setTrabajando(true);
    setErr(null);
    try {
      const body = { ...f, monto: Number(f.monto) };
      await fetchJson("/api/cuentas/gastos", { method: f.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setAbierto(false);
      setF(vacio);
      onCambio();
    } catch (e) {
      setErr(clean(e));
    } finally {
      setTrabajando(false);
    }
  }

  async function borrar(g: GastoManual) {
    if (!window.confirm(`¿Borrar «${g.detalle}» por ${fmtMoney(g.monto)}? Queda registrado en la auditoría.`)) return;
    setTrabajando(true);
    setErr(null);
    try {
      await fetchJson(`/api/cuentas/gastos?id=${encodeURIComponent(g.id)}`, { method: "DELETE" });
      onCambio();
    } catch (e) {
      setErr(clean(e));
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Gastos fuera de las plataformas: {fmtMoney(total)}</h2>
          <div className="card-sub">
            Pagos a creadores (UGC), envíos, shooting y todo lo que no sale de Meta. Cada gasto cuenta contra una línea del presupuesto. Acá se ven los del período elegido arriba.
          </div>
        </div>
        {!abierto && (
          <button
            className="btn"
            disabled={!data.configured}
            onClick={() => {
              setF(vacio);
              setAbierto(true);
            }}
          >
            + Cargar gasto
          </button>
        )}
      </div>

      {abierto && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <input type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} />
          <select value={f.lineaId} onChange={(e) => setF({ ...f, lineaId: e.target.value })}>
            {p.lineas.map((l) => (
              <option key={l.id} value={l.id}>
                {l.nombre}
              </option>
            ))}
          </select>
          <select value={f.categoria} onChange={(e) => setF({ ...f, categoria: e.target.value })}>
            {CATEGORIAS_GASTO.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <input placeholder="Qué se pagó (ej. Pago UGC - cafeyroma)" value={f.detalle} onChange={(e) => setF({ ...f, detalle: e.target.value })} style={{ width: 260 }} />
          <input placeholder="Campaña (opcional)" value={f.campana} onChange={(e) => setF({ ...f, campana: e.target.value })} style={{ width: 170 }} />
          <input type="number" min={0} placeholder="Monto en pesos" value={f.monto} onChange={(e) => setF({ ...f, monto: e.target.value })} style={{ width: 140 }} />
          <button className="btn primary" disabled={trabajando || !f.detalle.trim() || !(Number(f.monto) > 0)} onClick={enviar}>
            {trabajando ? "Guardando…" : f.id ? "Guardar cambio" : "Guardar gasto"}
          </button>
          <button className="btn" disabled={trabajando} onClick={() => setAbierto(false)}>
            Cancelar
          </button>
        </div>
      )}
      {err && <div className="alert-form-error">{err}</div>}

      {data.gastos.length === 0 ? (
        <div style={{ ...muted, fontSize: 12.5 }}>No hay gastos cargados en este período.</div>
      ) : (
        <>
          <div className="table-scroll-x">
            <table className="datatable">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Detalle</th>
                  <th>Categoría</th>
                  <th>Campaña</th>
                  <th>Línea</th>
                  <th className="num">Monto</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.gastos.map((g) => (
                  <tr key={g.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDay(g.fecha)}</td>
                    <td>{g.detalle}</td>
                    <td>{g.categoria}</td>
                    <td style={muted}>{g.campana || "—"}</td>
                    <td>{nombreLinea(g.lineaId)}</td>
                    <td className="num">{fmtMoney(g.monto)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        className="btn"
                        disabled={trabajando}
                        onClick={() => {
                          setF({ id: g.id, fecha: g.fecha, lineaId: g.lineaId, categoria: g.categoria, detalle: g.detalle, campana: g.campana, monto: String(g.monto) });
                          setAbierto(true);
                        }}
                      >
                        Editar
                      </button>{" "}
                      <button className="btn" disabled={trabajando} onClick={() => borrar(g)}>
                        Borrar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.gastosPorCampana.some((c) => c.campana !== "Sin campaña") && (
            <div style={{ ...muted, fontSize: 12.5, marginTop: 10 }}>Por campaña: {data.gastosPorCampana.map((c) => `${c.campana} ${fmtMoney(c.monto)}`).join(" · ")}</div>
          )}
        </>
      )}
      {data.gastos.some((g) => !p.lineas.some((l) => l.id === g.lineaId)) && (
        <div style={{ ...muted, fontSize: 12, marginTop: 8 }}>Hay gastos de una línea que ya no existe en el presupuesto: no suman a ninguna línea. Editalos para pasarlos a otra.</div>
      )}
    </section>
  );
}
