/**
 * Los tres cerrojos que impiden que el Tablero Mock llame de mas: toggle, transicion y cooldown.
 * Mas la whitelist dura de la etapa de pruebas.
 *
 * Nunca se llama de verdad: el proveedor es `MockElevenLabsClient`.
 */

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowupRepository } from '../../src/repositories/followup-repository.js';
import { ContactRepository } from '../../src/repositories/contact-repository.js';
import { IdempotencyRepository } from '../../src/repositories/idempotency-repository.js';
import { QuotaRepository } from '../../src/repositories/quota-repository.js';
import { MockElevenLabsClient } from '../../src/services/elevenlabs-client.js';
import {
  startDynamoServerHarness,
  createTestTable,
  type DynamoServerHarness,
} from './test-dynamo-harness.js';

const ORIGINAL_ENV = { ...process.env };
let serverHarness: DynamoServerHarness;

const TEL = '+56956194817';
/** El otro numero de la etapa de pruebas: las OCs del Mock pueden apuntar a cualquiera de los dos. */
const SEGUNDO = '+56955326503';
const OC = { clientId: 'client_test_normal_s1', orderNumber: 'TEST-9104' };
/** Martes 12:00 Santiago — dentro de la ventana horaria, para que el guardrail no interfiera. */
const MARTES = new Date('2026-08-11T16:00:00.000Z');

beforeAll(async () => {
  serverHarness = await startDynamoServerHarness();
});
afterAll(async () => {
  await serverHarness.stop();
});

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.ALLOWLIST_NUMBERS = TEL;
  process.env.KILL_SWITCH = 'false';
  process.env.DAILY_QUOTA = '50';
  process.env.TABLERO_API_MODE = 'fixture';
  process.env.BUSINESS_HOURS_START = '00:00';
  process.env.BUSINESS_HOURS_END = '23:59';
  process.env.TIMEZONE = 'America/Santiago';
  process.env.MOCK_CALL_COOLDOWN_SECONDS = '300';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MARTES);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

/** Modulos frescos por test: el store del Mock es un singleton de modulo. */
async function freshModules() {
  vi.resetModules();
  const store = await import('../../src/services/mock-tablero-store.js');
  const trigger = await import('../../src/services/mock-call-trigger.js');
  store.resetMockStore();
  return { store, trigger };
}

async function freshDeps() {
  const tableName = `mock-trigger-${randomUUID()}`;
  await createTestTable(serverHarness.client, tableName);
  return {
    followupRepository: new FollowupRepository(tableName, serverHarness.doc),
    contactRepository: new ContactRepository(tableName, serverHarness.doc),
    idempotencyRepository: new IdempotencyRepository(tableName, serverHarness.doc),
    quotaRepository: new QuotaRepository(tableName, serverHarness.doc),
    elevenLabsClient: new MockElevenLabsClient('success'),
  };
}

/** Deja la OC en condicion de llamar: semana 3, cero conexiones. */
function volverCritica(store: Awaited<ReturnType<typeof freshModules>>['store']) {
  const dia = 24 * 60 * 60 * 1000;
  const now = Date.now();
  return store.updateMockOrder(OC.clientId, OC.orderNumber, {
    initCourse: new Date(now - 20 * dia).toISOString().slice(0, 10),
    endCourse: new Date(now + 10 * dia).toISOString().slice(0, 10),
    conexiones: 0,
  });
}

