"use client";

import type { ReactNode } from "react";
import NovedadesBell from "./NovedadesBell";
import SessionLinks from "./SessionLinks";
import type { PageKey, Session } from "@/lib/access";

/**
 * Encabezado y sub-navegación comunes. Se dibujan SIEMPRE, también mientras la
 * pantalla carga o si falla: así la campanita y los enlaces nunca desaparecen.
 * Los enlaces y las pestañas muestran solo lo que el usuario tiene habilitado
 * (sesión que arma middleware.ts; ver lib/access.ts).
 */

export function PageHeader({ title, sub, session, current, extra }: { title: string; sub: string; session: Session; current: "finanzas" | "medios" | "usuarios" | "equivalencias"; extra?: ReactNode }) {
  return (
    <header className="top">
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/taquion-isotipo.png" alt="Taquión" className="brand-mark" width={30} height={30} />
        <div>
          <h1>{title}</h1>
          <div className="sub">{sub}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ textAlign: "right" }}>
          {extra}
          <div style={{ display: "flex", gap: 14, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <SessionLinks session={session} current={current} />
          </div>
        </div>
        <NovedadesBell />
      </div>
    </header>
  );
}

const MEDIOS_TABS: { key: PageKey; href: string; label: string }[] = [
  { key: "campanas", href: "/medios", label: "Campañas" },
  { key: "anuncios", href: "/medios/anuncios", label: "Anuncios" },
  { key: "comparacion", href: "/medios/comparacion", label: "Comparación de plataformas" },
  { key: "alertas", href: "/medios/alertas", label: "Alertas" },
];

/** Pestañas de Medios: solo las páginas que el usuario tiene habilitadas. */
export function MediosSubnav({ current, session }: { current: string; session: Session }) {
  return (
    <nav className="medios-subnav">
      {MEDIOS_TABS.filter((t) => session.pages.includes(t.key)).map((t) => (
        <a key={t.href} href={t.href} aria-current={t.href === current ? "page" : undefined}>
          {t.label}
        </a>
      ))}
    </nav>
  );
}

export function MediosHeader({ sub, session }: { sub: string; session: Session }) {
  return <PageHeader title="Pulso Ignite — Medios" sub={sub} session={session} current="medios" />;
}
