"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlatformKey } from "./types";

/**
 * Plataformas elegidas (Meta, Google, TikTok, LinkedIn), compartidas entre TODAS las
 * pantallas de Pulso (Finanzas y las de Medios): se elige una vez y la elección
 * acompaña al usuario al cambiar de pantalla. Por defecto están todas prendidas;
 * cada persona apaga las que no quiere ver.
 *
 * Se recuerda en el navegador (localStorage). Si el navegador no deja guardar, la
 * pantalla funciona igual: arranca con todas prendidas en cada visita.
 */

const STORAGE_KEY = "pulso.plataformas";
const ALL: PlatformKey[] = ["google", "meta", "tiktok", "linkedin"];

export type PlatformSelection = Record<PlatformKey, boolean>;

function allOn(): PlatformSelection {
  return { google: true, meta: true, tiktok: true, linkedin: true };
}

function read(): PlatformSelection {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return allOn();
    const parsed = JSON.parse(raw) as Partial<Record<PlatformKey, unknown>>;
    const out = allOn();
    for (const k of ALL) if (parsed[k] === false) out[k] = false;
    return out;
  } catch {
    return allOn();
  }
}

function write(sel: PlatformSelection) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sel));
  } catch {
    // sin almacenamiento local: no se recuerda la elección
  }
}

/**
 * `available`: las plataformas que esa pantalla puede mostrar (Medios no tiene LinkedIn
 * conectado). Siempre queda al menos una prendida de las disponibles.
 * `ready` pasa a true cuando ya se leyó lo guardado: conviene esperar a que sea true
 * para pedir los datos y no hacer dos consultas (una con todo prendido y otra con lo guardado).
 */
export function usePlatformSelection(available: PlatformKey[]) {
  const [selection, setSelection] = useState<PlatformSelection>(allOn);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSelection(read());
    setReady(true);
  }, []);

  const toggle = useCallback(
    (key: PlatformKey) => {
      setSelection((prev) => {
        const onCount = available.filter((k) => prev[k]).length;
        if (prev[key] && onCount <= 1) return prev; // la última prendida no se apaga
        const next = { ...prev, [key]: !prev[key] };
        write(next);
        return next;
      });
    },
    [available.join(",")] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Si lo guardado dejara a la pantalla sin ninguna plataforma disponible, se prenden todas.
  const effective: PlatformSelection = available.some((k) => selection[k]) ? selection : { ...selection, ...Object.fromEntries(available.map((k) => [k, true])) };

  return { selection: effective, toggle, ready };
}
