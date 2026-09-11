/**
 * Normalizacion defensiva de fechas del Semaforo.
 *
 * `tablero-api` no garantiza un solo tipo por campo. Verificado contra prod el 2026-09-09
 * (801 registros, 3 paginas): `updated_at` llega como ISO string en 534 registros y como
 * epoch en milisegundos (number) en 267. `init_course`/`end_course` llegan como `YYYY-MM-DD`,
 * pero nada en el contrato lo obliga — el frontend del Semaforo ya se defiende de ISO con `T`
 * (`parseLocalDate` en `useSenceData.ts:39`).
 *
 * Todo dato de fecha que entra desde tablero-api pasa por aca ANTES de tocar la logica de
 * clasificacion, para que `getCourseWeek` y las comparaciones de dias reciban siempre un
 * `YYYY-MM-DD` limpio y nunca un `NaN` silencioso (un `NaN` en `getCourseWeek` cae en semana 1
 * y cambia el nivel del curso sin que nadie se entere).
 */

/** Epoch en segundos vs milisegundos: 10 digitos son segundos, 13 son milisegundos. */
const MAX_EPOCH_SECONDS = 100_000_000_000; // ~5138 d.C. en segundos; por encima ya es ms.
const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

/**
 * Convierte cualquier forma conocida (epoch number, epoch numerico en string, ISO, `YYYY-MM-DD`)
 * a milisegundos. `null` si no se puede interpretar — nunca `NaN`.
 */
export function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const ms = value < MAX_EPOCH_SECONDS ? value * 1000 : value;
    return isPlausible(ms) ? ms : null;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // Epoch venido como string ("1778687999271") — Date lo interpretaria como año.
  if (/^\d+$/.test(trimmed)) return toEpochMs(Number(trimmed));

  // `YYYY-MM-DD` se ancla a medianoche UTC para que no dependa del huso del proceso.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const ms = Date.parse(`${trimmed}T00:00:00.000Z`);
    return Number.isNaN(ms) ? null : ms;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return isPlausible(parsed) ? parsed : null;
}

function isPlausible(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_PLAUSIBLE_MS && ms < MAX_PLAUSIBLE_MS;
}

/**
 * Normaliza una fecha de curso (`init_course` / `end_course`) al `YYYY-MM-DD` que espera
 * `getCourseWeek`. Devuelve `''` si el dato es inservible — el mismo valor que el Semaforo
 * pone cuando el campo viene vacio (`useSenceData.ts:146`), asi que la clasificacion se
 * comporta igual que en el original.
 */
export function normalizeCourseDate(value: unknown): string {
  const ms = toEpochMs(value);
  if (ms === null) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Normaliza un timestamp (`updated_at`, `created_at`) a ISO 8601. `null` si es inservible.
 */
export function normalizeTimestamp(value: unknown): string | null {
  const ms = toEpochMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** Días de calendario UTC, igual que las fechas del Semáforo. Ausente no significa hoy. */
export function courseDaysRemaining(endCourse: string, now: Date = new Date()): number | undefined {
  const normalized = normalizeCourseDate(endCourse);
  if (!normalized) return undefined;
  const end = Date.parse(`${normalized}T00:00:00.000Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((end - today) / 86_400_000);
}
