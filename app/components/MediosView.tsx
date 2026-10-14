"use client";

import { fetchJson } from "@/lib/clientFetch";
import { MediosHeader, MediosSubnav } from "./PageChrome";
import type { Session } from "@/lib/access";
import { ErrorPanel, LoadingPanel, announceReady, type SourceStatus } from "./StatusUI";
import { usePlatformSelection } from "@/lib/usePlatformSelection";
import { useEffect, useRef, useState } from "react";
import type { CampaignRow, CampaignsResponse, PlatformKey } from "@/lib/types";

const PLATFORMS: { key: PlatformKey; label: string; varName: string }[] = [
  { key: "google", label: "Google Ads", varName: "--plat-google" },
  { key: "meta", label: "Meta Ads", varName: "--plat-meta" },
  { key: "tiktok", label: "TikTok Ads", varName: "--plat-tiktok" },
];

// Mismo set de presets que la vista de Finanzas (ver DATE_PRESETS en
// Dashboard.tsx) — duplicado a propósito, no importado de lib/windsor.ts:
// ese archivo es solo-servidor. "custom" se guarda igual que en Finanzas,
// pero todavía no hay rango personalizado real conectado — cae a "month".
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

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("es-AR");
}
function fmtMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString("es-AR");
}
function fmtPct(n?: number): string {
  return n === undefined ? "—" : Math.round(n) + "%";
}
function fmtScore10(n?: number): string {
  return n === undefined ? "—" : n.toFixed(1) + "/10";
}
function fmtFreq(n?: number): string {
  return n === undefined ? "—" : n.toFixed(1);
}
function fmtSeconds(n?: number): string {
  return n === undefined ? "—" : n.toFixed(1) + "s";
}
function extraColCount(platform: PlatformKey): number {
  if (platform === "google") return 7;
  if (platform === "meta") return 2;
  if (platform === "tiktok") return 4;
  return 0;
}

// Mismo cálculo de pacing que Finanzas (statusForBudgetSpend en
// Dashboard.tsx) — duplicado a propósito, ver la nota sobre DatePreset más
// arriba. A pedido explícito 2026-09-28: Remanente y Estado, que ya tenía
// Finanzas para sus campañas anidadas, también hacen falta acá.
type Status = { key: "good" | "warning" | "critical"; label: string };
function statusForBudgetSpend(budget: number, spend: number, today: number, daysInMonth: number): Status {
  if (budget === 0) return { key: "good", label: "Sin objetivo cargado" };
  const flat = spend / today;
  const projected = spend + flat * (daysInMonth - today);
  const ratio = projected / budget;
  if (ratio > 1.1) return { key: "warning", label: "Sobre-ritmo" };
  if (ratio < 0.85) return { key: "critical", label: "Bajo-ritmo" };
  return { key: "good", label: "En ritmo" };
}

// Presupuesto diario recomendado = remanente / días que quedan en el
// período, para llegar justo al presupuesto proyectado al cierre — mismo
// concepto de pacing que ya usa Finanzas (Dashboard.tsx), acá por campaña.
// undefined (se muestra "—") en 2 casos: sin presupuesto cargado (nada que
// recomendar), o el período ya cerró (today >= daysInPeriod — rangos fijos
// como "Hoy"/"Ayer"/"7d"/"Mes anterior" siempre están 100% transcurridos,
// solo "Este mes" tiene días remanentes de verdad).
// Se muestra como el monto LITERAL por día (ej. "$4.000 x día") más, entre
// paréntesis, cuánto se aleja del ritmo actual — a pedido del equipo
// 2026-10-01: antes se veía como "+$4.000" en verde, que se leía como "poné
// $4.000 más por día" en vez de "el presupuesto diario es $4.000".
function dailyRecommended(budget: number, spend: number, today: number, daysInPeriod: number): number | undefined {
  if (budget === 0) return undefined;
  const daysRemaining = daysInPeriod - today;
  if (daysRemaining <= 0) return undefined;
  return (budget - spend) / daysRemaining;
}
// Cuánto cambia el presupuesto diario recomendado contra el ritmo promedio
// actual (gasto acumulado / días transcurridos), en %. Positivo = hay que
// subir el gasto diario para llegar al presupuesto; negativo = hay que
// bajarlo. undefined si no hay un ritmo actual contra el cual comparar, o si
// pasaron menos de MIN_DAYS_FOR_PCT días del período: con 1 o 2 días de gasto
// el promedio es ruido y el % sale desproporcionado (ej. +9701% el día 1).
const MIN_DAYS_FOR_PCT = 3;
// ¿Hay que subir el gasto diario? Recomendado > ritmo promedio actual (0 si
// todavía no se gastó nada). A diferencia del %, no se oculta antes del día
// 3: la dirección es válida desde el primer día, solo la magnitud es ruido.
// Se usa para pintar el monto de verde ("hay que aumentar presupuesto").
function needsIncrease(daily: number, spend: number, today: number): boolean {
  const current = today > 0 ? spend / today : 0;
  return daily > current;
}
function dailyVsCurrentPct(daily: number, spend: number, today: number): number | undefined {
  if (daily <= 0 || spend <= 0 || today < MIN_DAYS_FOR_PCT) return undefined;
  return (daily / (spend / today) - 1) * 100;
}

