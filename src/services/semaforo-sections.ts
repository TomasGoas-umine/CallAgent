/**
 * semaforo-sections — los FILTROS DE ENTRADA de las secciones del Semaforo, portados 1:1 desde
 * `StatusCursosPage.tsx` (repo `micrositio-operaciones-tablero-sence`).
 *
 * Distincion que importa y que costo un bug: `urgency-classifier.ts` responde "que tan mal esta
 * este curso" (NORMAL/ALERTA/CRITICO), pero NO responde "este curso pertenece a la seccion A".
 * Son dos preguntas distintas y el Semaforo las evalua por separado. Sin el gate de seccion, un
 * curso YA TERMINADO con conexion baja se clasifica CRITICO por semana 4 y se convierte en
 * candidato a llamada — cuando en el Semaforo real ese curso vive en la seccion B (Riesgo DJ),
 * donde lo que falta es la Declaracion Jurada, no que el alumno se conecte. Llamar ahi es
 * llamar por algo que ya no tiene arreglo.
 *
 * Seccion A — Riesgo Conexion (`StatusCursosPage.tsx:528-536`), la unica que puede llamar:
 *   - la OC esta en ejecucion (`order_status` contiene OPERACI u EJECUCI, o viene vacio)
 *   - el curso NO termino (`end_course` en el futuro, o sin fecha)
 *   - la conexion no esta completa (`pctConexion < 100`)
 * y despues, ya clasificado, el Semaforo se queda solo con ALERTA y CRITICO (descarta NORMAL).
 *
 * Seccion B - Riesgo DJ (`StatusCursosPage.tsx:582-596`):
 *   - el curso YA termino (`end_course` en el pasado)
 *   - hay al menos un alumno conectado (`conectados > 0`)
 *   - la DJ no esta completa (`djCount / conectados < 1`)
 *   - y lleva mas de 3 dias cerrado (`diasDesdeCierre > 3`, `L619`)
 *
 * Seccion C - Rectificacion (`StatusCursosPage.tsx:626-660`):
 *   - el `order_status` contiene `ESPERA` o `RECTIFIC`
 *   - y lleva mas de 3 dias en ese estado (`diasPendiente > 3`, `L657`)
 *
 * **B y C se MUESTRAN, no llaman.** Estan portadas para el Tablero Mock, que las dibuja como dos
 * tableros mas con su propio semaforo, editables igual que el de conexion. Ninguna de las dos
 * entra en `call-rules.ts` ni en `mock-call-trigger.ts`: llamar por telefono no mueve una DJ ni
 * una OC Final — esas se resuelven con el OTIC, no con el alumno. Ver ADR-011 y
 * docs/SEMAFORO_INTEGRACION.md §3.
 */

import type { OrderGroup } from './order-status-promoter.js';

const MS_POR_DIA = 86_400_000;

/**
 * B y C comparten el mismo corte de visibilidad —mas de 3 dias— pero por razones distintas y en
 * lineas distintas del original (`L619` y `L657`): en B son 3 dias de gracia para que llegue la
 * DJ, en C son 3 dias de gracia para que conteste el OTIC. Coinciden hoy; no es una regla unica.
 */
const DIAS_MINIMOS_VISIBLE = 3;

export type MotivoFueraDeSeccionA = 'no_en_ejecucion' | 'curso_terminado' | 'conexion_completa';

export type GateSeccionA = { incluido: true } | { incluido: false; motivo: MotivoFueraDeSeccionA };

/**
 * `StatusCursosPage.tsx:532` — el estado vacio cuenta como "en ejecucion" a proposito: la
 * promocion por fechas ya corrio antes, asi que un estado que sigue vacio es uno que el
 * Semaforo no supo clasificar y prefiere mostrar antes que esconder.
 */
function estaEnEjecucion(orderStatus: string): boolean {
  const estado = (orderStatus || '').toUpperCase();
  return estado.includes('OPERACI') || estado.includes('EJECUCI') || estado === '';
}

/** `StatusCursosPage.tsx:533-534` — sin fecha de termino se considera NO terminado. */
function noTermino(endCourse: string, nowMs: number): boolean {
  const termino = endCourse ? new Date(endCourse).getTime() : 0;
  if (Number.isNaN(termino)) return true;
  return termino === 0 || termino > nowMs;
}

