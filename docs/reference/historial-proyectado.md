# Historial del presupuesto proyectado

La hoja de proyectados solo muestra lo que el equipo tiene cargado hoy. Si al cargar un mes nuevo se pisan o borran las filas del anterior, ese dato se perdería. Pulso guarda una **foto de cada mes** para que "Mes anterior" (y los meses de un rango propio) sigan mostrando lo que se proyectó en ese momento.

## Cómo funciona
- El cron diario (`/api/cron/calentar`, ~7:30 hs de Argentina) lee la hoja y guarda, en Upstash Redis, una foto por cada mes que tenga filas (clave `pulso:proyectado:AAAA-MM`; código en [`lib/proyectadoHistorial.ts`](../../lib/proyectadoHistorial.ts)).
- Mientras el mes está en curso (o es futuro) la foto se **actualiza todos los días**, así que queda con la última versión que tuvo la hoja.
- Cuando el mes pasa, la foto queda **congelada**: el cron no la vuelve a escribir (`SET ... NX`), aunque después alguien edite la hoja. El primer cron que corre con un mes pasado todavía en la hoja y sin foto la guarda.
- Al pedir un mes pasado, Pulso usa la foto; si no hay foto, usa la hoja. El mes en curso siempre sale de la hoja. Si la hoja no responde y todos los meses pedidos tienen foto, igual se muestra el proyectado.
- Una lectura vacía de la hoja no borra nada: un mes sin filas no se escribe.

## Qué hay que saber
- **Historial hacia atrás:** empieza con el primer cron que corra tras el despliegue. Un mes cuyas filas ya no estén en la hoja no se puede reconstruir.
- Sin Upstash Redis configurado no se guarda nada y Pulso funciona como antes (solo con la hoja).
- La respuesta del cron incluye `proyectado` con los meses `guardados` y `congelados`, o el `error`. Para correrlo a mano: `GET /api/cron/calentar` con `Authorization: Bearer <CRON_SECRET>`.