describe('mock-call-trigger', () => {
  it.each(['A', 'B'])(
    'PATCH → preview → llamada HTTP de criterio %s conserva las variables y sección',
    async (criterio) => {
      await freshModules();
      const { registerApiRoutes } = await import('../../src/local/api-routes.js');
      const { RealElevenLabsClient } = await import('../../src/services/elevenlabs-client.js');
      const deps = await freshDeps();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(
            JSON.stringify({ success: true, conversation_id: 'conv_wire', callSid: 'CA_wire' }),
            { status: 200 },
          ),
        );
      const app = Fastify();
      try {
        await app.register(registerApiRoutes, {
          ...deps,
          manualCallDeps: { ...deps, elevenLabsClient: new RealElevenLabsClient('test-key') },
        });
        const patched = await app.inject({
          method: 'PATCH',
          url: '/api/tablero/mock/orders/client_test_demo/TEST-9600',
          payload: {
            contactoNombre: 'Francisca Rojas',
            clientName: 'Empresa de prueba',
            courseName: 'Excel aplicado',
            inscritos: 8,
            conexiones: criterio === 'B' ? 8 : 1,
            djs: criterio === 'B' ? 2 : 0,
            initCourse: '2026-07-01',
            endCourse: criterio === 'B' ? '2026-08-01' : '2026-08-14',
          },
        });
        expect(patched.statusCode).toBe(200);
        const preview = patched
          .json()
          .ordenes.find(
            (e: { order: { orderNumber: string } }) => e.order.orderNumber === 'TEST-9600',
          ).variablesAgente;
        const tablero = (await app.inject({ method: 'GET', url: '/api/tablero' })).json();
        expect(
          tablero.cursos.find((c: { orderNumber: string }) => c.orderNumber === 'TEST-9600')
            .variablesAgente,
        ).toEqual(preview);
        expect(fetchSpy).not.toHaveBeenCalled();
        const call = await app.inject({
          method: 'POST',
          url: '/api/calls',
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            clientId: 'client_test_demo',
            orderNumber: 'TEST-9600',
            phone: TEL,
            seccion: criterio === 'B' ? 'B_RIESGO_DJ' : 'A_RIESGO_CONEXION',
          },
        });
        expect(call.statusCode).toBe(201);
        const [url, request] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('https://api.elevenlabs.io/v1/convai/twilio/outbound-call');
        const body = JSON.parse(request!.body as string);
        expect(body.conversation_initiation_client_data.dynamic_variables).toEqual({
          ...preview,
          followup_id: call.json().followupId,
        });
        expect(preview.nombre_interlocutor).toBe('Francisca Rojas');
        expect(preview.pct_conexion).toBe(criterio === 'B' ? '100%' : '12.5%');
        expect(preview.motivo).toBe(
          criterio === 'B' ? 'riesgo_dj_critico' : 'riesgo_conexion_critico',
        );
        expect(preview.dj_pendientes).toBe(criterio === 'B' ? '6' : '');
        expect(preview.dias_restantes).toBe(criterio === 'B' ? '-10' : '3');
        // Los nombres vacíos sirven para probar contexto incompleto: nunca enviar la OC
        // como nombre de curso ni "Sin cliente", que son fallbacks visuales del agrupador.
        await app.inject({
          method: 'PATCH',
          url: '/api/tablero/mock/orders/client_test_demo/TEST-9600',
          payload: { contactoNombre: '', clientName: '', courseName: '' },
        });
        const incomplete = (await app.inject({ method: 'GET', url: '/api/tablero' }))
          .json()
          .cursos.find((c: { orderNumber: string }) => c.orderNumber === 'TEST-9600');
        expect(incomplete.variablesAgente).toMatchObject({
          nombre_cliente: '',
          nombre_curso: '',
          nombre_interlocutor: 'el encargado de capacitacion',
        });
        await app.inject({
          method: 'POST',
          url: '/api/calls',
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            clientId: 'client_test_demo',
            orderNumber: 'TEST-9600',
            phone: TEL,
            seccion: criterio === 'B' ? 'B_RIESGO_DJ' : 'A_RIESGO_CONEXION',
          },
        });
        expect(
          JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string).conversation_initiation_client_data
            .dynamic_variables,
        ).toMatchObject(incomplete.variablesAgente);
      } finally {
        fetchSpy.mockRestore();
        await app.close();
      }
    },
  );
  it('todos los casos usan el contexto que muestra el mock y respetan los casos no llamables', async () => {
    const { store } = await freshModules();
    const { originateManualCall } = await import('../../src/services/manual-call.js');
    const deps = await freshDeps();
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    for (const e of store.evaluateAllMockOrders()) {
      spy.mockClear();
      const result = await originateManualCall(
        { ...e.order, phone: TEL, idempotencyKey: randomUUID() },
        deps,
      );
      if (e.regla.dispara) {
        expect(result.status, e.order.orderNumber).toBe('dialing');
        expect(spy).toHaveBeenCalledWith(
          expect.objectContaining({ dynamicVariables: e.variablesAgente }),
        );
        expect(e.variablesAgente.nombre_interlocutor).not.toMatch(/TEST|MOCK/);
      } else {
        expect(result.status).toMatch(/curso_no_critico|curso_no_encontrado/);
        expect(spy).not.toHaveBeenCalled();
      }
    }
  });

  it('relee contacto, empresa, curso y métricas si cambian entre prechequeo y marcado', async () => {
    const { store } = await freshModules();
    const { originateManualCall } = await import('../../src/services/manual-call.js');
    const { MockTableroApiClient } = await import('../../src/services/tablero-api-client.mock.js');
    volverCritica(store);
    const deps = await freshDeps();
    const client = new MockTableroApiClient();
    const search = client.search.bind(client);
    let reads = 0;
    vi.spyOn(client, 'search').mockImplementation(async (filters) => {
      if (++reads === 2)
        store.updateMockOrder(OC.clientId, OC.orderNumber, {
          contactoNombre: 'Francisca Rojas',
          clientName: 'Empresa actualizada',
          courseName: 'Curso actualizado',
          inscritos: 8,
          conexiones: 1,
          endCourse: '2026-08-14',
        });
      return search(filters);
    });
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    const result = await originateManualCall(
      { ...OC, phone: TEL, idempotencyKey: randomUUID() },
      { ...deps, tableroClient: client },
    );
    expect(result.status).toBe('dialing');
    expect(spy.mock.calls[0]![0].dynamicVariables).toEqual({
      nombre_interlocutor: 'Francisca Rojas',
      nombre_cliente: 'Empresa actualizada',
      nombre_curso: 'Curso actualizado',
      dias_restantes: '3',
      pct_conexion: '12.5%',
      dj_pendientes: '',
      orden_compra: OC.orderNumber,
      motivo: 'riesgo_conexion_critico',
    });
  });

  it('las reglas de prueba ALERTA se cumplen también en la revalidación del dispatcher', async () => {
    const { store, trigger } = await freshModules();
    const rules = store.getCallRules();
    rules.nivelesQueLlaman = ['CRITICO', 'ALERTA'];
    rules.llamarSiPctMenorA[2] = 60;
    store.setCallRules(rules);
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    const e = store.evaluateAllMockOrders().find((c) => c.order.orderNumber === 'TEST-9101')!;
    const deps = await freshDeps();
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    // Aunque otro cliente se inyecte o TABLERO_API_MODE cambie, el trigger lee su propio Mock.
    const otherSearch = vi.fn(async () => {
      throw new Error('No debe consultar datos reales');
    });
    const result = await trigger.maybeTriggerMockCall(e.order.clientId, e.order.orderNumber, {
      ...deps,
      tableroClient: { search: otherSearch },
    });
    expect(result.llamada?.status).toBe('dialing');
    expect(spy.mock.calls[0]![0].dynamicVariables.pct_conexion).toBe('55%');
    expect(otherSearch).not.toHaveBeenCalled();
    expect(
      (await deps.followupRepository.getById(result.llamada!.followupId!))?.contexto.nivelDetectado,
    ).toBe('ALERTA');
  });

  it('un bloqueo de consentimiento no se presenta como llamada originada', async () => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    await deps.contactRepository.markDoNotCall(TEL);
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    volverCritica(store);
    const result = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    expect(result).toMatchObject({
      disparo: false,
      motivo: 'llamada_no_originada',
      llamada: { status: 'do_not_call' },
    });
  });
  /**
   * El telefono elegido por OC tiene que llegar hasta el proveedor. Si se quedara en la pantalla,
   * el selector seria decorativo y la llamada saldria al numero por defecto.
   */
  it('llama al numero que la OC tiene asignado, no al que esta por defecto', async () => {
    // `env` se congela al importar los modulos: la allowlist va antes de `freshModules`.
    process.env.ALLOWLIST_NUMBERS = `${TEL},${SEGUNDO}`;
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    volverCritica(store);
    expect(store.updateMockOrder(OC.clientId, OC.orderNumber, { phone: SEGUNDO }).ok).toBe(true);

    const r = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);

    expect(r.motivo).toBe('llamada_originada');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ toNumber: SEGUNDO }));
    // Y el FOLLOWUP quedo registrado contra ese numero, no contra el default.
    const followups = await deps.followupRepository.listByEstados(['DIALING'], 10);
    expect(followups[0]?.destinatarioPhone).toBe(SEGUNDO);
  });

  it('el do_not_call de un numero no bloquea a las OCs asignadas al otro', async () => {
    process.env.ALLOWLIST_NUMBERS = `${TEL},${SEGUNDO}`;
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    await deps.contactRepository.markDoNotCall(TEL);
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    volverCritica(store);
    store.updateMockOrder(OC.clientId, OC.orderNumber, { phone: SEGUNDO });

    const r = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);

    expect(r.motivo).toBe('llamada_originada');
  });

  it('con el toggle apagado NO llama, por critica que este la OC', async () => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    volverCritica(store);

    const r = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);

    expect(r.disparo).toBe(false);
    expect(r.motivo).toBe('auto_call_desactivado');
    expect(await deps.followupRepository.listByEstados(['READY', 'DIALING'], 10)).toHaveLength(0);
  });

  it('con el toggle encendido, la transicion no->si origina la llamada', async () => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    volverCritica(store);

    const r = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);

    expect(r.motivo).toBe('llamada_originada');
    expect(r.llamada?.status).toBe('dialing');
    expect(r.llamada?.conversationId).toBeDefined();
  });

  it('guardar de nuevo sin cambiar la condicion NO vuelve a llamar (sin transicion)', async () => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    volverCritica(store);

    await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    const segundo = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);

    expect(segundo.disparo).toBe(false);
    expect(segundo.motivo).toBe('sin_transicion');
  });

  it('salir y volver a la condicion dentro del cooldown NO vuelve a llamar', async () => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    volverCritica(store);
    await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);

    // Sale de la condicion (el latch se desarma) y vuelve a entrar.
    store.updateMockOrder(OC.clientId, OC.orderNumber, { conexiones: 20 });
    await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    volverCritica(store);
    const tercero = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);

    expect(tercero.disparo).toBe(false);
    expect(tercero.motivo).toBe('en_cooldown');
    expect(tercero.cooldownRestanteSegundos).toBeGreaterThan(0);
  });

  it('pasado el cooldown, una nueva transicion si vuelve a llamar', async () => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    volverCritica(store);
    await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);

    store.updateMockOrder(OC.clientId, OC.orderNumber, { conexiones: 20 });
    await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    volverCritica(store);

    vi.setSystemTime(new Date(MARTES.getTime() + 301 * 1000));
    const r = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);

    expect(r.motivo).toBe('llamada_originada');
  });

  it('una OC que no cumple la regla no llama aunque el toggle este encendido', async () => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    store.updateMockOrder(OC.clientId, OC.orderNumber, { conexiones: 20 });

    const r = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    expect(r.motivo).toBe('no_cumple_regla');
  });

  it('una OC inexistente no revienta ni llama', async () => {
    const { trigger } = await freshModules();
    const deps = await freshDeps();
    const r = await trigger.maybeTriggerMockCall('nope', 'nope', deps);
    expect(r).toEqual({ disparo: false, motivo: 'oc_no_encontrada' });
  });

  it('la whitelist dura rechaza cualquier numero que no sea el de pruebas', async () => {
    process.env.ALLOWLIST_NUMBERS = `${TEL},+56911112222`;
    const { store } = await freshModules();
    const { originateManualCall } = await import('../../src/services/manual-call.js');
    const deps = await freshDeps();
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    volverCritica(store);

    const r = await originateManualCall(
      {
        clientId: OC.clientId,
        orderNumber: OC.orderNumber,
        phone: '+56911112222', // en la allowlist, pero NO en la whitelist de pruebas
        idempotencyKey: 'wl-test',
      },
      deps,
    );

    expect(r.status).toBe('fuera_de_whitelist_pruebas');
    expect(await deps.followupRepository.listByEstados(['READY', 'DIALING'], 10)).toHaveLength(0);
  });
});

