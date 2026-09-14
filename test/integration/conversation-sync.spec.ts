/**
 * conversation-sync — el camino PULL: traer el resultado de la llamada desde la API de
 * ElevenLabs en vez de esperar el webhook.
 *
 * El cliente de ElevenLabs es un doble en memoria: estos tests NUNCA salen a la red ni originan
 * llamadas. Lo que se verifica es la atribucion (a que FOLLOWUP pertenece cada conversacion) y
 * que el resultado quede registrado igual que si lo hubiera traido el webhook.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  syncConversations,
  syncConversacionForzada,
} from '../../src/services/conversation-sync.js';
import { FollowupRepository } from '../../src/repositories/followup-repository.js';
import { ContactRepository } from '../../src/repositories/contact-repository.js';
import {
  startDynamoServerHarness,
  createTestTable,
  type DynamoServerHarness,
} from './test-dynamo-harness.js';
import type {
  ConversationDetail,
  ConversationsClient,
  ListConversationsPage,
} from '../../src/services/elevenlabs-conversations-client.js';
import type { Followup } from '../../src/domain/followup.js';
import type {
  GetTwilioCallResult,
  TwilioCallsClient,
} from '../../src/services/twilio-calls-client.js';

let serverHarness: DynamoServerHarness;

beforeAll(async () => {
  serverHarness = await startDynamoServerHarness();
});
afterAll(async () => {
  await serverHarness.stop();
});

async function freshRepos() {
  const tableName = `sync-test-${randomUUID()}`;
  await createTestTable(serverHarness.client, tableName);
  return {
    followupRepository: new FollowupRepository(tableName, serverHarness.doc),
    contactRepository: new ContactRepository(tableName, serverHarness.doc),
  };
}

function makeFollowup(overrides: Partial<Followup> = {}): Followup {
  const now = new Date().toISOString();
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
    createdAt: now,
    updatedAt: now,
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

const INICIO_UNIX = 1_757_000_000;

function makeDetail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    conversation_id: `conv_${randomUUID().slice(0, 8)}`,
    agent_id: 'agent_test',
    status: 'done',
    call_duration_secs: 61,
    start_time_unix_secs: INICIO_UNIX,
    transcript: [
      { role: 'agent', message: 'Hola, le hablo de Umine.', time_in_call_secs: 0 },
      { role: 'user', message: 'Si, tuve un problema con la clave.', time_in_call_secs: 9 },
    ],
    metadata: {
      call_duration_secs: 61,
      start_time_unix_secs: INICIO_UNIX,
      cost: 421,
      termination_reason: 'Call ended by remote party',
      phone_call: { type: 'twilio', call_sid: 'CAreal999', external_number: '+56900000001' },
    },
    analysis: {
      transcript_summary: 'Reporta bloqueo de clave.',
      data_collection_results: {
        tiene_bloqueo_tecnico: { value: true, rationale: 'Dijo que la clave no le funciona.' },
      },
      evaluation_criteria_results: {
        objetivo_resuelto: { result: 'failure', rationale: 'No se obtuvo compromiso.' },
      },
    },
    ...overrides,
  };
}

/** Doble en memoria. Cuenta las lecturas de detalle para poder afirmar que no se piden de mas. */
function fakeClient(detalles: ConversationDetail[]) {
  const pedidos: string[] = [];
  const client: ConversationsClient = {
    async listConversations(): Promise<ListConversationsPage> {
      return {
        conversations: detalles.map((d) => ({
          conversation_id: d.conversation_id,
          status: d.status,
          call_duration_secs: d.call_duration_secs,
          start_time_unix_secs: d.start_time_unix_secs,
        })),
        next_cursor: null,
        has_more: false,
      };
    },
    async getConversation(id: string): Promise<ConversationDetail | null> {
      pedidos.push(id);
      return detalles.find((d) => d.conversation_id === id) ?? null;
    },
  };
  return { client, pedidos };
}

/**
 * Doble de Twilio. Responde lo mismo para cualquier SID y anota que se le pregunto: alcanza para
 * fijar que el estado final de la llamada manda sobre la heuristica de la conversacion.
 */
function fakeTwilio(
  status: string,
  durationSeconds = 0,
): TwilioCallsClient & { consultas: string[] } {
  const consultas: string[] = [];
  return {
    consultas,
    async getCall(callSid: string): Promise<GetTwilioCallResult> {
      consultas.push(callSid);
      return {
        estado: 'ok',
        call: {
          sid: callSid,
          status,
          durationSeconds,
          answeredBy: null,
          startedAt: new Date(INICIO_UNIX * 1000).toISOString(),
          endedAt: new Date((INICIO_UNIX + durationSeconds) * 1000).toISOString(),
          price: 0.014,
          to: '+56900000001',
          from: '+56000000000',
          direction: 'outbound-api',
        },
      };
    },
  };
}

