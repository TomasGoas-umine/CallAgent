/**
 * dialing-reconciler — los seguimientos que quedaron en DIALING, resueltos contra Twilio.
 *
 * El escenario real: se dispara la llamada, nadie atiende, ElevenLabs no deja ninguna
 * conversacion util y el FOLLOWUP se queda en DIALING para siempre — o peor, si aparece una
 * conversacion vacia, se cierra como "contactado". Lo unico que sabe que el telefono sono y nadie
 * contesto es Twilio.
 *
 * El cliente de Twilio es un doble en memoria: estos tests no salen a la red ni originan llamadas.
 * DynamoDB si es real (dynalite) porque lo que se verifica incluye escrituras condicionales.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileDialingFollowups } from '../../src/services/dialing-reconciler.js';
import { FollowupRepository } from '../../src/repositories/followup-repository.js';
import { ContactRepository } from '../../src/repositories/contact-repository.js';
import {
  startDynamoServerHarness,
  createTestTable,
  type DynamoServerHarness,
} from './test-dynamo-harness.js';
import type {
  GetTwilioCallResult,
  TwilioCallsClient,
} from '../../src/services/twilio-calls-client.js';
import type { Followup } from '../../src/domain/followup.js';

let serverHarness: DynamoServerHarness;

beforeAll(async () => {
  serverHarness = await startDynamoServerHarness();
});
afterAll(async () => {
  await serverHarness.stop();
});

async function freshRepos() {
  const tableName = `reconcile-test-${randomUUID()}`;
  await createTestTable(serverHarness.client, tableName);
  return {
    followupRepository: new FollowupRepository(tableName, serverHarness.doc),
    contactRepository: new ContactRepository(tableName, serverHarness.doc),
  };
}

const HACE_UNA_HORA = new Date(Date.now() - 60 * 60 * 1000).toISOString();

/** El primer item del reporte, fallando con un mensaje util si el reporte vino vacio. */
function primero<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('se esperaba al menos un item en el reporte');
  return item;
}

function makeFollowup(overrides: Partial<Followup> = {}): Followup {
  return {
    followupId: randomUUID(),
    motivo: 'riesgo_conexion_critico',
    prioridad: 'ALTA',
    estado: 'DIALING',
    destinatarioId: 'client_x',
    destinatarioPhone: '+56900000001',
    oc: '100',
    curso: 'Curso X',
    intentos: 1,
    nextAttemptAt: null,
    idempotencyKey: `key-${randomUUID()}`,
    createdAt: HACE_UNA_HORA,
    updatedAt: HACE_UNA_HORA,
    ultimoCallSid: 'CA00000000000000000000000000000001',
    ultimaConversationId: null,
    ultimoIntentoAt: HACE_UNA_HORA,
    contexto: {
      clientId: 'client_x',
      clientName: 'Cliente X',
      courseName: 'Curso X',
      orderNumber: '100',
      initCourse: '2026-06-01',
      endCourse: '2026-09-01',
      nivelDetectado: 'CRITICO',
      seccion: 'A_RIESGO_CONEXION',
    },
    ...overrides,
  };
}

/** Doble del cliente de Twilio. Cuenta las consultas para poder afirmar que NO se consulto. */
function fakeTwilio(respuesta: GetTwilioCallResult): TwilioCallsClient & { consultas: string[] } {
  const consultas: string[] = [];
  return {
    consultas,
    async getCall(callSid: string) {
      consultas.push(callSid);
      return respuesta;
    },
  };
}

function llamada(status: string, durationSeconds = 0): GetTwilioCallResult {
  return {
    estado: 'ok',
    call: {
      sid: 'CA00000000000000000000000000000001',
      status,
      durationSeconds,
      answeredBy: null,
      startedAt: HACE_UNA_HORA,
      endedAt: HACE_UNA_HORA,
      price: 0.014,
      to: '+56900000001',
      from: '+56000000000',
      direction: 'outbound-api',
    },
  };
}