// Fila de campaña ya combinada entre plataformas — CampaignRow + de qué
// plataforma vino, para poder mostrar la columna "Plataforma" y elegir sus
// columnas específicas cuando corresponde.
type MergedRow = CampaignRow & { platform: PlatformKey };

export default function MediosView({ session }: { session: Session }) {
  // Plataformas: la elección es la MISMA en todas las pantallas (se recuerda en el navegador) y por
  // defecto están todas prendidas; cada persona apaga las que no quiere ver. Ver lib/usePlatformSelection.ts.
  const { selection: platformsEnabled, toggle: togglePlatform, ready: selectionReady } = usePlatformSelection(PLATFORMS.map((p) => p.key));
  const [datePreset, setDatePreset] = useState<DatePreset>("month");
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  // Un fetch por plataforma activa — se combinan en una sola tabla más abajo. Cada una se carga,
  // y puede fallar, por separado: si falla una, las otras se siguen mostrando.
  const [dataByPlatform, setDataByPlatform] = useState<Partial<Record<PlatformKey, CampaignsResponse>>>({});
  const [statusByPlatform, setStatusByPlatform] = useState<Partial<Record<PlatformKey, "loading" | "done" | "error">>>({});
  const [errorByPlatform, setErrorByPlatform] = useState<Partial<Record<PlatformKey, string>>>({});
  const [reloadKey, setReloadKey] = useState(0);
  // Mismo filtro que Finanzas (Dashboard.tsx) — acá por campaña en vez de
  // por cuenta: oculta campañas sin gasto real en el período elegido.
  // Activado por defecto (a pedido explícito 2026-09-24), en los 2
  // usuarios por igual.
  const [onlyActive, setOnlyActive] = useState(true);
  // Selector de cuentas en la barra lateral — mismo patrón que "Clientes" en
  // Finanzas (Dashboard.tsx), acá a nivel cuenta (que es el nivel real que
  // maneja Medios: CampaignRow no agrupa varias plataformas bajo un mismo
  // "cliente", cada cuenta de Windsor es de una sola plataforma).
  const [accountKey, setAccountKey] = useState<string>("all");
  const dateMenuRef = useRef<HTMLDivElement>(null);

  const enabledKeys = PLATFORMS.filter((p) => platformsEnabled[p.key]).map((p) => p.key);
  const enabledKeysDep = enabledKeys.join(",");

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
    if (!selectionReady) return;
    let cancelled = false;
    // "custom" todavía no está conectado (ver nota en el menú de fecha) — se
    // sigue pidiendo "month" hasta que se implemente el rango personalizado.
    const range = datePreset === "custom" ? "month" : datePreset;
    const keys = enabledKeysDep.split(",").filter(Boolean) as PlatformKey[];
    const startedAt = Date.now();
    setDataByPlatform({});
    setErrorByPlatform({});
    setStatusByPlatform(Object.fromEntries(keys.map((k) => [k, "loading"])));
    let pending = keys.length;
    let anyOk = false;
    keys.forEach((key) => {
      fetchJson<any>(`/api/campaigns?platform=${key}&range=${range}`)
        .then((body: CampaignsResponse) => {
          if (cancelled) return;
          anyOk = true;
          setDataByPlatform((prev) => ({ ...prev, [key]: body }));
          setStatusByPlatform((prev) => ({ ...prev, [key]: "done" }));
        })
        .catch((err) => {
          if (cancelled) return;
          setErrorByPlatform((prev) => ({ ...prev, [key]: String(err?.message || err) }));
          setStatusByPlatform((prev) => ({ ...prev, [key]: "error" }));
        })
        .finally(() => {
          if (cancelled) return;
          pending -= 1;
          if (pending === 0 && anyOk) announceReady("Campañas cargadas", startedAt);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [selectionReady, enabledKeysDep, datePreset, reloadKey]);

  // Qué cuentas existen depende de las plataformas activas y el rango — si
  // cambia cualquiera de los dos, la cuenta elegida puede dejar de existir.
  useEffect(() => {
    setAccountKey("all");
  }, [enabledKeysDep, datePreset]);

  const loading = !selectionReady || enabledKeys.some((k) => (statusByPlatform[k] ?? "loading") === "loading");
  const failedKeys = enabledKeys.filter((k) => statusByPlatform[k] === "error");
  // Se muestra lo que ya llegó sin esperar a la plataforma más lenta (TikTok tarda 6-8 s); mientras faltan otras
  // aparece un aviso con cuáles faltan. Los totales son parciales hasta que terminan todas.
  const loaded = enabledKeys.some((k) => statusByPlatform[k] === "done");
  const allFailed = !loading && !loaded;
  const sources: SourceStatus[] = enabledKeys.map((k) => ({
    label: PLATFORMS.find((p) => p.key === k)?.label ?? k,
    state: (statusByPlatform[k] ?? "loading") as SourceStatus["state"],
  }));
  const failedDetail = failedKeys.map((k) => `${PLATFORMS.find((p) => p.key === k)?.label ?? k}: ${errorByPlatform[k]}`).join(" | ");

  const showCombined = enabledKeys.length > 1;
  const singlePlatform = !showCombined ? enabledKeys[0] : undefined;
  const activeLabel = enabledKeys.map((k) => PLATFORMS.find((p) => p.key === k)?.label ?? k).join(" + ");
  const dateLabel = DATE_PRESETS.find((d) => d.key === datePreset)?.label ?? "Este mes";

  const allCampaigns: MergedRow[] = [];
  enabledKeys.forEach((k) => {
    dataByPlatform[k]?.campaigns.forEach((c) => allCampaigns.push({ ...c, platform: k }));
  });
  const allMock = enabledKeys.every((k) => dataByPlatform[k]?.source === "mock");
  const mergedWarnings = [...new Set(enabledKeys.flatMap((k) => dataByPlatform[k]?.warnings ?? []))];
  // today/daysInPeriod son iguales para todas las plataformas activas (se
  // derivan solo del rango de fecha elegido, no del dato de cada una).
  const today = dataByPlatform[enabledKeys[0]]?.today ?? 0;
  const daysInPeriod = dataByPlatform[enabledKeys[0]]?.daysInPeriod ?? 0;

  // "Actividad" = gasto real > 0 — no "tiene presupuesto cargado" (mismo
  // criterio que Finanzas). Alimenta el sidebar de cuentas y la tabla.
  const visibleCampaigns = onlyActive ? allCampaigns.filter((c) => c.spend > 0) : allCampaigns;

  // Cuentas para el sidebar — a partir de las campañas ya filtradas por
  // "Solo con actividad" (mismo orden que Finanzas: primero actividad,
  // después la cuenta elegida), sin duplicar por campaña.
  const accountMap = new Map<string, string>();
  visibleCampaigns.forEach((c) => {
    if (!accountMap.has(c.accountId)) accountMap.set(c.accountId, c.accountName);
  });
  const accounts = [...accountMap.entries()].map(([accountId, accountName]) => ({ accountId, accountName }));

  const campaignsIncluded = accountKey === "all" ? visibleCampaigns : visibleCampaigns.filter((c) => c.accountId === accountKey);

  // Totales — suma de las campañas que se están mostrando (plataformas +
  // período + filtro de actividad + cuenta elegidos), mismo par "Total
  // presupuesto"/"Total gastado" que ya tiene Finanzas arriba de su tabla.
  const totalBudget = campaignsIncluded.reduce((sum, c) => sum + c.budget, 0);
  const totalSpend = campaignsIncluded.reduce((sum, c) => sum + c.spend, 0);

  return (
    <div className="wrap">
      <MediosHeader sub="Rendimiento por campaña — equipo Medios, Taquión" session={session} />
      <MediosSubnav current="/medios" session={session} />

      {mergedWarnings.map((w, i) => (
        <div className="mock-note" key={i}>
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span> <span>{w}</span>
        </div>
      ))}
      {allMock && mergedWarnings.length === 0 && (
        <div className="mock-note">
          <span className="tq-arrow">↘</span>{" "}
          <span>
            <b>Datos de ejemplo.</b> En cuanto haya campañas reales de {activeLabel} en Windsor.ai, se muestran acá.
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
          <div className="stat-chip">
            <span className="stat-label">Total proyectado</span>
            <span className="stat-value num">{loaded ? fmtMoney(totalBudget) + (loading ? " …" : "") : "…"}</span>
          </div>
          <div className="stat-chip">
            <span className="stat-label">Total gastado</span>
            <span className="stat-value num">{loaded ? fmtMoney(totalSpend) + (loading ? " …" : "") : "…"}</span>
          </div>
          <button className="toggle-chip" aria-pressed={onlyActive} onClick={() => setOnlyActive((v) => !v)}>
            <span className="toggle-track">
              <span className="toggle-knob" />
            </span>
            Solo con actividad
          </button>
        </div>
        <div className="chip-row">
          {PLATFORMS.map((p) => (
            <button key={p.key} className="chip plat" aria-pressed={!!platformsEnabled[p.key]} onClick={() => togglePlatform(p.key)}>
              <span className="dot" style={{ background: `var(${p.varName})` }} />
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !loaded && <LoadingPanel what="las campañas" sources={sources} />}
      {loading && loaded && <LoadingPanel compact what="las campañas" sources={sources} />}
      {allFailed && <ErrorPanel what="Campañas" detail={failedDetail} onRetry={() => setReloadKey((k) => k + 1)} />}
      {loaded && failedKeys.length > 0 && (
        <ErrorPanel compact what={`las campañas de ${failedKeys.map((k) => PLATFORMS.find((p) => p.key === k)?.label ?? k).join(" y ")}`} detail={failedDetail} onRetry={() => setReloadKey((k) => k + 1)} />
      )}

      {loaded && (
      <div className="op-layout">
        <div className="card sidebar">
          <div className="eyebrow">Cuentas</div>
          <div className="client-list">
            <button className="client-row" aria-pressed={accountKey === "all"} onClick={() => setAccountKey("all")}>
              Todas las cuentas
            </button>
            {accounts.map((a) => (
              <button key={a.accountId} className="client-row" aria-pressed={accountKey === a.accountId} onClick={() => setAccountKey(a.accountId)}>
                {a.accountName}
              </button>
            ))}
            {accounts.length === 0 && (
              <div style={{ color: "var(--text-muted)", fontSize: 12.5, padding: "8px 10px" }}>Sin cuentas con actividad.</div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
        <div className="card">
          <h2>Campañas — {activeLabel}</h2>
          <div className="card-sub">
            {showCombined &&
              "Métricas comunes a las plataformas seleccionadas. Para cuota de subasta/calidad, alcance o video, elegí una sola plataforma a la vez."}
            {singlePlatform === "google" && "Métricas comunes + cuota de subasta y calidad, propias de Google Ads."}
            {singlePlatform === "meta" && "Métricas comunes + alcance y frecuencia, propias de campañas de alcance/awareness."}
            {singlePlatform === "tiktok" && "Métricas comunes + alcance, frecuencia y video — el formato nativo de la plataforma."}
          </div>
          <div className="table-scroll-x" style={{ marginTop: 14 }}>
            <table className="dense">
              <thead>
                <tr>
                  <th>Cuenta</th>
                  {showCombined && <th>Plataforma</th>}
                  <th>Campaña</th>
                  <th className="num">Presupuesto proyectado</th>
                  <th className="num">Real</th>
                  <th className="num">Remanente</th>
                  <th>Estado</th>
                  <th className="num" title="Remanente ÷ días que quedan. Entre paréntesis: variación contra el ritmo promedio de gasto actual (+ = hay que subir, − = hay que bajar).">Presup. diario recom.</th>
                  <th className="num">Impr.</th>
                  <th className="num">Clicks</th>
                  <th className="num">CPM</th>
                  <th className="num">CTR</th>
                  <th className="num">CPL</th>
                  <th className="num">Conv.</th>
                  {singlePlatform === "google" && (
                    <>
                      <th className="num">Cuota impr.</th>
                      <th className="num">Nivel calidad</th>
                      <th className="num">Pérd. presup.</th>
                      <th className="num">Pérd. ranking</th>
                      <th className="num">Pos. abs.</th>
                      <th className="num">Pos. superior</th>
                      <th className="num">Punt. optim.</th>
                    </>
                  )}
                  {(singlePlatform === "meta" || singlePlatform === "tiktok") && (
                    <>
                      <th className="num">Alcance</th>
                      <th className="num">Frec.</th>
                    </>
                  )}
                  {singlePlatform === "tiktok" && (
                    <>
                      <th className="num">Tiempo prom.</th>
                      <th className="num">Likes</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {campaignsIncluded.length === 0 ? (
                  <tr>
                    <td
                      colSpan={13 + (showCombined ? 1 : extraColCount(singlePlatform!))}
                      style={{ color: "var(--text-muted)" }}
                    >
                      {allCampaigns.length === 0 ? "Sin campañas para mostrar." : "Sin campañas con los filtros elegidos."}
                    </td>
                  </tr>
                ) : (
                  campaignsIncluded.map((c) => {
                    const daily = dailyRecommended(c.budget, c.spend, today, daysInPeriod);
                    const pctVsNow = daily === undefined ? undefined : dailyVsCurrentPct(daily, c.spend, today);
                    const increase = daily !== undefined && daily > 0 && needsIncrease(daily, c.spend, today);
                    const remaining = c.budget - c.spend;
                    const cst = statusForBudgetSpend(c.budget, c.spend, today, daysInPeriod);
                    const platMeta = PLATFORMS.find((p) => p.key === c.platform);
                    return (
                    <tr key={c.platform + ":" + c.accountId + ":" + c.campaignId}>
                      <td>{c.accountName}</td>
                      {showCombined && (
                        <td>
                          <span className="plat-dot" style={{ background: `var(${platMeta?.varName})` }} />
                          {platMeta?.label ?? c.platform}
                        </td>
                      )}
                      <td>{c.campaignName}</td>
                      <td className="num">{fmtMoney(c.budget)}</td>
                      <td className="num">{fmtMoney(c.spend)}</td>
                      <td className="num" style={{ color: remaining < 0 ? "var(--delta-bad-text)" : "var(--delta-good-text)" }}>
                        {remaining >= 0 ? "+" : ""}
                        {fmtMoney(remaining)}
                      </td>
                      <td>
                        <span className={"pill " + cst.key}>
                          <span className="dot" />
                          {cst.label}
                        </span>
                      </td>
                      <td className="num">
                        {daily === undefined ? (
                          "—"
                        ) : daily <= 0 ? (
                          <span style={{ color: "var(--delta-bad-text)" }}>Presupuesto agotado</span>
                        ) : (
                          <>
                            <span style={increase ? { color: "var(--delta-good-text)" } : undefined}>{fmtMoney(daily)} x día</span>
                            {pctVsNow !== undefined && (
                              <span style={{ color: "var(--text-muted)" }}>
                                {" "}
                                ({pctVsNow >= 0 ? "+" : "−"}
                                {Math.abs(pctVsNow).toFixed(0)}%)
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="num">{fmtInt(c.impressions)}</td>
                      <td className="num">{fmtInt(c.clicks)}</td>
                      <td className="num">{fmtMoney(c.cpm)}</td>
                      <td className="num">{c.ctr.toFixed(1)}%</td>
                      <td className="num">{fmtMoney(c.cpl)}</td>
                      <td className="num">{fmtInt(c.conversions)}</td>
                      {singlePlatform === "google" && (
                        <>
                          <td className="num">{fmtPct(c.searchImpressionShare)}</td>
                          <td className="num">{fmtScore10(c.qualityScore)}</td>
                          <td className="num">{fmtPct(c.searchBudgetLostIS)}</td>
                          <td className="num">{fmtPct(c.searchRankLostIS)}</td>
                          <td className="num">{fmtPct(c.searchAbsoluteTopIS)}</td>
                          <td className="num">{fmtPct(c.searchTopIS)}</td>
                          <td className="num">{fmtPct(c.optimizationScore)}</td>
                        </>
                      )}
                      {(singlePlatform === "meta" || singlePlatform === "tiktok") && (
                        <>
                          <td className="num">{fmtInt(c.reach ?? 0)}</td>
                          <td className="num">{fmtFreq(c.frequency)}</td>
                        </>
                      )}
                      {singlePlatform === "tiktok" && (
                        <>
                          <td className="num">{fmtSeconds(c.avgVideoPlaySeconds)}</td>
                          <td className="num">{fmtInt(c.likes ?? 0)}</td>
                        </>
                      )}
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        </div>
      </div>
      )}

      <footer className="foot">
        <span>Fuente de datos: {allMock ? "mock" : "Windsor.ai (en vivo)"}</span>
      </footer>
    </div>
  );
}
