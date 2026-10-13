"use client";

import { fetchJson } from "@/lib/clientFetch";
import { MediosHeader, MediosSubnav } from "./PageChrome";
import type { Session } from "@/lib/access";
import { ErrorPanel, LoadingPanel, announceReady, type SourceStatus } from "./StatusUI";
import { usePlatformSelection } from "@/lib/usePlatformSelection";
import { useEffect, useRef, useState } from "react";
import type { AdRow, AdsResponse, PlatformKey } from "@/lib/types";

// Anuncio ya combinado entre plataformas: AdRow + de qué plataforma vino.
type MergedAd = AdRow & { platform: PlatformKey };

const PLATFORMS: { key: PlatformKey; label: string; varName: string }[] = [
  { key: "google", label: "Google Ads", varName: "--plat-google" },
  { key: "meta", label: "Meta Ads", varName: "--plat-meta" },
  { key: "tiktok", label: "TikTok Ads", varName: "--plat-tiktok" },
];

// Mismo set de presets que Dashboard.tsx / MediosView.tsx — duplicado a
// propósito, ver la nota en MediosView.tsx.
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

// Orden de rendimiento DENTRO de cada grupo de campaña (no reordena los
// grupos entre sí) — a pedido explícito 2026-09-25, para ver de un vistazo
// qué variante creativa escalar o pausar.
type SortKey = "default" | "ctr" | "impressions";
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "default", label: "Orden original" },
  { key: "ctr", label: "Mejor CTR" },
  { key: "impressions", label: "Más impresiones" },
];

function sortAdsBy(ads: MergedAd[], sortKey: SortKey): MergedAd[] {
  if (sortKey === "default") return ads;
  const arr = [...ads];
  if (sortKey === "ctr") {
    arr.sort((a, b) => b.ctr - a.ctr);
  } else if (sortKey === "impressions") {
    arr.sort((a, b) => b.impressions - a.impressions);
  }
  return arr;
}

// Badge "Mejor X" dentro de un grupo — independiente del orden elegido para
// la grilla (SortKey acá puede ser "default", que no ordena nada): si no
// hay un criterio explícito se usa CTR, el más representativo de "qué
// variante conviene escalar" a simple vista. Ningún badge con 1 solo
// anuncio en el grupo (no hay con qué comparar).
// CPL y Conversiones se ocultaron a pedido del equipo (2026-10-01): el dato
// sigue en la API, así que volver a ofrecerlos es agregar la fila y el criterio.
function bestAdInGroup(ads: MergedAd[], sortKey: SortKey): { adId: string; label: string } | null {
  if (ads.length < 2) return null;
  const criterion = sortKey === "default" ? "ctr" : sortKey;
  if (criterion === "impressions") {
    const top = [...ads].sort((a, b) => b.impressions - a.impressions)[0];
    return { adId: top.adId, label: "Más impresiones" };
  }
  const top = [...ads].sort((a, b) => b.ctr - a.ctr)[0];
  return { adId: top.adId, label: "Mejor CTR" };
}

// Un anuncio pertenece a una sola cuenta + campaña — se agrupan así para
// comparar de un vistazo las variantes creativas de un mismo test
// (a pedido explícito 2026-09-25), en vez de una grilla plana.
interface CampaignGroup {
  key: string;
  campaignName: string;
  accountName: string;
  ads: MergedAd[];
}
function groupByCampaign(ads: MergedAd[]): CampaignGroup[] {
  const groups: CampaignGroup[] = [];
  const indexByKey = new Map<string, number>();
  ads.forEach((ad) => {
    const key = ad.accountId + ":" + ad.campaignId;
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      indexByKey.set(key, idx);
      groups.push({ key, campaignName: ad.campaignName, accountName: ad.accountName, ads: [] });
    }
    groups[idx].ads.push(ad);
  });
  return groups;
}

