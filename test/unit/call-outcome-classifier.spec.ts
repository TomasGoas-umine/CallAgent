import { describe, expect, it } from 'vitest';
import { classifyCallOutcome } from '../../src/services/call-outcome-classifier.js';
import type { ElevenLabsPostCallPayload } from '../../src/domain/call.js';

function payload(overrides: Partial<ElevenLabsPostCallPayload['data']> = {}): ElevenLabsPostCallPayload {
  return {
    type: 'post_call_transcription',
    event_timestamp: Date.now(),
    data: {
      conversation_id: 'conv-1',
      agent_id: 'agent-1',
      status: 'done',
      call_successful: 'success',
      transcript: [],
      metadata: { call_duration_secs: 60 },
      analysis: { data_collection_results: {}, evaluation_criteria_results: {} },
      ...overrides,
    },
  };
}

describe('classifyCallOutcome', () => {
  it('clasifica no_answer / busy / voicemail segun el status del proveedor', () => {
    expect(classifyCallOutcome(payload({ status: 'no-answer' })).outcome).toBe('no_answer');
    expect(classifyCallOutcome(payload({ status: 'busy' })).outcome).toBe('busy');
    expect(classifyCallOutcome(payload({ status: 'voicemail' })).outcome).toBe('voicemail');
  });

  it('requiere_humano=true siempre gana y marca requiresHumanEscalation', () => {
    const result = classifyCallOutcome(
      payload({
        analysis: {
          data_collection_results: { requiere_humano: { value: true } },
        },
      }),
    );
    expect(result.outcome).toBe('human_escalation');
    expect(result.requiresHumanEscalation).toBe(true);
  });

  it('motivo_no_conexion de rechazo explicito clasifica do_not_call', () => {
    const result = classifyCallOutcome(
      payload({
        analysis: {
          data_collection_results: { motivo_no_conexion: { value: 'no_contactar' } },
        },
      }),
    );
    expect(result.outcome).toBe('do_not_call');
  });

  it('tiene_bloqueo_tecnico=true clasifica technical_problem', () => {
    const result = classifyCallOutcome(
      payload({
        analysis: {
          data_collection_results: { tiene_bloqueo_tecnico: { value: true } },
        },
      }),
    );
    expect(result.outcome).toBe('technical_problem');
  });

  it('compromiso_fecha presente clasifica resolved', () => {
    const result = classifyCallOutcome(
      payload({
        analysis: {
          data_collection_results: { compromiso_fecha: { value: '2026-08-20' } },
        },
      }),
    );
    expect(result.outcome).toBe('resolved');
  });

  it('necesidad_capacitacion_futura presente clasifica training_need_detected', () => {
    const result = classifyCallOutcome(
      payload({
        analysis: {
          data_collection_results: { necesidad_capacitacion_futura: { value: 'Excel avanzado' } },
        },
      }),
    );
    expect(result.outcome).toBe('training_need_detected');
  });

  it('evaluation_criteria_results todos success clasifica resolved', () => {
    const result = classifyCallOutcome(
      payload({
        analysis: {
          data_collection_results: {},
          evaluation_criteria_results: { objetivo: { result: 'success' } },
        },
      }),
    );
    expect(result.outcome).toBe('resolved');
  });

  it('contestada sin nada accionable clasifica follow_up_required', () => {
    const result = classifyCallOutcome(
      payload({ analysis: { data_collection_results: {}, evaluation_criteria_results: {} } }),
    );
    expect(result.outcome).toBe('follow_up_required');
  });

  it('extrae motivo_no_conexion "no_informado" por defecto si no viene en el payload', () => {
    const result = classifyCallOutcome(payload({ analysis: {} }));
    expect(result.dataCollection.motivo_no_conexion).toBe('no_informado');
  });
});