describe('conversation-sync', () => {
  it('atribuye por el enlace CONVERSATION# local y registra el resultado completo', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);
    const detail = makeDetail();
    await repos.followupRepository.linkConversation(detail.conversation_id, followup.followupId);

    const { client } = fakeClient([detail]);
    const summary = await syncConversations({}, { conversationsClient: client, ...repos });

    expect(summary.registradas).toBe(1);
    expect(summary.items[0]).toMatchObject({ estado: 'registrada', via: 'conversation_link' });

    const call = await repos.followupRepository.getCall(
      followup.followupId,
      detail.conversation_id,
    );
    expect(call?.transcript).toHaveLength(2);
    expect(call?.callSid).toBe('CAreal999');
    expect(call?.cost).toBe(421);
    expect(call?.terminationReason).toBe('Call ended by remote party');
    expect(call?.fuente).toBe('sync');
    // El rationale de cada campo extraido es la evidencia para auditar la clasificacion.
    expect(call?.dataCollectionDetail?.tiene_bloqueo_tecnico?.rationale).toContain('clave');
    // technical_problem -> FOLLOW_UP (misma taxonomia que usa el webhook: un solo recorder).
    expect((await repos.followupRepository.getById(followup.followupId))?.estado).toBe('FOLLOW_UP');
  });

  it('atribuye por el followup_id de las dynamic_variables y deja el enlace escrito', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);
    // Sin enlace local: es el caso de una base recreada, o de un webhook que nunca llego.
    const detail = makeDetail({
      conversation_initiation_client_data: {
        dynamic_variables: { orden_compra: '100', followup_id: followup.followupId },
      },
    });

    const { client } = fakeClient([detail]);
    const summary = await syncConversations({}, { conversationsClient: client, ...repos });

    expect(summary.items[0]).toMatchObject({ estado: 'registrada', via: 'user_id' });
    // El enlace queda escrito para que el proximo sync no tenga ni que pedir el detalle.
    expect(
      await repos.followupRepository.findFollowupIdByConversation(detail.conversation_id),
    ).toBe(followup.followupId);
  });

  it('no confunde el user_id que rellena ElevenLabs (el telefono) con una atribucion', async () => {
    const repos = await freshRepos();
    await repos.followupRepository.create(makeFollowup());
    // Asi vienen las conversaciones reales de esta cuenta: ElevenLabs pone el numero ahi.
    const detail = makeDetail({ user_id: '+56956194817' });

    const { client } = fakeClient([detail]);
    const summary = await syncConversations({}, { conversationsClient: client, ...repos });

    expect(summary.noAtribuibles).toBe(1);
    expect(summary.registradas).toBe(0);
    expect(summary.items[0]?.motivo).toContain('sin enlace local ni followup_id');
  });

  it('ignora una conversacion todavia en curso sin siquiera pedir su detalle', async () => {
    const repos = await freshRepos();
    const detail = makeDetail({ status: 'in-progress' });

    const { client, pedidos } = fakeClient([detail]);
    const summary = await syncConversations({}, { conversationsClient: client, ...repos });

    expect(summary.noFinales).toBe(1);
    // Guardarla ahora ganaria la escritura condicional y el resultado bueno se descartaria
    // despues como duplicado.
    expect(pedidos).toEqual([]);
  });

  it('re-correrlo no duplica ni vuelve a pedir el detalle de lo ya registrado', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);
    const detail = makeDetail();
    await repos.followupRepository.linkConversation(detail.conversation_id, followup.followupId);

    const { client, pedidos } = fakeClient([detail]);
    await syncConversations({}, { conversationsClient: client, ...repos });
    const segunda = await syncConversations({}, { conversationsClient: client, ...repos });

    expect(segunda.yaRegistradas).toBe(1);
    expect(segunda.registradas).toBe(0);
    expect(pedidos).toEqual([detail.conversation_id]);
    expect(await repos.followupRepository.listCalls(followup.followupId)).toHaveLength(1);
  });

  it('fecha el fin como inicio + duracion, no como "ahora"', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);
    const detail = makeDetail();
    await repos.followupRepository.linkConversation(detail.conversation_id, followup.followupId);

    const { client } = fakeClient([detail]);
    await syncConversations({}, { conversationsClient: client, ...repos });

    const call = await repos.followupRepository.getCall(
      followup.followupId,
      detail.conversation_id,
    );
    expect(call?.startedAt).toBe(new Date(INICIO_UNIX * 1000).toISOString());
    // Sin esto, una conversacion de la semana pasada quedaria fechada el dia del sync.
    expect(call?.endedAt).toBe(new Date((INICIO_UNIX + 61) * 1000).toISOString());
  });

  it('la atribucion forzada exige que el followup exista', async () => {
    const repos = await freshRepos();
    const detail = makeDetail();
    const { client } = fakeClient([detail]);

    const item = await syncConversacionForzada(detail.conversation_id, randomUUID(), {
      conversationsClient: client,
      ...repos,
    });
    expect(item.estado).toBe('error');
    expect(item.motivo).toContain('no existe el FOLLOWUP');
  });

  it('la atribucion forzada registra una conversacion que el sync no podia atribuir solo', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);
    const detail = makeDetail();
    const { client } = fakeClient([detail]);

    const item = await syncConversacionForzada(detail.conversation_id, followup.followupId, {
      conversationsClient: client,
      ...repos,
    });

    expect(item).toMatchObject({ estado: 'registrada', via: 'forzada' });
    expect(
      await repos.followupRepository.getCall(followup.followupId, detail.conversation_id),
    ).not.toBeNull();
  });
});

