/**
 * call-rules — cuando CallAgent debe LLAMAR.
 *
 * Distincion central, y la razon de que este modulo exista separado de `urgency-classifier.ts`:
 *
 *   - `urgency-classifier.ts` decide el NIVEL del Semaforo (NORMAL/ALERTA/CRITICO). Es un espejo
 *     1:1 del repo `micrositio-operaciones-tablero-sence` y **no se toca ni se configura**: si
 *     se pudiera editar, el tablero de CallAgent dejaria de mostrar lo mismo que el Semaforo
 *     real y perderia todo su valor como referencia.
 *   - Este modulo decide si esa situacion AMERITA UNA LLAMADA. Eso si es configurable, porque
 *     es una decision de operacion de CallAgent, no un hecho del Semaforo.
 *
 * Por defecto las dos coinciden: la regla de llamada arranca con los mismos umbrales
 * `criticoBelow` de `WEEK_THRESHOLDS`, asi que "dispara llamada" == "el Semaforo lo marca
 * CRITICO". Bajarlos hace al agente mas conservador; subirlos, mas agresivo. El nivel mostrado
 * en el tablero no cambia nunca.
 */

import { DJ_THRESHOLDS, WEEK_THRESHOLDS } from './urgency-classifier.js';
import type { CourseWeek, UrgencyLevel } from '../domain/candidate.js';

export interface DjCallRules {
  /** Llamar cuando los días calculados desde el cierre sean estrictamente mayores. null desactiva. */
  llamarSiDiasMayorA: number | null;
  nivelesQueLlaman: UrgencyLevel[];
}

export interface CallRules {
  dj: DjCallRules;
  /**
   * Por semana de curso: llamar si `pctConexion < umbral`. `null` = esa semana nunca llama.
   * Los defaults son los `criticoBelow` del Semaforo (S1 no tiene banda CRITICO).
   */
  llamarSiPctMenorA: Record<CourseWeek, number | null>;
  /**
   * Niveles del Semaforo que habilitan la llamada. Por defecto solo CRITICO — el unico caso de
   * uso del MVP. Sirve para poder probar con ALERTA sin tocar los umbrales.
   */
  nivelesQueLlaman: UrgencyLevel[];
}

/** Los umbrales del Semaforo, tal cual. Es el estado al que vuelve "Restaurar". */
export function defaultCallRules(): CallRules {
  return {
    llamarSiPctMenorA: {
      1: WEEK_THRESHOLDS[1].criticoBelow >= 0 ? WEEK_THRESHOLDS[1].criticoBelow : null,
      2: WEEK_THRESHOLDS[2].criticoBelow,
      3: WEEK_THRESHOLDS[3].criticoBelow,
      4: WEEK_THRESHOLDS[4].criticoBelow,
    },
    nivelesQueLlaman: ['CRITICO'],
    dj: { llamarSiDiasMayorA: DJ_THRESHOLDS.criticoDias, nivelesQueLlaman: ['CRITICO'] },
  };
}

export interface CallRuleDecision {
  dispara: boolean;
  motivo:
    | 'umbral_alcanzado'
    | 'nivel_no_habilitado'
    | 'semana_sin_umbral'
    | 'sobre_el_umbral'
    | 'umbral_desactivado'
    | 'dias_insuficientes';
  umbral: number | null;
}

/**
 * ¿Esta OC amerita una llamada con las reglas activas? No mira guardrails ni telefono: solo la
 * condicion de negocio. Los guardrails los aplica `originateManualCall`/`dispatchFollowup`.
 */
export function evaluarReglaDeLlamada(
  rules: CallRules,
  semana: CourseWeek,
  pctConexion: number,
  nivel: UrgencyLevel,
): CallRuleDecision {
  const umbral = rules.llamarSiPctMenorA[semana];

  if (!rules.nivelesQueLlaman.includes(nivel)) {
    return { dispara: false, motivo: 'nivel_no_habilitado', umbral };
  }
  if (umbral === null) {
    return { dispara: false, motivo: 'semana_sin_umbral', umbral };
  }
  if (pctConexion < umbral) {
    return { dispara: true, motivo: 'umbral_alcanzado', umbral };
  }
  return { dispara: false, motivo: 'sobre_el_umbral', umbral };
}

