# Documentación de Pulso Ignite

Esta documentación está organizada según el método **Diátaxis**: cuatro carpetas separadas según lo que necesitás en el momento, no según el tema. Antes de buscar algo, preguntate qué querés hacer ahora mismo:

| Si querés... | Mirá en... |
|---|---|
| Aprender el proyecto de punta a punta, corriéndolo por primera vez | [`tutorials/`](./tutorials/) |
| Resolver una tarea puntual que ya sabés que tenés que hacer (conectar algo, deployar, agregar una plataforma) | [`how-to/`](./how-to/) |
| Buscar un dato técnico exacto (una variable de entorno, la forma de la respuesta de la API, un token de diseño) | [`reference/`](./reference/) |
| Entender el porqué de una decisión (arquitectura de datos, diseño de la UI, estado actual del proyecto) | [`explanation/`](./explanation/) |

## Tutoriales (Tutorials)
- [Levantar el proyecto por primera vez](./tutorials/getting-started.md)

## Guías prácticas (How-To Guides)
- [Conectar Windsor.ai (Google Ads)](./how-to/conectar-windsor.md) — vía prioritaria
- [Conectar Google Ads API directo](./how-to/conectar-google-ads.md) — fallback, ver nota en la guía
- [Deployar a Vercel](./how-to/deploy-a-vercel.md)
- [Configurar el login con SSO (Cloudflare Zero Trust) y los usuarios](./how-to/configurar-sso-cloudflare.md)
- [Agregar una plataforma nueva al dashboard](./how-to/agregar-una-plataforma.md)

## Referencia (Reference)
- [Estructura del proyecto](./reference/estructura-del-proyecto.md)
- [API — `GET /api/spend`](./reference/api-spend.md)
- [APIs de Medios — `/api/campaigns`, `/api/ads`, `/api/platform-comparison`](./reference/api-medios.md)
- [Variables de entorno](./reference/variables-de-entorno.md)
- [Tokens de diseño (colores, tipografía)](./reference/design-tokens.md)

## Explicación (Explanation)
- [Decisión de arquitectura de datos](./explanation/arquitectura-de-datos.md)
- [Por qué la UI es una tabla operativa densa](./explanation/diseno-ui-vista-operativa.md)
- [Estado actual y limitaciones conocidas](./explanation/estado-y-limitaciones.md)
- [Relación con la V1 y el proceso de spec](./explanation/relacion-con-v1-y-spec.md)