export function gateSeccionA(group: OrderGroup, nowMs: number = Date.now()): GateSeccionA {
  if (!estaEnEjecucion(group.promotedOrderStatus)) {
    return { incluido: false, motivo: 'no_en_ejecucion' };
  }
  if (!noTermino(group.endCourse, nowMs)) {
    return { incluido: false, motivo: 'curso_terminado' };
  }
  // El Semaforo compara `pctConexion < 1` sobre una fraccion 0-1; aca el porcentaje es 0-100.
  if (group.pctConexion >= 100) {
    return { incluido: false, motivo: 'conexion_completa' };
  }
  return { incluido: true };
}

// ---------------------------------------------------------------------------
// Seccion B - Riesgo DJ
// ---------------------------------------------------------------------------

export type MotivoFueraDeSeccionB =
  'curso_no_terminado' | 'sin_conectados' | 'dj_completa' | 'cierre_reciente';

export type GateSeccionB = { incluido: true } | { incluido: false; motivo: MotivoFueraDeSeccionB };

/** Dias de calendario desde el cierre del curso. Negativo si todavia no termino. */
export function diasDesdeElCierre(endCourse: string, nowMs: number = Date.now()): number {
  const termino = endCourse ? new Date(endCourse).getTime() : 0;
  if (!termino || Number.isNaN(termino)) return 0;
  return Math.ceil((nowMs - termino) / MS_POR_DIA);
}

/**
 * `StatusCursosPage.tsx:584-590` + el filtro de visibilidad de `L619`.
 *
 * `conectados > 0` no es un detalle: sin el, el porcentaje de DJ seria 0/0 y toda OC cerrada sin
 * un solo conectado entraria como "DJ incompleta" — cuando en realidad no hay ninguna DJ que
 * pedir. El Semaforo lo excluye explicitamente (`c.sence_connections > 0`).
 */
export function gateSeccionB(group: OrderGroup, nowMs: number = Date.now()): GateSeccionB {
  const termino = group.endCourse ? new Date(group.endCourse).getTime() : 0;
  if (!termino || Number.isNaN(termino) || termino > nowMs) {
    return { incluido: false, motivo: 'curso_no_terminado' };
  }
  if (group.totalConnections <= 0) return { incluido: false, motivo: 'sin_conectados' };
  if (group.djCount >= group.totalConnections) return { incluido: false, motivo: 'dj_completa' };
  if (diasDesdeElCierre(group.endCourse, nowMs) <= DIAS_MINIMOS_VISIBLE) {
    return { incluido: false, motivo: 'cierre_reciente' };
  }
  return { incluido: true };
}

// ---------------------------------------------------------------------------
// Seccion C - Rectificacion
// ---------------------------------------------------------------------------

export type MotivoFueraDeSeccionC = 'estado_no_espera_oc_final' | 'espera_reciente';

export type GateSeccionC = { incluido: true } | { incluido: false; motivo: MotivoFueraDeSeccionC };

/**
 * Dias desde la ultima modificacion de la OC — el proxy de "hace cuanto se pidio la
 * rectificacion" (`StatusCursosPage.tsx:632-645`). No es exacto a proposito: el SENCE Sync
 * tambien toca `updated_at`. El original lo prefiere igual antes que usar `end_course`, que
 * daba "60 dias pendiente" para una rectificacion pedida ayer.
 */
export function diasEsperandoAlOtic(lastUpdatedAt: string, nowMs: number = Date.now()): number {
  const ms = lastUpdatedAt ? new Date(lastUpdatedAt).getTime() : 0;
  if (!ms || Number.isNaN(ms)) return 0;
  return Math.max(0, Math.ceil((nowMs - ms) / MS_POR_DIA));
}

/** `StatusCursosPage.tsx:628-631` (estado) + `L657` (los 3 dias de gracia del OTIC). */
export function gateSeccionC(group: OrderGroup, nowMs: number = Date.now()): GateSeccionC {
  const estado = (group.promotedOrderStatus || '').toUpperCase();
  if (!estado.includes('ESPERA') && !estado.includes('RECTIFIC')) {
    return { incluido: false, motivo: 'estado_no_espera_oc_final' };
  }
  if (diasEsperandoAlOtic(group.lastUpdatedAt, nowMs) <= DIAS_MINIMOS_VISIBLE) {
    return { incluido: false, motivo: 'espera_reciente' };
  }
  return { incluido: true };
}
