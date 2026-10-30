import { CORTES_PATH, EQUIVALENCIAS_PATH, MEDIOS_PAGES, PAGES, USERS_PATH, type Session } from "@/lib/access";

const muted = { fontSize: 12.5, color: "var(--text-muted)" };

/**
 * Encabezado: links a las otras secciones que el usuario tiene habilitadas
 * (Finanzas, Medios, Usuarios) y la cuenta con la que entró, con la salida.
 */
export default function SessionLinks({ session, current }: { session: Session; current: "finanzas" | "medios" | "usuarios" | "equivalencias" | "cortes" }) {
  const medios = PAGES.find((p) => MEDIOS_PAGES.includes(p.key) && session.pages.includes(p.key));
  return (
    <>
      {current !== "finanzas" && session.pages.includes("finanzas") && (
        <a href="/" style={muted}>
          Ver perfil Finanzas →
        </a>
      )}
      {current !== "medios" && medios && (
        <a href={medios.path} style={muted}>
          Ver perfil Medios →
        </a>
      )}
      {current !== "cortes" && session.pages.includes("finanzas") && (
        <a href={CORTES_PATH} style={muted}>
          Cortes
        </a>
      )}
      {current !== "equivalencias" && session.pages.includes("finanzas") && (
        <a href={EQUIVALENCIAS_PATH} style={muted}>
          Equivalencias
        </a>
      )}
      {current !== "usuarios" && session.admin && (
        <a href={USERS_PATH} style={muted}>
          Usuarios
        </a>
      )}
      {session.email && (
        <span style={muted}>
          {session.email} ·{" "}
          <a href="/auth/logout" style={{ color: "inherit" }}>
            Salir
          </a>
        </span>
      )}
    </>
  );
}
