import type { PlatformKey } from "./types";

/**
 * Plataformas con datos REALES conectados (vía Windsor.ai). Las que no estén acá (hoy LinkedIn Ads) no
 * se pueden prender en ninguna pantalla: no tienen datos reales y solo sumarían ruido y tiempo de carga.
 * Para conectar una nueva: agregarla acá y a los fetchers de /api/* (ver docs/how-to/conectar-windsor.md).
 * Archivo sin dependencias del servidor: lo usan las pantallas (cliente) y las rutas /api (servidor).
 */
export const CONNECTED_PLATFORMS: PlatformKey[] = ["google", "meta", "tiktok"];

export function isConnected(key: PlatformKey): boolean {
  return CONNECTED_PLATFORMS.includes(key);
}
