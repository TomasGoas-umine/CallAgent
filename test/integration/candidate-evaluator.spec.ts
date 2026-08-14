import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowupRepository } from '../../src/repositories/followup-repository.js';
import { ContactRepository } from '../../src/repositories/contact-repository.js';
import { IdempotencyRepository } from '../../src/repositories/idempotency-repository.js';
import { InMemoryQueueClient } from '../../src/services/queue.js';
import {
  startDynamoServerHarness,
  createTestTable,
  type DynamoServerHarness,
} from './test-dynamo-harness.js';
import { FIXTURE_REFERENCE_NOW } from '../fixtures/reference-time.js';

const ORIGINAL_ENV = { ...process.env };
let serverHarness: DynamoServerHarness;

beforeAll(async () => {
  serverHarness = await startDynamoServerHarness();
});

afterAll(async () => {
  await serverHarness.stop();
});

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.DRY_RUN = 'false';
  process.env.KILL_SWITCH = 'false';
  process.env.DAILY_QUOTA = '10';
  process.env.COOLDOWN_HOURS = '24';
  // Solo se fakea Date (no setTimeout/setImmediate/etc.) — dynalite corre sobre HTTP real y
  // fakear los timers de socket/event-loop completos cuelga las requests indefinidamente.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIXTURE_REFERENCE_NOW));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

async function freshEvaluator() {
  vi.resetModules();
  return import('../../src/handlers/candidate-evaluator/handler.js');
}

/** Cada test pide su propia tabla (dentro del mismo servidor dynalite) para no arrastrar
 *  estado de otros tests: idempotencia y cooldown son justamente lo que se prueba aca. */
async function freshRepos() {
  const tableName = `evaluator-test-${randomUUID()}`;
  await createTestTable(serverHarness.client, tableName);
  return {
    followupRepository: new FollowupRepository(tableName, serverHarness.doc),
    contactRepository: new ContactRepository(tableName, serverHarness.doc),
    idempotencyRepository: new IdempotencyRepository(tableName, serverHarness.doc),
    queue: new InMemoryQueueClient(),
  };
}

describe('candidate-evaluator', () => {
  it('kill switch activo aborta todo el flujo sin tocar el Semaforo ni la base', async () => {
    process.env.KILL_SWITCH = 'true';
    const { runCandidateEvaluator } = await freshEvaluator();
    const deps = await freshRepos();
    const result = await runCandidateEvaluator(deps);
    expect(result.killSwitch).toBe(true);
    expect(result.created).toHaveLength(0);
    expect(result.discarded).toHaveLength(0);
    expect(deps.queue.size()).toBe(0);
  });

  it('DRY_RUN=true lista candidatos CRITICO sin crear FOLLOWUP ni encolar', async () => {
    process.env.DRY_RUN = 'true';
    const { runCandidateEvaluator } = await freshEvaluator();
    const deps = await freshRepos();
    const result = await runCandidateEvaluator(deps);

    expect(result.dryRun).toBe(true);
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.created.every((c) => c.estado === 'DRY_RUN')).toBe(true);
    expect(deps.queue.size()).toBe(0);
  });

  it('crea FOLLOWUP y encola los candidatos CRITICO con telefono, descarta el resto con motivo trazable', async () => {
    const { runCandidateEvaluator } = await freshEvaluator();
    const deps = await freshRepos();
    const result = await runCandidateEvaluator(deps);

    expect(result.created.length).toBeGreaterThan(0);
    expect(deps.queue.size()).toBe(result.created.length);

    const motivos = result.discarded.map((d) => d.motivo);
    expect(motivos).toContain('sin_telefono');

    for (const created of result.created) {
      const followup = await deps.followupRepository.getById(created.followupId);
      expect(followup?.estado).toBe('READY');
      expect(followup?.contexto.nivelDetectado).toBe('CRITICO');
    }
  });

  it('descarta candidatos marcados do_not_call en ContactRepository', async () => {
    const { runCandidateEvaluator } = await freshEvaluator();
    const deps = await freshRepos();

    // El primer alumno con telefono del grupo SINT-CRITICO-DO-NOT-CALL es el representante
    // que el evaluador elige para ese grupo (ver test/fixtures/README.md).
    const dncPhone = '+56900100137';
    await deps.contactRepository.markDoNotCall(dncPhone);

    const result = await runCandidateEvaluator(deps);
    const created = result.created.find((c) => c.destinatarioPhone === dncPhone);
    expect(created).toBeUndefined();
    expect(result.discarded.some((d) => d.motivo === 'do_not_call')).toBe(true);
  });

  it('descarta candidatos contactados dentro de la ventana de cooldown', async () => {
    const { runCandidateEvaluator } = await freshEvaluator();
    const deps = await freshRepos();

    // Representante del grupo SINT-CRITICO-DEMO (el mismo que usa scripts/local-demo.ts).
    const recentlyContactedPhone = '+56900100141';
    await deps.contactRepository.markContacted(recentlyContactedPhone, new Date().toISOString());

    const result = await runCandidateEvaluator(deps);
    const created = result.created.find((c) => c.destinatarioPhone === recentlyContactedPhone);
    expect(created).toBeUndefined();
    expect(result.discarded.some((d) => d.motivo === 'cooldown')).toBe(true);
  });

  it('no crea un segundo FOLLOWUP para el mismo candidato en la misma semana (idempotencia)', async () => {
    const { runCandidateEvaluator } = await freshEvaluator();
    const deps = await freshRepos();

    const first = await runCandidateEvaluator(deps);
    const second = await runCandidateEvaluator(deps);

    expect(first.created.length).toBeGreaterThan(0);
    expect(second.created).toHaveLength(0);
    expect(second.discarded.some((d) => d.motivo === 'duplicado')).toBe(true);
  });
});
