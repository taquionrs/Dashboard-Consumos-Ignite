/**
 * Novedades de Pulso: lo que se muestra al tocar la campanita del encabezado.
 *
 * Es una lista escrita a mano en este archivo (sin base de datos): cada PR que
 * cambia algo que el equipo ve agrega UNA entrada arriba de todo. Ver
 * docs/how-to/agregar-una-novedad.md.
 *
 * Reglas:
 * - Más nueva primero. El `id` es único y estable (no se reutiliza ni se cambia:
 *   la campanita recuerda en el navegador cuál fue la última que se vio).
 * - Texto en lenguaje simple, para quien usa Pulso (no para quien lo programa).
 */

export type NovedadTipo = "nuevo" | "mejora" | "cambio" | "arreglo";
export type NovedadArea = "general" | "finanzas" | "medios" | "alertas";

export interface Novedad {
  id: string;
  /** YYYY-MM-DD */
  fecha: string;
  tipo: NovedadTipo;
  area: NovedadArea;
  titulo: string;
  detalle: string;
  /** Pantalla donde se ve el cambio (opcional). */
  ruta?: string;
}

export const TIPO_LABEL: Record<NovedadTipo, string> = {
  nuevo: "Nuevo",
  mejora: "Mejora",
  cambio: "Cambio",
  arreglo: "Arreglo",
};

export const AREA_LABEL: Record<NovedadArea, string> = {
  general: "Todo Pulso",
  finanzas: "Finanzas",
  medios: "Medios",
  alertas: "Alertas",
};

export const NOVEDADES: Novedad[] = [
  {
    id: "2026-10-09-plataformas-y-estados",
    fecha: "2026-10-09",
    tipo: "mejora",
    area: "general",
    titulo: "Todas las plataformas prendidas y avisos de carga más claros",
    detalle:
      "Al entrar, todas las plataformas vienen seleccionadas y tu elección te acompaña al cambiar de pantalla. Mientras algo carga ves en qué etapa va (cargando, en proceso, ya casi) y un Listo al terminar. Si una pantalla falla, ahora dice a quién avisar y cuánto se estima que tarda el arreglo. La campanita y el menú ya no desaparecen cuando algo falla.",
  },
  {
    id: "2026-10-09-seguidores-siempre",
    fecha: "2026-10-09",
    tipo: "arreglo",
    area: "medios",
    titulo: "Anuncios: los seguidores ganados ya no desaparecen",
    detalle:
      "En Meta y TikTok cada anuncio muestra siempre la fila de seguidores ganados: el número real (0 si no ganó ninguno) o un guion si en ese momento no se pudo cargar. Antes, si esa consulta fallaba, la métrica desaparecía en silencio varios minutos.",
    ruta: "/medios/anuncios",
  },
  {
    id: "2026-10-07-novedades",
    fecha: "2026-10-07",
    tipo: "nuevo",
    area: "general",
    titulo: "Esta campanita: novedades de Pulso",
    detalle: "Acá vas a ver las funciones nuevas y los cambios. El puntito rosa te avisa cuando hay algo que todavía no viste.",
  },
  {
    id: "2026-10-02-alertas-pantalla",
    fecha: "2026-10-02",
    tipo: "nuevo",
    area: "alertas",
    titulo: "Medios → Alertas: el registro de cada alerta enviada",
    detalle:
      "Cada alerta que llega al espacio IGNITE queda guardada. Podés marcarla como revisada o descartarla con un motivo, ver cuántas veces se repite y leer el mensaje exacto que se envió. Nada se borra: queda el historial.",
    ruta: "/medios/alertas",
  },
  {
    id: "2026-10-02-resumen-completo",
    fecha: "2026-10-02",
    tipo: "arreglo",
    area: "alertas",
    titulo: "El resumen sale completo aunque Windsor tarde",
    detalle: "Antes, si Windsor tardaba en responder, el resumen de los martes y jueves podía salir sin los anuncios de Meta. Ahora espera lo necesario.",
  },
  {
    id: "2026-10-01-resumen-alertas",
    fecha: "2026-10-01",
    tipo: "nuevo",
    area: "alertas",
    titulo: "Resumen de alertas al espacio IGNITE (martes y jueves, 8:00)",
    detalle:
      "Gasto contra lo proyectado (proyección a fin de mes, presupuesto del mes próximo, hoja de proyectados) y performance de anuncios (costo por seguidor, variación contra la semana anterior, frecuencia y CTR bajo el de su campaña).",
    ruta: "/medios/alertas",
  },
  {
    id: "2026-10-01-presupuesto-diario",
    fecha: "2026-10-01",
    tipo: "mejora",
    area: "medios",
    titulo: "Presupuesto diario recomendado: el monto exacto por día",
    detalle:
      "Ahora se ve como “$164.747 x día”, con el cambio respecto de tu ritmo actual entre paréntesis (desde el día 3 del mes). Va en verde cuando hay que subir el gasto diario.",
    ruta: "/medios",
  },
  {
    id: "2026-10-01-montos-completos",
    fecha: "2026-10-01",
    tipo: "mejora",
    area: "general",
    titulo: "Montos completos y “Total proyectado”",
    detalle: "El total proyectado y el total gastado se muestran completos, sin abreviar ($5.000.000, no $5M). Además, “Total presupuesto” pasó a llamarse “Total proyectado”.",
  },
  {
    id: "2026-10-01-seguidores",
    fecha: "2026-10-01",
    tipo: "nuevo",
    area: "medios",
    titulo: "Anuncios: seguidores ganados por anuncio",
    detalle: "En Meta y TikTok, cada anuncio muestra cuántos seguidores ganó en el período.",
    ruta: "/medios/anuncios",
  },
  {
    id: "2026-10-01-sin-conversiones",
    fecha: "2026-10-01",
    tipo: "cambio",
    area: "medios",
    titulo: "Anuncios: se quitaron Conversiones y CPL",
    detalle: "Por ahora no hacían falta. Los datos siguen disponibles si más adelante se necesitan de nuevo.",
    ruta: "/medios/anuncios",
  },
  {
    id: "2026-09-30-datos-estables",
    fecha: "2026-09-30",
    tipo: "arreglo",
    area: "general",
    titulo: "Datos más estables y rápidos",
    detalle:
      "Si Windsor falla o tarda, Pulso ya no muestra datos de ejemplo como si fueran reales: avisa con el motivo y un botón “Reintentar”, o muestra los últimos datos con la hora de la actualización. Las pantallas también cargan más rápido.",
  },
];

/** Cuántas novedades hay más nuevas que la última que vio esta persona (en este navegador). */
export function countUnseen(seenId: string | null, list: Novedad[] = NOVEDADES): number {
  if (!seenId) return list.length;
  const idx = list.findIndex((n) => n.id === seenId);
  return idx === -1 ? list.length : idx;
}

/** ¿Esta novedad es nueva respecto de la última que se había visto? */
export function isUnseen(id: string, seenId: string | null, list: Novedad[] = NOVEDADES): boolean {
  const idx = list.findIndex((n) => n.id === id);
  if (idx === -1) return false;
  return idx < countUnseen(seenId, list);
}
