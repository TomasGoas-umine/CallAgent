import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import dynalite from 'dynalite';
import type { Server } from 'node:http';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FollowupRepository } from '../../src/repositories/followup-repository.js';
import { ContactRepository } from '../../src/repositories/contact-repository.js';
import { IdempotencyRepository } from '../../src/repositories/idempotency-repository.js';
import { ConditionalCheckFailedError } from '../../src/repositories/base-repository.js';
import type { Followup } from '../../src/domain/followup.js';

const TABLE_NAME = 'umine-voice-test';
let server: Server;
let doc: DynamoDBDocumentClient;
let port: number;

beforeAll(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;

  const ddb = new DynamoDBClient({
    region: 'us-east-1',
    endpoint: `http://localhost:${port}`,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  doc = DynamoDBDocumentClient.from(ddb);

  await ddb.send(
    new CreateTableCommand({
      TableName: TABLE_NAME,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
        { AttributeName: 'GSI2PK', AttributeType: 'S' },
        { AttributeName: 'GSI2SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeFollowup(overrides: Partial<Followup> = {}): Followup {
  const now = new Date().toISOString();
  return {
    followupId: 'f-1',
    motivo: 'riesgo_conexion_critico',
    prioridad: 'ALTA',
    estado: 'READY',
    destinatarioId: 'client_x',
    destinatarioPhone: '+56900000001',
    oc: '100',
    curso: 'Curso X',
    intentos: 0,
    nextAttemptAt: now,
    idempotencyKey: 'key-1',
    createdAt: now,
    updatedAt: now,
    contexto: {
      clientId: 'client_x',
      clientName: 'Cliente X',
      courseName: 'Curso X',
      orderNumber: '100',
      initCourse: '2026-07-01',
      endCourse: '2026-08-01',
      nivelDetectado: 'CRITICO',
      seccion: 'A_RIESGO_CONEXION',
    },
    ...overrides,
  };
}

describe('FollowupRepository', () => {
  it('crea un followup y lo puede leer de vuelta', async () => {
    const repo = new FollowupRepository(TABLE_NAME, doc);
    const followup = makeFollowup({ followupId: 'f-create-1' });
    await repo.create(followup);
    const loaded = await repo.getById('f-create-1');
    expect(loaded?.estado).toBe('READY');
    expect(loaded?.destinatarioPhone).toBe('+56900000001');
  });

  it('rechaza crear dos veces el mismo followupId (anti duplicado)', async () => {
    const repo = new FollowupRepository(TABLE_NAME, doc);
    const followup = makeFollowup({ followupId: 'f-dup-1' });
    await repo.create(followup);
    await expect(repo.create(followup)).rejects.toBeInstanceOf(ConditionalCheckFailedError);
  });

  it('markDialing transiciona READY->DIALING una sola vez (anti doble disparo)', async () => {
    const repo = new FollowupRepository(TABLE_NAME, doc);
    const followup = makeFollowup({ followupId: 'f-dialing-1' });
    await repo.create(followup);

    await repo.markDialing('f-dialing-1');
    const loaded = await repo.getById('f-dialing-1');
    expect(loaded?.estado).toBe('DIALING');

    // Un segundo intento de marcar DIALING debe fallar: ya no esta en READY.
    await expect(repo.markDialing('f-dialing-1')).rejects.toBeInstanceOf(
      ConditionalCheckFailedError,
    );
  });

  it('recordCall es idempotente por conversation_id', async () => {
    const repo = new FollowupRepository(TABLE_NAME, doc);
    const followup = makeFollowup({ followupId: 'f-call-1' });
    await repo.create(followup);

    const call = {
      followupId: 'f-call-1',
      conversationId: 'conv-abc',
      callSid: 'CA123',
      status: 'done',
      durationSeconds: 42,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      dataCollection: {},
      evaluation: {},
      transcriptS3Key: null,
    };

    const first = await repo.recordCall(call);
    const second = await repo.recordCall(call);
    expect(first).toBe('created');
    expect(second).toBe('already_exists');
  });

  it('findRecentByDestinatario devuelve followups del mismo destinatario dentro de la ventana', async () => {
    const repo = new FollowupRepository(TABLE_NAME, doc);
    const phone = '+56900000099';
    const past = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // hace 1h
    await repo.create(
      makeFollowup({ followupId: 'f-cooldown-1', destinatarioPhone: phone, createdAt: past }),
    );

    const since = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // ultimas 24h
    const recent = await repo.findRecentByDestinatario(phone, since);
    expect(recent.some((f) => f.followupId === 'f-cooldown-1')).toBe(true);
  });
});

describe('ContactRepository', () => {
  it('marca do_not_call de forma permanente', async () => {
    const repo = new ContactRepository(TABLE_NAME, doc);
    const phone = '+56911111111';
    expect(await repo.isDoNotCall(phone)).toBe(false);
    await repo.markDoNotCall(phone);
    expect(await repo.isDoNotCall(phone)).toBe(true);
  });

  it('markContacted actualiza last_contacted_at sin borrar do_not_call previo', async () => {
    const repo = new ContactRepository(TABLE_NAME, doc);
    const phone = '+56922222222';
    await repo.markDoNotCall(phone);
    await repo.markContacted(phone);
    const contact = await repo.getByPhone(phone);
    expect(contact?.doNotCall).toBe(true);
    expect(contact?.lastContactedAt).not.toBeNull();
  });
});

describe('IdempotencyRepository', () => {
  it('tryAcquireLock devuelve true la primera vez y false la segunda', async () => {
    const repo = new IdempotencyRepository(TABLE_NAME, doc);
    const first = await repo.tryAcquireLock('idem-key-1', 'f-1');
    const second = await repo.tryAcquireLock('idem-key-1', 'f-2');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
