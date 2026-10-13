# Agregar una novedad a la campanita

La campanita del encabezado de Pulso muestra las funciones nuevas y los cambios. La lista vive en [`lib/novedades.ts`](../../lib/novedades.ts): no hay base de datos, así que **cada PR que cambia algo que el equipo ve agrega una entrada**.

## Cómo

Agregá un objeto **arriba de todo** en `NOVEDADES`:

```ts
{
  id: "2026-10-15-nombre-corto",   // único y estable: no se cambia ni se reutiliza
  fecha: "2026-10-15",              // YYYY-MM-DD
  tipo: "nuevo",                    // "nuevo" | "mejora" | "cambio" | "arreglo"
  area: "medios",                   // "general" | "finanzas" | "medios" | "alertas"
  titulo: "Qué cambió, en pocas palabras",
  detalle: "Una o dos frases para quien usa Pulso: qué ve ahora y para qué le sirve.",
  ruta: "/medios/anuncios",         // opcional: pantalla donde se ve el cambio
},
```

## Cómo escribirla

- **Lenguaje simple**, para quien usa Pulso, no para quien lo programa: "Ahora ves…", "Antes… ahora…".
- Una novedad por cambio que el equipo note. Los arreglos internos que nadie ve no hacen falta.
- No pongas datos de clientes ni claves.

## Cómo funciona lo de "sin ver"

El puntito con el número cuenta las novedades **más nuevas que la última que esa persona vio**. Al abrir la campanita se marcan como vistas y el puntito se apaga; dentro del panel, las que eran nuevas se resaltan con "Sin ver" hasta que se cierra.

⚠️ Lo visto se recuerda **en cada navegador** (no por usuario). En otro navegador o en una ventana privada, vuelve a aparecer todo como nuevo. Ahora que hay login con SSO, se podría guardar por persona.

## Qué se verifica

El `id` tiene que ser único y la lista tiene que estar ordenada de la más nueva a la más vieja: si no, el contador de "sin ver" da mal.