export default function AnunciosView({ session }: { session: Session }) {
  // Plataformas: la elección es la MISMA en todas las pantallas (se recuerda en el navegador) y por
  // defecto están todas prendidas; cada persona apaga las que no quiere ver. Ver lib/usePlatformSelection.ts.
  const { selection: platformsEnabled, toggle: togglePlatform, ready: selectionReady } = usePlatformSelection(PLATFORMS.map((p) => p.key));
  const [datePreset, setDatePreset] = useState<DatePreset>("month");
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  // Un fetch por plataforma activa: cada una se carga, y puede fallar, por separado.
  const [dataByPlatform, setDataByPlatform] = useState<Partial<Record<PlatformKey, AdsResponse>>>({});
  const [statusByPlatform, setStatusByPlatform] = useState<Partial<Record<PlatformKey, "loading" | "done" | "error">>>({});
  const [errorByPlatform, setErrorByPlatform] = useState<Partial<Record<PlatformKey, string>>>({});
  const [reloadKey, setReloadKey] = useState(0);
  // Mismo filtro "Solo con actividad" que ya tienen Finanzas y Campañas
  // (MediosView.tsx), acá por anuncio. AdRow no trae "spend" (no se expone
  // a nivel anuncio, ver lib/windsorAds.ts), así que el criterio de
  // actividad es impressions > 0 — un anuncio recién descubierto por la
  // capa de discovery (pausado/sin correr en el período) llega con
  // impresiones en 0, igual que una campaña sin actividad llega con spend
  // en 0. Activado por defecto, mismo criterio que el resto del dashboard.
  const [onlyActive, setOnlyActive] = useState(true);
  // Selector de cuentas en la barra lateral — mismo patrón que "Clientes" en
  // Finanzas (Dashboard.tsx) y que el de Campañas (MediosView.tsx), acá a
  // nivel cuenta a partir de los anuncios cargados.
  const [accountKey, setAccountKey] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("default");
  // Buscador por nombre de anuncio o de campaña — filtra la grilla, no el
  // sidebar de cuentas (se busca DENTRO de lo que ya se está mostrando).
  const [searchQuery, setSearchQuery] = useState("");
  // Grupos de campaña colapsados manualmente — guarda la clave del grupo
  // (accountId:campaignId), no el estado "abierto" (así un grupo nuevo
  // siempre arranca expandido por defecto).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Miniaturas que fallaron al cargar (URL vencida, red, etc.) — cae al
  // bloque de color de siempre en vez de mostrar el ícono roto del navegador.
  const [brokenThumbs, setBrokenThumbs] = useState<Set<string>>(new Set());
  // Anuncio con el lightbox abierto (preview grande) — null = cerrado.
  const [lightboxAd, setLightboxAd] = useState<AdRow | null>(null);
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

  // Qué cuentas existen depende de la plataforma y el rango elegidos — si
  // cambia cualquiera de los dos, la cuenta elegida puede dejar de existir.
  useEffect(() => {
    setAccountKey("all");
  }, [enabledKeysDep, datePreset]);

  // Cierra el lightbox con Escape — patrón estándar de modal.
  useEffect(() => {
    if (!lightboxAd) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxAd(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [lightboxAd]);

  useEffect(() => {
    if (!selectionReady) return;
    setBrokenThumbs(new Set());
    const range = datePreset === "custom" ? "month" : datePreset;
    const keys = enabledKeysDep.split(",").filter(Boolean) as PlatformKey[];
    const startedAt = Date.now();
    setDataByPlatform({});
    setErrorByPlatform({});
    setStatusByPlatform(Object.fromEntries(keys.map((k) => [k, "loading"])));
    // Timeout del lado del cliente (35s, por encima del maxDuration de 30s de la ruta) — verificado en vivo 2026-09-21: la
    // consulta de anuncios de Meta se quedó colgada indefinidamente. El fetch server-side ya tiene su propio
    // timeout (ver lib/windsorAdsMeta.ts), pero esto asegura que la UI nunca se quede esperando para siempre.
    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60000);
    let pending = keys.length;
    let anyOk = false;
    keys.forEach((key) => {
      fetchJson<any>(`/api/ads?platform=${key}&range=${range}`, { signal: controller.signal })
        .then((body: AdsResponse) => {
          if (cancelled) return;
          anyOk = true;
          setDataByPlatform((prev) => ({ ...prev, [key]: body }));
          setStatusByPlatform((prev) => ({ ...prev, [key]: "done" }));
        })
        .catch((err) => {
          if (cancelled) return;
          const msg = err?.name === "AbortError" ? (timedOut ? "La consulta tardó demasiado (más de 60 s) y se canceló." : "") : String(err?.message || err);
          if (!msg) return;
          setErrorByPlatform((prev) => ({ ...prev, [key]: msg }));
          setStatusByPlatform((prev) => ({ ...prev, [key]: "error" }));
        })
        .finally(() => {
          if (cancelled) return;
          pending -= 1;
          if (pending === 0) clearTimeout(timeout);
          if (pending === 0 && anyOk) announceReady("Anuncios cargados", startedAt);
        });
    });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [selectionReady, enabledKeysDep, datePreset, reloadKey]);

  const loading = !selectionReady || enabledKeys.some((k) => (statusByPlatform[k] ?? "loading") === "loading");
  const failedKeys = enabledKeys.filter((k) => statusByPlatform[k] === "error");
  const loaded = !loading && enabledKeys.some((k) => statusByPlatform[k] === "done");
  const allFailed = !loading && !loaded;
  const sources: SourceStatus[] = enabledKeys.map((k) => ({
    label: PLATFORMS.find((p) => p.key === k)?.label ?? k,
    state: (statusByPlatform[k] ?? "loading") as SourceStatus["state"],
  }));
  const failedDetail = failedKeys.map((k) => `${PLATFORMS.find((p) => p.key === k)?.label ?? k}: ${errorByPlatform[k]}`).join(" | ");

  const activeLabel = enabledKeys.map((k) => PLATFORMS.find((p) => p.key === k)?.label ?? k).join(" + ");
  const dateLabel = DATE_PRESETS.find((d) => d.key === datePreset)?.label ?? "Este mes";
  const platformLabelOf = (k: PlatformKey) => PLATFORMS.find((p) => p.key === k)?.label ?? k;

  const allAds: MergedAd[] = [];
  enabledKeys.forEach((k) => {
    dataByPlatform[k]?.ads.forEach((ad) => allAds.push({ ...ad, platform: k }));
  });
  const allMock = enabledKeys.length > 0 && enabledKeys.every((k) => dataByPlatform[k]?.source === "mock");
  const mergedWarnings = [...new Set(enabledKeys.flatMap((k) => dataByPlatform[k]?.warnings ?? []))];

  // "Actividad" = impresiones reales > 0 (ver nota de onlyActive más
  // arriba). Alimenta el sidebar de cuentas y la grilla.
  const activeAds = onlyActive ? allAds.filter((ad) => ad.impressions > 0) : allAds;

  // Cuentas para el sidebar, a partir de los anuncios ya filtrados por
  // actividad (sin duplicar por anuncio).
  const accountMap = new Map<string, string>();
  activeAds.forEach((ad) => {
    if (!accountMap.has(ad.accountId)) accountMap.set(ad.accountId, ad.accountName);
  });
  const accounts = [...accountMap.entries()].map(([accountId, accountName]) => ({ accountId, accountName }));
  const accountFilteredAds = accountKey === "all" ? activeAds : activeAds.filter((ad) => ad.accountId === accountKey);

  // Buscador — sobre nombre de anuncio o de campaña, no toca el sidebar de
  // cuentas (se busca dentro de la cuenta/plataforma ya elegida).
  const searchTerm = searchQuery.trim().toLowerCase();
  const visibleAds = searchTerm
    ? accountFilteredAds.filter(
        (ad) => ad.adName.toLowerCase().includes(searchTerm) || ad.campaignName.toLowerCase().includes(searchTerm)
      )
    : accountFilteredAds;
  const campaignGroups = groupByCampaign(visibleAds);

  function toggleGroupCollapsed(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="wrap">
      <MediosHeader sub="Rendimiento por campaña — equipo Medios, Taquión" session={session} />
      <MediosSubnav current="/medios/anuncios" session={session} />

      {mergedWarnings.map((w, i) => (
        <div className="mock-note" key={i}>
          <span className="tq-arrow" style={{ color: "var(--status-warning)" }}>↘</span> <span>{w}</span>
        </div>
      ))}
      {allMock && mergedWarnings.length === 0 && (
        <div className="mock-note">
          <span className="tq-arrow">↘</span>{" "}
          <span>
            <b>Datos de ejemplo.</b> En cuanto haya anuncios reales de {activeLabel} en Windsor.ai, se muestran acá.
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
          <button className="toggle-chip" aria-pressed={onlyActive} onClick={() => setOnlyActive((v) => !v)}>
            <span className="toggle-track">
              <span className="toggle-knob" />
            </span>
            Solo con actividad
          </button>
          <div className="chip-row" role="group" aria-label="Ordenar anuncios dentro de cada campaña">
            {SORT_OPTIONS.map((o) => (
              <button key={o.key} className="chip" aria-pressed={sortKey === o.key} onClick={() => setSortKey(o.key)}>
                {o.label}
              </button>
            ))}
          </div>
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

      {loading && (
        <LoadingPanel what="los anuncios" sources={sources}>
          <div className="ad-grid" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div className="ad-card ad-skeleton" key={i}>
                <div className="ad-thumb ad-skeleton-block" />
                <div className="ad-body">
                  <div className="ad-skeleton-block ad-skeleton-line" />
                  {Array.from({ length: 4 }).map((_, j) => (
                    <div className="ad-skeleton-block ad-skeleton-row" key={j} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </LoadingPanel>
      )}
      {allFailed && <ErrorPanel what="Anuncios" detail={failedDetail} onRetry={() => setReloadKey((k) => k + 1)} />}
      {loaded && failedKeys.length > 0 && (
        <ErrorPanel compact what={`los anuncios de ${failedKeys.map(platformLabelOf).join(" y ")}`} detail={failedDetail} onRetry={() => setReloadKey((k) => k + 1)} />
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
              <div style={{ color: "var(--text-muted)", fontSize: 12.5, padding: "8px 10px" }}>Sin cuentas para mostrar.</div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
        <div className="card">
          <h2>Anuncios — {activeLabel}</h2>
          <div className="card-sub">Un nivel más de detalle que la tabla de campañas — mismas métricas, ahora por pieza individual.</div>

          <input
            type="text"
            className="ad-search-input"
            placeholder="Buscar por anuncio o campaña…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          {visibleAds.length === 0 ? (
            <div style={{ color: "var(--text-muted)", marginTop: 14 }}>
              {allAds.length === 0 ? "Sin anuncios para mostrar." : "Sin anuncios con los filtros elegidos."}
            </div>
          ) : (
            campaignGroups.map((g) => {
              const isCollapsed = collapsedGroups.has(g.key);
              const best = bestAdInGroup(g.ads, sortKey);
              return (
                <div className="ad-campaign-group" key={g.key}>
                  <button
                    type="button"
                    className="ad-campaign-heading"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroupCollapsed(g.key)}
                  >
                    <span className="ad-campaign-toggle">{isCollapsed ? "▸" : "▾"}</span>
                    {g.campaignName}
                    <span className="ad-campaign-account">{g.accountName}</span>
                    <span className="ad-campaign-count">
                      {g.ads.length} anuncio{g.ads.length === 1 ? "" : "s"}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="ad-grid">
                      {sortAdsBy(g.ads, sortKey).map((ad) => {
                        const hasThumb = !!ad.thumbnailUrl && !brokenThumbs.has(ad.adId);
                        return (
                          <div className="ad-card" key={ad.adId}>
                            <div
                              className="ad-thumb"
                              role={hasThumb ? "button" : undefined}
                              tabIndex={hasThumb ? 0 : undefined}
                              aria-label={hasThumb ? `Ver creativo de ${ad.adName}` : undefined}
                              onClick={hasThumb ? () => setLightboxAd(ad) : undefined}
                              onKeyDown={
                                hasThumb
                                  ? (e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        setLightboxAd(ad);
                                      }
                                    }
                                  : undefined
                              }
                              style={
                                !hasThumb && ad.platform !== "google"
                                  ? { background: `linear-gradient(135deg, var(--plat-${ad.platform}), color-mix(in srgb, var(--plat-${ad.platform}) 55%, #000))` }
                                  : undefined
                              }
                            >
                              {best?.adId === ad.adId && <span className="ad-best-badge">{best.label}</span>}
                              {ad.videoVariantCount && <span className="ad-variant-badge">+{ad.videoVariantCount - 1}</span>}
                              {hasThumb ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={ad.thumbnailUrl}
                                  alt=""
                                  className="ad-thumb-img"
                                  loading="lazy"
                                  onError={() => setBrokenThumbs((prev) => new Set(prev).add(ad.adId))}
                                />
                              ) : (
                                platformLabelOf(ad.platform)
                              )}
                            </div>
                            <div className="ad-body">
                              <div className="ad-name" title={ad.adName}>{ad.adName}</div>
                              <div className="ad-metric-row"><span>Impresiones</span><span className="num">{fmtInt(ad.impressions)}</span></div>
                              <div className="ad-metric-row"><span>Clicks</span><span className="num">{fmtInt(ad.clicks)}</span></div>
                              <div className="ad-metric-row"><span>Gasto</span><span className="num">{fmtMoney(ad.spend)}</span></div>
                              <div className="ad-metric-row"><span>CPM</span><span className="num">{fmtMoney(ad.cpm)}</span></div>
                              <div className="ad-metric-row"><span>CTR</span><span className="num">{ad.ctr.toFixed(1)}%</span></div>
                              {(ad.platform === "meta" || ad.platform === "tiktok") && (
                                <div className="ad-metric-row">
                                  <span>Seguidores ganados</span>
                                  <span className="num" title={ad.followers === undefined ? "No se pudo cargar esta métrica. Tocá Reintentar o volvé a abrir la pantalla en unos minutos." : undefined}>
                                    {ad.followers === undefined ? "—" : fmtInt(ad.followers)}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        </div>
      </div>
      )}

      {lightboxAd && (
        <div className="ad-lightbox-overlay" onClick={() => setLightboxAd(null)}>
          <div className="ad-lightbox" onClick={(e) => e.stopPropagation()}>
            <button className="ad-lightbox-close" aria-label="Cerrar" onClick={() => setLightboxAd(null)}>
              ✕
            </button>
            <div className="ad-lightbox-media">
              {lightboxAd.youtubeVideoId ? (
                <iframe
                  src={`https://www.youtube.com/embed/${lightboxAd.youtubeVideoId}`}
                  title={lightboxAd.adName}
                  allow="autoplay; encrypted-media"
                  allowFullScreen
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={lightboxAd.thumbnailUrl} alt="" />
              )}
            </div>
            <div className="ad-lightbox-info">
              <div className="ad-lightbox-name">{lightboxAd.adName}</div>
              <div className="ad-lightbox-campaign">
                {lightboxAd.campaignName} · {lightboxAd.accountName}
              </div>
              {lightboxAd.videoVariantCount && (
                <div className="ad-lightbox-note">
                  Este anuncio rota {lightboxAd.videoVariantCount} videos distintos — se muestra uno de ellos.
                </div>
              )}
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