describe('conversation-sync + estado final de Twilio', () => {
  /** Una conversacion como la que deja ElevenLabs cuando nadie atendio: `done` y vacia. */
  function conversacionVacia(): ConversationDetail {
    return makeDetail({
      call_duration_secs: 0,
      transcript: [],
      metadata: {
        call_duration_secs: 0,
        start_time_unix_secs: INICIO_UNIX,
        phone_call: { type: 'twilio', call_sid: 'CAreal999' },
      },
      analysis: {},
    });
  }

  it('una conversacion vacia con no-answer en Twilio no se cierra como contactada', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);
    const detail = conversacionVacia();
    await repos.followupRepository.linkConversation(detail.conversation_id, followup.followupId);

    const { client } = fakeClient([detail]);
    const twilioClient = fakeTwilio('no-answer');
    const summary = await syncConversations(
      {},
      { conversationsClient: client, twilioClient, ...repos },
    );

    expect(twilioClient.consultas).toEqual(['CAreal999']);
    expect(summary.items[0]).toMatchObject({ estado: 'registrada', twilioStatus: 'no-answer' });
    expect(summary.twilio).toMatchObject({ consultado: true, conversacionesCruzadas: 1 });

    const call = await repos.followupRepository.getCall(
      followup.followupId,
      detail.conversation_id,
    );
    expect(call?.outcome).toBe('no_answer');
    expect(call?.twilio?.status).toBe('no-answer');
    // Cuenta un intento y vuelve a quedar disponible, en vez de cerrarse (que es lo que pasaba).
    expect((await repos.followupRepository.getById(followup.followupId))?.estado).toBe('READY');
  });

  it('sin cliente de Twilio el sync funciona igual que antes, y lo dice en el reporte', async () => {
    const repos = await freshRepos();
    const followup = makeFollowup();
    await repos.followupRepository.create(followup);
    const detail = conversacionVacia();
    await repos.followupRepository.linkConversation(detail.conversation_id, followup.followupId);

    const { client } = fakeClient([detail]);
    const summary = await syncConversations({}, { conversationsClient: client, ...repos });

    expect(summary.twilio.consultado).toBe(false);
    expect(summary.twilio.motivo).toContain('TWILIO_ACCOUNT_SID');
    expect(summary.pendientes).toEqual([]);
    const call = await repos.followupRepository.getCall(
      followup.followupId,
      detail.conversation_id,
    );
    expect(call?.outcome).toBe('follow_up_required');
  });

  it('la segunda pasada destraba un DIALING que no tiene ninguna conversacion', async () => {
    const repos = await freshRepos();
    const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const followup = makeFollowup({
      estado: 'DIALING',
      ultimoCallSid: 'CAsinConversacion',
      ultimoIntentoAt: hace2h,
      updatedAt: hace2h,
    });
    await repos.followupRepository.create(followup);

    // ElevenLabs no tiene NADA de esta llamada: la lista viene vacia.
    const { client } = fakeClient([]);
    const summary = await syncConversations(
      {},
      { conversationsClient: client, twilioClient: fakeTwilio('busy'), ...repos },
    );

    expect(summary.total).toBe(0);
    expect(summary.pendientes).toHaveLength(1);
    expect(summary.pendientes[0]).toMatchObject({ estado: 'resuelta_por_twilio', outcome: 'busy' });
    expect(summary.twilio.dialingResueltos).toBe(1);
    expect((await repos.followupRepository.getById(followup.followupId))?.estado).toBe('READY');
  });
});
