/**
 * El estado final de Twilio como fuente de verdad sobre si la llamada llego a establecerse.
 *
 * Por que importa: el `data.status` de una conversacion de ElevenLabs nunca dice `no-answer` ni
 * `busy` (UV-053), asi que una llamada que nadie atendio llegaba al clasificador como una
 * conversacion vacia y terminaba en `contacted` -> CERRADO, indistinguible de una llamada que
 * si se hablo. Estos tests fijan que el dato de Twilio manda sobre esa heuristica, y solo sobre
 * ella: si Twilio dice que la atendieron, decide la conversacion como siempre.
 *
 * Nada de esto sale a la red: se construyen snapshots a mano.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyCallOutcome,
  classifyTwilioCall,
} from '../../src/services/call-outcome-classifier.js';
import { esEstadoTwilioFinal, toSnapshot } from '../../src/services/twilio-calls-client.js';
import type { TwilioCallSnapshot } from '../../src/services/twilio-calls-client.js';
import type { ElevenLabsPostCallPayload } from '../../src/domain/call.js';

function snapshot(overrides: Partial<TwilioCallSnapshot> = {}): TwilioCallSnapshot {
  return {
    sid: 'CA00000000000000000000000000000001',
    status: 'completed',
    durationSeconds: 42,
    answeredBy: null,
    startedAt: '2026-09-14T12:00:00.000Z',
    endedAt: '2026-09-14T12:00:42.000Z',
    price: 0.014,
    to: '+56956194817',
    from: '+56000000000',
    direction: 'outbound-api',
    ...overrides,
  };
}

/** Una conversacion "vacia" tal como la deja ElevenLabs cuando nadie atendio: done y sin nada. */
function conversacionVacia(): ElevenLabsPostCallPayload {
  return {
    type: 'post_call_transcription',
    event_timestamp: 1_757_000_100,
    data: {
      conversation_id: 'conv_x',
      agent_id: 'agent_x',
      status: 'done',
      transcript: [],
      metadata: { call_duration_secs: 0, start_time_unix_secs: 1_757_000_000 },
      analysis: {},
    },
  };
}

describe('classifyTwilioCall', () => {
  it('traduce los estados en los que la llamada no se establecio', () => {
    expect(classifyTwilioCall(snapshot({ status: 'no-answer' }))).toBe('no_answer');
    expect(classifyTwilioCall(snapshot({ status: 'busy' }))).toBe('busy');
    expect(classifyTwilioCall(snapshot({ status: 'failed' }))).toBe('call_failed');
    expect(classifyTwilioCall(snapshot({ status: 'canceled' }))).toBe('call_failed');
  });

  it('no decide nada cuando la llamada fue atendida: eso lo decide la conversacion', () => {
    expect(classifyTwilioCall(snapshot({ status: 'completed' }))).toBeNull();
  });

  it('no decide nada mientras la llamada sigue en curso', () => {
    expect(classifyTwilioCall(snapshot({ status: 'ringing' }))).toBeNull();
    expect(classifyTwilioCall(snapshot({ status: 'in-progress' }))).toBeNull();
  });

  it('marca buzon de voz solo si Twilio detecto una maquina (AMD)', () => {
    expect(classifyTwilioCall(snapshot({ answeredBy: 'machine_end_beep' }))).toBe('voicemail');
    expect(classifyTwilioCall(snapshot({ answeredBy: 'human' }))).toBeNull();
  });
});

describe('classifyCallOutcome con el estado de Twilio', () => {
  it('sin Twilio, una conversacion vacia se sigue clasificando como antes', () => {
    // Este es el agujero que motiva todo: `done` + nada -> se cerraba como contactado.
    expect(classifyCallOutcome(conversacionVacia()).outcome).toBe('follow_up_required');
  });

  it('Twilio manda: la misma conversacion vacia con no-answer es una no contestada', () => {
    const clasificacion = classifyCallOutcome(
      conversacionVacia(),
      snapshot({ status: 'no-answer', durationSeconds: 0 }),
    );
    expect(clasificacion.outcome).toBe('no_answer');
  });

  it('si Twilio dice que la atendieron, decide la conversacion (no la sobreescribe)', () => {
    const payload = conversacionVacia();
    payload.data.analysis = {
      data_collection_results: { requiere_humano: { value: true } },
    };
    const clasificacion = classifyCallOutcome(payload, snapshot({ status: 'completed' }));
    expect(clasificacion.outcome).toBe('human_escalation');
    expect(clasificacion.requiresHumanEscalation).toBe(true);
  });
});

describe('toSnapshot', () => {
  it('normaliza los tipos que Twilio devuelve como texto', () => {
    const s = toSnapshot(
      {
        sid: 'CA123',
        status: 'completed',
        duration: '37',
        // Twilio informa el precio como cargo negativo; se guarda la magnitud.
        price: '-0.0140',
        start_time: 'Mon, 14 Sep 2026 12:00:00 +0000',
        end_time: null,
        answered_by: null,
      },
      'CA123',
    );
    expect(s.durationSeconds).toBe(37);
    expect(s.price).toBe(0.014);
    expect(s.startedAt).toBe('2026-09-14T12:00:00.000Z');
    expect(s.endedAt).toBeNull();
  });

  it('usa el SID pedido si la respuesta viniera sin el', () => {
    expect(toSnapshot({ status: 'busy' }, 'CA999').sid).toBe('CA999');
  });
});

describe('esEstadoTwilioFinal', () => {
  it('solo son finales los estados en los que Twilio ya no va a cambiar de opinion', () => {
    for (const final of ['completed', 'busy', 'failed', 'no-answer', 'canceled']) {
      expect(esEstadoTwilioFinal(final)).toBe(true);
    }
    for (const enCurso of ['queued', 'ringing', 'in-progress', undefined]) {
      expect(esEstadoTwilioFinal(enCurso)).toBe(false);
    }
  });
});