describe('reconcileDialingFollowups', () => {
  it('cierra el seguimiento cuando Twilio dice que nadie atendio, y cuenta el intento', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);
    const twilioClient = fakeTwilio(llamada('no-answer'));

    const item = primero(await reconcileDialingFollowups({ twilioClient, ...repos }));

    expect(item.estado).toBe('resuelta_por_twilio');
    expect(item.outcome).toBe('no_answer');

    // El FOLLOWUP deja de estar colgado: vuelve a READY con un intento mas. No se cierra como
    // contactado, que es lo que pasaba antes.
    const despues = await repos.followupRepository.getById(followup.followupId);
    expect(despues?.estado).toBe('READY');
    expect(despues?.intentos).toBe(2);

    // Y queda el registro de la llamada, con la evidencia de Twilio para poder auditarla.
    const calls = await repos.followupRepository.listCalls(followup.followupId);
    expect(calls).toHaveLength(1);
    expect(primero(calls).outcome).toBe('no_answer');
    expect(primero(calls).fuente).toBe('twilio');
    expect(primero(calls).callSid).toBe('CA00000000000000000000000000000001');
    expect(primero(calls).twilio?.status).toBe('no-answer');
  });

  it('un `failed` de Twilio no se cierra como contactado', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);

    const item = primero(
      await reconcileDialingFollowups({
        twilioClient: fakeTwilio(llamada('failed')),
        ...repos,
      }),
    );

    expect(item.outcome).toBe('call_failed');
    expect((await repos.followupRepository.getById(followup.followupId))?.estado).toBe('READY');
  });

  it('es idempotente: re-correrlo no duplica el registro ni vuelve a mover el estado', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);
    const twilioClient = fakeTwilio(llamada('busy'));

    await reconcileDialingFollowups({ twilioClient, ...repos });
    // El followup ya no esta en DIALING, asi que la segunda corrida ni lo mira. Se lo devuelve a
    // DIALING a mano para forzar el caso duro: reconciliar dos veces la MISMA llamada.
    await repos.followupRepository.setEstado(followup.followupId, 'DIALING');
    const segunda = await reconcileDialingFollowups({ twilioClient, ...repos });

    expect(primero(segunda).estado).toBe('ya_registrada');
    expect(await repos.followupRepository.listCalls(followup.followupId)).toHaveLength(1);
  });

  it('si Twilio dice que la atendieron, espera la conversacion en vez de cerrar', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);

    const item = primero(
      await reconcileDialingFollowups({
        twilioClient: fakeTwilio(llamada('completed', 87)),
        ...repos,
      }),
    );

    // Cerrarlo aca seria tirar la transcripcion que ElevenLabs todavia esta procesando.
    expect(item.estado).toBe('esperando_conversacion');
    expect((await repos.followupRepository.getById(followup.followupId))?.estado).toBe('DIALING');
    expect(await repos.followupRepository.listCalls(followup.followupId)).toHaveLength(0);
  });

  it('no toca una llamada que todavia esta sonando', async () => {
    const repos = await freshRepos();
    await repos.followupRepository.create(makeFollowup());

    const item = primero(
      await reconcileDialingFollowups({
        twilioClient: fakeTwilio(llamada('ringing')),
        ...repos,
      }),
    );

    expect(item.estado).toBe('en_curso');
  });

  it('respeta el periodo de gracia: no le pregunta a Twilio por una llamada recien disparada', async () => {
    const repos = await freshRepos();
    const ahora = new Date().toISOString();
    await repos.followupRepository.create(
      makeFollowup({ ultimoIntentoAt: ahora, updatedAt: ahora }),
    );
    const twilioClient = fakeTwilio(llamada('no-answer'));

    const item = primero(await reconcileDialingFollowups({ twilioClient, ...repos }));

    expect(item.estado).toBe('en_curso');
    expect(twilioClient.consultas).toHaveLength(0);
  });

  it('sin call_sid guardado no adivina nada: lo reporta y deja el seguimiento como estaba', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup({ ultimoCallSid: null });
    await repos.followupRepository.create(followup);
    const twilioClient = fakeTwilio(llamada('no-answer'));

    const item = primero(await reconcileDialingFollowups({ twilioClient, ...repos }));

    expect(item.estado).toBe('sin_datos');
    expect(twilioClient.consultas).toHaveLength(0);
    expect((await repos.followupRepository.getById(followup.followupId))?.estado).toBe('DIALING');
  });

  it('si el SID no existe en esta cuenta de Twilio, lo dice en vez de inventar un resultado', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);

    const item = primero(
      await reconcileDialingFollowups({
        twilioClient: fakeTwilio({ estado: 'no_encontrada' }),
        ...repos,
      }),
    );

    expect(item.estado).toBe('sin_datos');
    expect(item.motivo).toContain('MISMA cuenta');
    expect((await repos.followupRepository.getById(followup.followupId))?.estado).toBe('DIALING');
  });

  it('un error de Twilio no rompe la corrida ni toca el seguimiento', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);

    const item = primero(
      await reconcileDialingFollowups({
        twilioClient: fakeTwilio({ estado: 'error', motivo: 'HTTP 500' }),
        ...repos,
      }),
    );

    expect(item.estado).toBe('error');
    expect((await repos.followupRepository.getById(followup.followupId))?.estado).toBe('DIALING');
  });

  it('solo mira los FOLLOWUP en DIALING', async () => {
    const repos = await freshRepos();
    await repos.followupRepository.create(makeFollowup({ estado: 'CERRADO' }));
    await repos.followupRepository.create(makeFollowup({ estado: 'READY' }));
    await repos.followupRepository.create(makeFollowup());

    const items = await reconcileDialingFollowups({
      twilioClient: fakeTwilio(llamada('no-answer')),
      ...repos,
    });

    expect(items).toHaveLength(1);
  });
});
