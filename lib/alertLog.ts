import type { AlertDraft, AlertRecord, ModerationInput, RunRecord } from "./alertTypes";
import { isValidAlertId } from "./alertTypes";
import { readStoreConfig, redisPipeline, type Cmd, type StoreConfig } from "./redis";

export { readStoreConfig };

/**
 * Registro persistente de las alertas enviadas por el cron — la base de la
 * pantalla "Alertas" de Medios (trazabilidad y moderación).
 *
 * Almacenamiento: Redis de Upstash (Vercel → Storage → Upstash Redis), vía su
 * API REST (cliente en lib/redis.ts, compartido con el registro de usuarios).
 *
 * Claves (todas con prefijo `pulso:alerts:` por si la base se comparte):
 *   run:<runId>        JSON de RunRecord
 *   alert:<alertId>    JSON de AlertRecord
 *   runs               zset de runIds por fecha de envío
 *   index              zset de alertIds por fecha de envío
 *
 * Los errores NUNCA incluyen la URL ni el token.
 *
 * SOLO SERVER-SIDE.
 */

const P = "pulso:alerts:";
const K = {
  run: (id: string) => `${P}run:${id}`,
  alert: (id: string) => `${P}alert:${id}`,
  runs: `${P}runs`,
  index: `${P}index`,
};

export const MAX_ALERTS_LISTED = 500;
export const MAX_RUNS_LISTED = 60;
const MAX_HISTORY = 50;

const pipeline = (cfg: StoreConfig, commands: Cmd[]) => redisPipeline(cfg, commands, "almacenamiento de alertas");

const parse = <T>(raw: unknown): T | null => {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export function newRunId(now: number = Date.now()): string {
  return now.toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Guarda un envío y todas sus alertas (estado inicial: pendiente). */
export async function saveRun(run: RunRecord, drafts: AlertDraft[]): Promise<AlertRecord[]> {
  const cfg = readStoreConfig();
  if (!cfg) throw new Error("El almacenamiento de alertas no está configurado.");
  const ts = Date.parse(run.sentAt);
  const records: AlertRecord[] = drafts.map((d, i) => ({
    ...d,
    id: `${run.id}-${i + 1}`,
    runId: run.id,
    sentAt: run.sentAt,
    status: "pending",
    history: [],
  }));
  const commands: Cmd[] = [
    ["SET", K.run(run.id), JSON.stringify(run)],
    ["ZADD", K.runs, ts, run.id],
  ];
  records.forEach((r, i) => {
    commands.push(["SET", K.alert(r.id), JSON.stringify(r)]);
    // ts*1000 + posición: conserva el orden de las alertas dentro de un mismo envío.
    commands.push(["ZADD", K.index, ts * 1000 + i, r.id]);
  });
  await pipeline(cfg, commands);
  return records;
}

/** Las alertas y los envíos más recientes, del más nuevo al más viejo. */
export async function listLog(): Promise<{ alerts: AlertRecord[]; runs: RunRecord[] }> {
  const cfg = readStoreConfig();
  if (!cfg) throw new Error("El almacenamiento de alertas no está configurado.");
  const [alertIds, runIds] = await pipeline(cfg, [
    ["ZREVRANGE", K.index, 0, MAX_ALERTS_LISTED - 1],
    ["ZREVRANGE", K.runs, 0, MAX_RUNS_LISTED - 1],
  ]);
  const aIds: string[] = Array.isArray(alertIds) ? alertIds : [];
  const rIds: string[] = Array.isArray(runIds) ? runIds : [];
  const commands: Cmd[] = [];
  if (aIds.length) commands.push(["MGET", ...aIds.map(K.alert)]);
  if (rIds.length) commands.push(["MGET", ...rIds.map(K.run)]);
  const results = commands.length ? await pipeline(cfg, commands) : [];
  const alertsRaw: unknown[] = aIds.length ? results[0] ?? [] : [];
  const runsRaw: unknown[] = rIds.length ? results[aIds.length ? 1 : 0] ?? [] : [];
  return {
    alerts: alertsRaw.map((r) => parse<AlertRecord>(r)).filter((r): r is AlertRecord => r !== null),
    runs: runsRaw.map((r) => parse<RunRecord>(r)).filter((r): r is RunRecord => r !== null),
  };
}

/** Cambia el estado de una alerta y agrega la entrada al historial. null = no existe. */
export async function moderateAlert(id: string, input: ModerationInput): Promise<AlertRecord | null> {
  if (!isValidAlertId(id)) return null;
  const cfg = readStoreConfig();
  if (!cfg) throw new Error("El almacenamiento de alertas no está configurado.");
  const [raw] = await pipeline(cfg, [["GET", K.alert(id)]]);
  const rec = parse<AlertRecord>(raw);
  if (!rec) return null;
  const at = new Date().toISOString();
  const updated: AlertRecord = {
    ...rec,
    status: input.status,
    note: input.note,
    reviewedBy: input.status === "pending" ? undefined : input.by,
    reviewedAt: input.status === "pending" ? undefined : at,
    history: [...(rec.history ?? []), { at, by: input.by, from: rec.status, to: input.status, note: input.note }].slice(-MAX_HISTORY),
  };
  await pipeline(cfg, [["SET", K.alert(id), JSON.stringify(updated)]]);
  return updated;
}
