/**
 * mock-call-trigger — decide si una edicion del Tablero Mock debe originar una llamada REAL.
 *
 * Es la unica pieza del Mock que puede llamar. Tres cerrojos, en este orden, porque cada uno
 * ataja un modo de repeticion distinto:
 *
 *  1. **Toggle de llamadas automaticas** — apagado por defecto. Sin esto, encender el server ya
 *     seria suficiente para que sonara un telefono.
 *  2. **Transicion de estado** — solo se llama en el flanco no→si. Guardar la misma OC diez
 *     veces seguidas, o que el micrositio recargue el tablero, no dispara nada: la OC ya estaba
 *     en condicion de llamar y no hubo flanco.
 *  3. **Cooldown por OC** — evita el "flapping": editar de critico a normal y de vuelta en
 *     bucle. Es POR OC y no por contacto a proposito: todas las OCs del Mock comparten el mismo
 *     telefono, asi que un cooldown por contacto congelaria el tablero entero tras la primera
 *     llamada.
 *
 * Y por debajo, la idempotencia de `originateManualCall`: la key incluye la secuencia de
 * disparo de la OC, asi que dos requests concurrentes del mismo flanco originan UNA llamada.
 *
 * La llamada en si NO se reimplementa: se delega en `originateManualCall`, el mismo camino del
 * Disparador, que revalida el Semaforo, los guardrails, la whitelist de pruebas, la cuota y
 * hace la escritura condicional READY→DIALING.
 */

import {
  evaluateMockOrder,
  getCallRules,
  getMockOrder,
  getMockRunId,
  getTriggerState,
  isAutoCallEnabled,
  recordTriggerEvaluation,
  recordTriggerFired,
} from './mock-tablero-store.js';
import { originateManualCall, type ManualCallDeps, type ManualCallResult } from './manual-call.js';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { MockTableroApiClient } from './tablero-api-client.mock.js';

export type MockTriggerMotivo =
  | 'llamada_originada'
  | 'llamada_no_originada'
  | 'auto_call_desactivado'
  | 'no_cumple_regla'
  | 'sin_transicion'
  | 'en_cooldown'
  | 'oc_no_encontrada';

export interface MockTriggerOutcome {
  disparo: boolean;
  motivo: MockTriggerMotivo;
  detalle?: string;
  /** Resultado del flujo real de llamada, cuando efectivamente se origino. */
  llamada?: ManualCallResult;
  /** Segundos que faltan para que termine el cooldown, si ese fue el motivo. */
  cooldownRestanteSegundos?: number;
}

export interface MockTriggerDeps extends ManualCallDeps {
  now?: Date;
}

export async function maybeTriggerMockCall(
  clientId: string,
  orderNumber: string,
  deps: MockTriggerDeps = {},
): Promise<MockTriggerOutcome> {
  const order = getMockOrder(clientId, orderNumber);
  if (!order) return { disparo: false, motivo: 'oc_no_encontrada' };

  const evaluacion = evaluateMockOrder(order, getCallRules());
  const dispara = evaluacion.regla.dispara;
  const trigger = getTriggerState(clientId, orderNumber);
  const motivo = evaluacion.variablesAgente.motivo!;
  // El interruptor es POR SECCION: una OC en riesgo de DJ mira el de B, no el de A. La seccion
  // la decide `evaluateMockOrder`, que es la misma que viaja despues a `originateManualCall`.
  const seccion = evaluacion.seccion;
  const disparabaAntes =
    trigger.disparabaAntes && (!trigger.motivoAnterior || trigger.motivoAnterior === motivo);

  // El latch se actualiza SIEMPRE, incluso si no se llama: si la OC deja de cumplir la regla,
  // vuelve a quedar armada para el proximo flanco.
  recordTriggerEvaluation(clientId, orderNumber, dispara, motivo);

  if (!isAutoCallEnabled(seccion)) {
    return {
      disparo: false,
      motivo: 'auto_call_desactivado',
      // Nombrar la seccion importa: con dos interruptores, "estan apagadas" a secas hacia
      // pensar que el problema era el otro, el que si estaba encendido.
      detalle: `Las llamadas automaticas de la seccion ${seccion} estan apagadas.`,
    };
  }
  if (!dispara) {
    return {
      disparo: false,
      motivo: 'no_cumple_regla',
      detalle: `La OC no cumple la regla de llamada (${evaluacion.regla.motivo}).`,
    };
  }
  if (disparabaAntes) {
    return {
      disparo: false,
      motivo: 'sin_transicion',
      detalle: 'La OC ya estaba en condicion de llamar: no hubo transicion, no se vuelve a llamar.',
    };
  }

  const now = deps.now ?? new Date();
  if (trigger.ultimoDisparoAt) {
    const transcurrido = (now.getTime() - new Date(trigger.ultimoDisparoAt).getTime()) / 1000;
    if (transcurrido < env.mockCallCooldownSeconds) {
      return {
        disparo: false,
        motivo: 'en_cooldown',
        detalle: `Ultima llamada de esta OC hace ${Math.round(transcurrido)}s.`,
        cooldownRestanteSegundos: Math.ceil(env.mockCallCooldownSeconds - transcurrido),
      };
    }
  }

  // El runId distingue corridas del store: sin el, reiniciar el server hacia colisionar la key
  // con la de la corrida anterior y el disparo respondia `already_processed` sin llamar.
  const idempotencyKey = `mock:${getMockRunId()}:${clientId}:${orderNumber}:${trigger.secuencia + 1}`;
  logger.info('mock_trigger_disparando', {
    clientId,
    orderNumber,
    pctConexion: evaluacion.pctConexion,
    semana: evaluacion.semana,
    motivo,
    seccion,
    nivel: evaluacion.dj.enSeccion ? evaluacion.dj.nivel : evaluacion.nivel,
    umbral: evaluacion.regla.umbral,
    idempotencyKey,
  });

  const llamada = await originateManualCall(
    {
      clientId,
      orderNumber,
      // El telefono es el que la OC tiene asignado, no una constante global: el editor deja
      // elegir por OC entre los numeros de la etapa de pruebas.
      phone: evaluacion.order.phone,
      idempotencyKey,
      requestedBy: 'tablero-mock',
      seccion,
    },
    { ...deps, tableroClient: new MockTableroApiClient() },
  );

  recordTriggerFired(clientId, orderNumber, llamada.status, now.toISOString());
  logger.info('mock_trigger_resultado', { clientId, orderNumber, status: llamada.status });

  const originada = llamada.status === 'dialing';
  return {
    disparo: originada,
    motivo: originada ? 'llamada_originada' : 'llamada_no_originada',
    detalle: llamada.detalle,
    llamada,
  };
}
