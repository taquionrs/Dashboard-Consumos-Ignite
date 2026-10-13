# Pulso Ignite (V2)

Dashboard interno de Taquión para monitorear consumo de pauta publicitaria multi-cliente (Meta Ads, Google Ads, LinkedIn Ads, TikTok Ads). Next.js + TypeScript, deployado en Vercel.

- **En producción:** https://dashboard-consumos-ignite.vercel.app
- **V1 (mock estático, sin backend):** [`SDD-TAQUION/mockups/dashboard-consumos.html`](../SDD-TAQUION/mockups/dashboard-consumos.html)
- **Spec de producto:** [`SDD-TAQUION/specs/003-dashboard-consumos.md`](../SDD-TAQUION/specs/003-dashboard-consumos.md)

## 📚 Documentación

La documentación completa vive en [`docs/`](./docs/index.md), organizada por lo que necesites en el momento:

- **[Tutoriales (Tutorials)](./docs/tutorials/)** — levantar el proyecto por primera vez.
- **[Guías prácticas (How-To Guides)](./docs/how-to/)** — conectar Google Ads, deployar a Vercel, agregar una plataforma nueva.
- **[Referencia (Reference)](./docs/reference/)** — estructura del proyecto, API, variables de entorno, tokens de diseño.
- **[Explicación (Explanation)](./docs/explanation/)** — por qué la arquitectura de datos es así, por qué la UI es una tabla operativa densa, estado y limitaciones actuales.

## Inicio rápido (Quick Start)

```bash
npm install
npm run dev
```

Abrí `http://localhost:3000` — funciona con datos de ejemplo sin ninguna variable de entorno. Guía completa: [levantar el proyecto por primera vez](./docs/tutorials/getting-started.md).

**Acceso:** en producción se entra con el SSO de Taquion (Cloudflare Zero Trust), y cada persona ve solo las páginas que le habilitó un administrador en **Usuarios** (`/usuarios`). Ver [configurar el login con SSO](./docs/how-to/configurar-sso-cloudflare.md).

## Qué falta (backlog conocido)

- **Google Ads + Meta Ads + TikTok Ads ya están conectados en vivo vía Windsor.ai** (Finanzas y las 3 vistas de Medios/Ignite) — lo que sigue pendiente es LinkedIn Ads, bloqueado por el plan Basic de Windsor (3 fuentes simultáneas, ya ocupadas — ver [estado y limitaciones](./docs/explanation/estado-y-limitaciones.md#por-qué-linkedin-ads-sigue-siendo-mock)).
- Crear proyecto Supabase (Free) y migrar el almacenamiento de "mock + intento en vivo" a "leer de Supabase" (histórico real).
- Mapeo real cliente↔cuenta — hoy las cuentas reales aparecen por su nombre en la plataforma publicitaria, no por cliente interno de Taquión — ver [estado y limitaciones](./docs/explanation/estado-y-limitaciones.md#todos-los-clientes-del-dashboard-son-ficticios).
- Persistencia/histórico real por día en Finanzas (el gráfico de "Ritmo de consumo" hoy se estima con un patrón semanal genérico sobre el acumulado real).
- Rango de fecha "Personalizado" — todavía no está conectado en ninguna de las 4 vistas, cae a "Este mes".
- Tests automatizados — no hay ninguno todavía.