/**
 * Las secciones B (Riesgo DJ) y C (Rectificacion) existen en el Tablero Mock para VERSE y
 * EDITARSE, nunca para llamar: la DJ y la OC Final se resuelven con el OTIC, no con el alumno
 * por telefono. Esta garantia es estructural —la regla de llamada sale solo de la seccion A—
 * pero se prueba de punta a punta igual: es exactamente el tipo de cosa que un refactor rompe
 * sin que nadie se entere hasta que suena un telefono. Ver ADR-011.
 */
describe('criterio B llama por DJ; criterio C permanece fuera de voz', () => {
  const dia = 24 * 60 * 60 * 1000;
  const enDias = (n: number) => new Date(Date.now() + n * dia).toISOString().slice(0, 10);

  /** Deja la OC critica en la seccion B: cerrada hace 10 dias, 8 conectados, ninguna DJ. */
  function volverCriticaEnDj(store: Awaited<ReturnType<typeof freshModules>>['store']) {
    store.updateMockOrder(OC.clientId, OC.orderNumber, {
      initCourse: enDias(-40),
      endCourse: enDias(-10),
    });
    return store.updateMockOrder(OC.clientId, OC.orderNumber, { conexiones: 8, djs: 0 });
  }

  it('el umbral DJ personalizado permite llamar en ALERTA y el dispatcher mantiene ese nivel', async () => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    volverCriticaEnDj(store);
    store.updateMockOrder(OC.clientId, OC.orderNumber, { endCourse: enDias(-4) });
    const rules = store.getCallRules();
    rules.dj = { llamarSiDiasMayorA: 3, nivelesQueLlaman: ['ALERTA'] };
    store.setCallRules(rules);
    store.setAutoCallEnabled('B_RIESGO_DJ', true);
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    const preview = store
      .evaluateAllMockOrders()
      .find((e) => e.order.orderNumber === OC.orderNumber)!;
    expect(preview.dj.nivel).toBe('ALERTA');
    const result = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    expect(result.disparo).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ dynamicVariables: preview.variablesAgente }),
    );
    expect(await deps.followupRepository.getById(result.llamada!.followupId!)).toMatchObject({
      contexto: { nivelDetectado: 'ALERTA', seccion: 'B_RIESGO_DJ' },
    });
  });
  it('revalida la regla DJ si se desactiva después del prechequeo', async () => {
    const { store } = await freshModules();
    const deps = await freshDeps();
    volverCriticaEnDj(store);
    const { MockTableroApiClient } = await import('../../src/services/tablero-api-client.mock.js');
    const { originateManualCall } = await import('../../src/services/manual-call.js');
    const client = new MockTableroApiClient();
    const search = client.search.bind(client);
    let reads = 0;
    vi.spyOn(client, 'search').mockImplementation(async (filters) => {
      if (++reads === 2) {
        const rules = store.getCallRules();
        rules.dj.llamarSiDiasMayorA = null;
        store.setCallRules(rules);
      }
      return search(filters);
    });
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    const result = await originateManualCall(
      { ...OC, phone: TEL, idempotencyKey: randomUUID(), seccion: 'B_RIESGO_DJ' },
      { ...deps, tableroClient: client },
    );
    expect(result.followupEstado).toBe('RESUELTO_SIN_LLAMADA');
    expect(spy).not.toHaveBeenCalled();
    expect((await deps.quotaRepository.peek(50)).usados).toBe(0);
  });

  it('DJ crítica con conexión completa llama por declaraciones y conserva preview, motivo y sección', async () => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    store.setAutoCallEnabled('B_RIESGO_DJ', true);
    volverCriticaEnDj(store);
    store.updateMockOrder(OC.clientId, OC.orderNumber, { inscritos: 8, conexiones: 8, djs: 2 });
    const e = store.evaluateAllMockOrders().find((c) => c.order.orderNumber === OC.orderNumber)!;
    const result = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    expect(result.disparo).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ dynamicVariables: e.variablesAgente }),
    );
    expect(e.variablesAgente).toMatchObject({
      motivo: 'riesgo_dj_critico',
      pct_conexion: '100%',
      dj_pendientes: '6',
      dias_restantes: '-10',
    });
    expect(await deps.followupRepository.getById(result.llamada!.followupId!)).toMatchObject({
      motivo: 'riesgo_dj_critico',
      contexto: { seccion: 'B_RIESGO_DJ' },
    });
    expect((await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps)).motivo).toBe(
      'sin_transicion',
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([3, 4, 7, 8])(
    'B conserva su umbral propio a %s días aunque A habilite todos los niveles',
    async (dias) => {
      vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));
      const { store, trigger } = await freshModules();
      const deps = await freshDeps();
      const rules = store.getCallRules();
      rules.nivelesQueLlaman = ['CRITICO', 'ALERTA', 'NORMAL'];
      rules.llamarSiPctMenorA = { 1: 100, 2: 100, 3: 100, 4: 100 };
      store.setCallRules(rules);
      store.setAutoCallEnabled('B_RIESGO_DJ', true);
      volverCriticaEnDj(store);
      store.updateMockOrder(OC.clientId, OC.orderNumber, { endCourse: enDias(-dias) });
      const result = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
      expect(result.disparo).toBe(dias > 7);
    },
  );

  it.each(['completa', 'sin_conectados', 'toggle', 'consentimiento', 'cuota', 'kill_switch'])(
    'B respeta exclusión/control %s',
    async (caso) => {
      if (caso === 'kill_switch') process.env.KILL_SWITCH = 'true';
      const { store, trigger } = await freshModules();
      const deps = await freshDeps();
      const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
      store.setAutoCallEnabled('B_RIESGO_DJ', caso !== 'toggle');
      volverCriticaEnDj(store);
      if (caso === 'completa') store.updateMockOrder(OC.clientId, OC.orderNumber, { djs: 8 });
      if (caso === 'sin_conectados')
        store.updateMockOrder(OC.clientId, OC.orderNumber, { conexiones: 0 });
      if (caso === 'consentimiento') await deps.contactRepository.markDoNotCall(TEL);
      if (caso === 'cuota')
        vi.spyOn(deps.quotaRepository, 'peek').mockResolvedValue({
          dateKey: '2026-08-11',
          usados: 50,
          limite: 50,
          restantes: 0,
        });
      const result = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
      expect(result.disparo).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('revalida DJ antes de marcar y cancela si se completaron, sin consumir cuota', async () => {
    const { store } = await freshModules();
    const { originateManualCall } = await import('../../src/services/manual-call.js');
    const { MockTableroApiClient } = await import('../../src/services/tablero-api-client.mock.js');
    volverCriticaEnDj(store);
    const deps = await freshDeps();
    const client = new MockTableroApiClient();
    const search = client.search.bind(client);
    let reads = 0;
    vi.spyOn(client, 'search').mockImplementation(async (filters) => {
      if (++reads === 2) store.updateMockOrder(OC.clientId, OC.orderNumber, { djs: 8 });
      return search(filters);
    });
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    const result = await originateManualCall(
      { ...OC, phone: TEL, idempotencyKey: randomUUID(), seccion: 'B_RIESGO_DJ' },
      { ...deps, tableroClient: client },
    );
    expect(result.followupEstado).toBe('RESUELTO_SIN_LLAMADA');
    expect(spy).not.toHaveBeenCalled();
    expect((await deps.quotaRepository.peek(50)).usados).toBe(0);
  });

  it('un seguimiento de A no se reconvierte a B si el curso termina entre lecturas', async () => {
    const { store } = await freshModules();
    const { originateManualCall } = await import('../../src/services/manual-call.js');
    const { MockTableroApiClient } = await import('../../src/services/tablero-api-client.mock.js');
    volverCritica(store);
    const deps = await freshDeps();
    const client = new MockTableroApiClient();
    const search = client.search.bind(client);
    let reads = 0;
    vi.spyOn(client, 'search').mockImplementation(async (filters) => {
      if (++reads === 2) volverCriticaEnDj(store);
      return search(filters);
    });
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    const result = await originateManualCall(
      { ...OC, phone: TEL, idempotencyKey: randomUUID() },
      { ...deps, tableroClient: client },
    );
    expect(result.followupEstado).toBe('RESUELTO_SIN_LLAMADA');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['compromiso', 'RESUELTO'],
    ['otic', 'ESCALADO'],
    ['rechazo', 'CERRADO'],
  ])('el post-call B conserva el resultado %s en seguimiento e historial', async (caso, estado) => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    store.setAutoCallEnabled('B_RIESGO_DJ', true);
    volverCriticaEnDj(store);
    const result = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    const conversationId = result.llamada!.conversationId!;
    const { handleElevenLabsPostCall } =
      await import('../../src/handlers/webhooks/elevenlabs-post-call/handler.js');
    const { generateTestSignatureHeader } =
      await import('../../src/auth/elevenlabs-signature-validator.js');
    const raw = JSON.stringify({
      type: 'post_call_transcription',
      event_timestamp: Math.floor(Date.now() / 1000),
      data: {
        conversation_id: conversationId,
        agent_id: 'test',
        status: 'done',
        analysis: {
          data_collection_results: {
            motivo_no_conexion: {
              value: caso === 'rechazo' ? 'no_contactar' : 'declaraciones pendientes',
            },
            compromiso_fecha: { value: caso === 'compromiso' ? '15 de septiembre' : '' },
            requiere_humano: { value: caso === 'otic' },
            tiene_bloqueo_tecnico: { value: false },
          },
        },
      },
    });
    const response = await handleElevenLabsPostCall(
      raw,
      generateTestSignatureHeader('secret', raw),
      { ...deps, webhookSecret: 'secret' },
    );
    expect(response.statusCode).toBe(200);
    expect(await deps.followupRepository.getById(result.llamada!.followupId!)).toMatchObject({
      estado,
      motivo: 'riesgo_dj_critico',
      contexto: { seccion: 'B_RIESGO_DJ' },
    });
    if (caso === 'rechazo')
      expect((await deps.contactRepository.getByPhone(TEL))?.doNotCall).toBe(true);
  });

  it.each(['CRITICO', 'ALERTA'] as const)(
    'el evaluador crea B en %s con su regla y no lo duplica',
    async (nivel) => {
      process.env.DRY_RUN = 'false';
      const { store } = await freshModules();
      const deps = await freshDeps();
      volverCriticaEnDj(store);
      if (nivel === 'ALERTA') {
        store.updateMockOrder(OC.clientId, OC.orderNumber, { endCourse: enDias(-4) });
        const rules = store.getCallRules();
        rules.dj = { llamarSiDiasMayorA: 3, nivelesQueLlaman: ['ALERTA'] };
        store.setCallRules(rules);
      }
      const { runCandidateEvaluator } =
        await import('../../src/handlers/candidate-evaluator/handler.js');
      const { MockTableroApiClient } =
        await import('../../src/services/tablero-api-client.mock.js');
      const { InMemoryQueueClient } = await import('../../src/services/queue.js');
      const queue = new InMemoryQueueClient();
      const evaluatorDeps = { ...deps, tableroClient: new MockTableroApiClient(), queue };
      const first = await runCandidateEvaluator(evaluatorDeps);
      const created = first.created.find((item) => item.orderNumber === OC.orderNumber)!;
      expect(created).toBeDefined();
      expect(await deps.followupRepository.getById(created.followupId)).toMatchObject({
        motivo: 'riesgo_dj_critico',
        contexto: { seccion: 'B_RIESGO_DJ', nivelDetectado: nivel },
      });
      const second = await runCandidateEvaluator(evaluatorDeps);
      expect(second.discarded).toContainEqual({ orderNumber: OC.orderNumber, motivo: 'duplicado' });
    },
  );

  it('una rectificacion CRITICA con las automaticas encendidas no llama a nadie', async () => {
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    store.setAutoCallEnabled('B_RIESGO_DJ', true);

    store.updateMockOrder(OC.clientId, OC.orderNumber, {
      orderStatus: 'ESPERA OC FINAL',
      ultimaActualizacion: enDias(-40),
      conexiones: 0,
    });
    const e = store.evaluateAllMockOrders().find((c) => c.order.orderNumber === OC.orderNumber)!;
    expect(e.rectificacion.nivel).toBe('CRITICO');
    expect(e.rectificacion.enSeccion).toBe(true);

    const result = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    expect(result.disparo).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('editar la DJ de una OC que SI esta en condicion de llamar tampoco produce un flanco', async () => {
    // El latch mira la seccion A. Editar `djs` no la mueve, asi que no hay transicion no→si.
    const { store, trigger } = await freshModules();
    const deps = await freshDeps();
    const spy = vi.spyOn(deps.elevenLabsClient, 'startOutboundCall');
    volverCritica(store);
    store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    // Primer flanco: esta llamada SI es legitima (seccion A), y deja el latch armado.
    const primera = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    expect(primera.disparo).toBe(true);
    spy.mockClear();

    store.updateMockOrder(OC.clientId, OC.orderNumber, {
      djs: 0,
      ultimaActualizacion: enDias(-30),
    });
    const segunda = await trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    expect(segunda.disparo).toBe(false);
    expect(segunda.motivo).toBe('sin_transicion');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('idempotencia entre corridas del store', () => {
  it('reiniciar el store permite volver a llamar la misma OC (la key incluye el runId)', async () => {
    // Los dos lados de la idempotencia viven en sitios distintos: la secuencia es memoria del
    // proceso, el lock es DynamoDB. Sin runId, la segunda corrida chocaba con la key de la
    // primera y respondia `already_processed` sin llamar nunca.
    const deps = await freshDeps();

    const primera = await freshModules();
    primera.store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    volverCritica(primera.store);
    const r1 = await primera.trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);
    expect(r1.llamada?.status).toBe('dialing');

    // Misma tabla (mismos locks persistidos), store sembrado de nuevo.
    const segunda = await freshModules();
    segunda.store.setAutoCallEnabled('A_RIESGO_CONEXION', true);
    volverCritica(segunda.store);
    const r2 = await segunda.trigger.maybeTriggerMockCall(OC.clientId, OC.orderNumber, deps);

    expect(r2.motivo).toBe('llamada_originada');
    expect(r2.llamada?.status).toBe('dialing');
  });
});