/** Valida un patch de reglas venido del micrositio. El front no valida nada: se valida aca. */
export function validarCallRules(
  input: unknown,
  current: CallRules = defaultCallRules(),
): { ok: true; rules: CallRules } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return { ok: false, error: 'cuerpo invalido' };
  const raw = input as Partial<CallRules>;
  const base = structuredClone(current);
  const umbrales = { ...base.llamarSiPctMenorA };

  if (raw.llamarSiPctMenorA !== undefined) {
    if (typeof raw.llamarSiPctMenorA !== 'object' || raw.llamarSiPctMenorA === null) {
      return { ok: false, error: 'llamarSiPctMenorA debe ser un objeto por semana' };
    }
    for (const semana of [1, 2, 3, 4] as CourseWeek[]) {
      const v = raw.llamarSiPctMenorA[semana];
      if (v === undefined) continue;
      if (v === null) {
        umbrales[semana] = null;
        continue;
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
        return { ok: false, error: `umbral de semana ${semana} debe ser null o un numero 0-100` };
      }
      umbrales[semana] = v;
    }
  }

  let niveles = base.nivelesQueLlaman;
  if (raw.nivelesQueLlaman !== undefined) {
    if (!Array.isArray(raw.nivelesQueLlaman) || raw.nivelesQueLlaman.length === 0) {
      return { ok: false, error: 'nivelesQueLlaman debe ser una lista no vacia' };
    }
    const validos: UrgencyLevel[] = ['NORMAL', 'ALERTA', 'CRITICO'];
    for (const n of raw.nivelesQueLlaman) {
      if (!validos.includes(n)) return { ok: false, error: `nivel invalido: ${String(n)}` };
    }
    niveles = [...new Set(raw.nivelesQueLlaman)];
  }

  const dj = { ...base.dj };
  if (raw.dj !== undefined) {
    if (!raw.dj || typeof raw.dj !== 'object' || Array.isArray(raw.dj))
      return { ok: false, error: 'dj debe ser un objeto' };
    const dias = raw.dj.llamarSiDiasMayorA;
    if (dias !== undefined) {
      if (dias !== null && (!Number.isSafeInteger(dias) || dias < 0))
        return { ok: false, error: 'El umbral DJ debe ser null o un entero no negativo' };
      dj.llamarSiDiasMayorA = dias;
    }
    if (raw.dj.nivelesQueLlaman !== undefined) {
      const lista = raw.dj.nivelesQueLlaman;
      if (
        !Array.isArray(lista) ||
        lista.length === 0 ||
        lista.some((n) => !['NORMAL', 'ALERTA', 'CRITICO'].includes(n))
      )
        return {
          ok: false,
          error: 'Los niveles DJ deben ser una lista no vacía de niveles válidos',
        };
      dj.nivelesQueLlaman = [...new Set(lista)];
    }
  }
  return { ok: true, rules: { llamarSiPctMenorA: umbrales, nivelesQueLlaman: niveles, dj } };
}

/** B conserva su gate; solo se configuran la decisión de llamar y los niveles admitidos. */
export function evaluarReglaDj(
  enSeccion: boolean,
  nivel: UrgencyLevel | null,
  diasDesdeCierre: number,
  rules: DjCallRules = defaultCallRules().dj,
): CallRuleDecision {
  const umbral = rules.llamarSiDiasMayorA;
  if (!enSeccion || nivel === null || !rules.nivelesQueLlaman.includes(nivel))
    return { dispara: false, motivo: 'nivel_no_habilitado', umbral };
  if (umbral === null) return { dispara: false, motivo: 'umbral_desactivado', umbral };
  if (!Number.isFinite(diasDesdeCierre) || diasDesdeCierre <= umbral)
    return { dispara: false, motivo: 'dias_insuficientes', umbral };
  return { dispara: true, motivo: 'umbral_alcanzado', umbral };
}
