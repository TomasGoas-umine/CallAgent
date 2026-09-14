import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ESTADOS_EDITABLES,
  evaluateAllMockOrders,
  evaluateMockOrder,
  getCallRules,
  getMockOrder,
  isAutoCallEnabled,
  listMockOrders,
  resetMockStore,
  setAutoCallEnabled,
  toTableroRecords,
  updateMockOrder,
} from '../../src/services/mock-tablero-store.js';
import { MOCK_TEST_PHONE, MOCK_TEST_PHONES } from '../../src/services/guardrails.js';
import { FIXTURE_REFERENCE_NOW } from '../fixtures/reference-time.js';

/** OC del fixture que se mantiene NORMAL alrededor de la fecha de referencia. */
const NORMAL = { clientId: 'client_test_normal_s1', orderNumber: 'TEST-9104' };

const DIA = 24 * 60 * 60 * 1000;
/** Fecha `YYYY-MM-DD` a N dias del reloj pineado. Negativo = pasado. */
const enDias = (n: number) =>
  new Date(new Date(FIXTURE_REFERENCE_NOW).getTime() + n * DIA).toISOString().slice(0, 10);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIXTURE_REFERENCE_NOW));
  resetMockStore();
});

afterEach(() => {
  vi.useRealTimers();
  resetMockStore();
});

describe('mock-tablero-store', () => {
  it('edita el contexto de voz y conserva el teléfono de pruebas y la decisión de criticidad', () => {
    const before = evaluateMockOrder(
      getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
      getCallRules(),
    );
    const result = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
      contactoNombre: 'Francisca Rojas',
      clientName: 'Empresa simulada',
      courseName: 'Excel básico',
    });
    expect(result.ok).toBe(true);
    const after = evaluateMockOrder(result.order!, getCallRules());
    expect(after.regla).toEqual(before.regla);
    expect(after.variablesAgente).toMatchObject({
      nombre_interlocutor: 'Francisca Rojas',
      nombre_cliente: 'Empresa simulada',
      nombre_curso: 'Excel básico',
    });
    expect(
      toTableroRecords()
        .filter((r) => r.order_number === NORMAL.orderNumber)
        .every(
          (r) => r.contacto_nombre === 'Francisca Rojas' && r.phone_test_only === MOCK_TEST_PHONE,
        ),
    ).toBe(true);
  });

  it('rechaza campos ajenos y plantillas en los nombres sin modificar la OC', () => {
    const before = getMockOrder(NORMAL.clientId, NORMAL.orderNumber);
    expect(
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { contactoNombre: '{{otro_contacto}}' })
        .ok,
    ).toBe(false);
    expect(
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { phone: '+56900000000' } as never).ok,
    ).toBe(false);
    expect(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)).toEqual(before);
  });
  it('siembra las OCs del fixture', () => {
    expect(listMockOrders().length).toBeGreaterThan(10);
    expect(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)).not.toBeNull();
  });

  it('las llamadas automaticas arrancan APAGADAS en las DOS secciones de voz', () => {
    expect(isAutoCallEnabled('A_RIESGO_CONEXION')).toBe(false);
    expect(isAutoCallEnabled('B_RIESGO_DJ')).toBe(false);
  });

  it('cada seccion tiene su propio interruptor: encender una no enciende la otra', () => {
    // Es la garantia del pedido: probar riesgo de conexion no puede dejar armadas las llamadas
    // de declaraciones juradas, ni al reves. Son dos conversaciones distintas.
    setAutoCallEnabled('A_RIESGO_CONEXION', true);
    expect(isAutoCallEnabled('A_RIESGO_CONEXION')).toBe(true);
    expect(isAutoCallEnabled('B_RIESGO_DJ')).toBe(false);

    setAutoCallEnabled('B_RIESGO_DJ', true);
    setAutoCallEnabled('A_RIESGO_CONEXION', false);
    expect(isAutoCallEnabled('A_RIESGO_CONEXION')).toBe(false);
    expect(isAutoCallEnabled('B_RIESGO_DJ')).toBe(true);
  });

  it('toda OC arranca en el numero de pruebas por defecto', () => {
    const records = toTableroRecords();
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.phone_test_only === MOCK_TEST_PHONE)).toBe(true);
    expect(new Set(records.map((r) => r.phone_test_only)).size).toBe(1);
  });

  /**
   * El telefono se elige POR OC entre los numeros de la etapa de pruebas. La lista es cerrada:
   * el Mock no puede apuntar a un numero que `runGuardrails` despues rechazaria.
   */
  describe('telefono por OC', () => {
    const SEGUNDO = MOCK_TEST_PHONES[1]!;

    it('asignar el segundo numero cambia solo los registros de esa OC', () => {
      const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { phone: SEGUNDO });
      expect(r.ok).toBe(true);
      expect(r.order?.phone).toBe(SEGUNDO);

      const records = toTableroRecords();
      const deLaOC = records.filter((x) => x.order_number === NORMAL.orderNumber);
      expect(deLaOC.length).toBeGreaterThan(0);
      expect(deLaOC.every((x) => x.phone_test_only === SEGUNDO)).toBe(true);
      // Las demas OCs no se movieron.
      expect(
        records
          .filter((x) => x.order_number !== NORMAL.orderNumber)
          .every((x) => x.phone_test_only === MOCK_TEST_PHONE),
      ).toBe(true);
    });

    it('rechaza cualquier numero fuera de la lista de pruebas, sin tocar la OC', () => {
      const antes = getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!;
      for (const invalido of ['+56911112222', '', 'no-es-un-numero', '56956194817']) {
        const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { phone: invalido });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/numeros de pruebas/);
      }
      expect(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)).toEqual(antes);
    });

    it('cambiar el telefono no toca la criticidad ni las variables del agente', () => {
      const antes = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { phone: SEGUNDO });
      const despues = evaluateMockOrder(r.order!, getCallRules());
      expect(despues.nivel).toBe(antes.nivel);
      expect(despues.regla).toEqual(antes.regla);
      // El telefono NO es una variable del agente: el contrato conversacional no cambia.
      expect(despues.variablesAgente).toEqual(antes.variablesAgente);
      expect(Object.values(despues.variablesAgente)).not.toContain(SEGUNDO);
    });

    it('el reset devuelve todas las OCs al numero por defecto', () => {
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { phone: SEGUNDO });
      resetMockStore();
      expect(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)?.phone).toBe(MOCK_TEST_PHONE);
    });
  });

  it('recalcula semana, % y nivel al guardar', () => {
    const antes = evaluateMockOrder(
      getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
      getCallRules(),
    );
    expect(antes.nivel).toBe('NORMAL');

    // Semana 3 (2/3 del curso transcurrido) y cero conexiones -> CRITICO.
    const hoy = new Date(FIXTURE_REFERENCE_NOW);
    const dia = 24 * 60 * 60 * 1000;
    const init = new Date(hoy.getTime() - 20 * dia).toISOString().slice(0, 10);
    const end = new Date(hoy.getTime() + 10 * dia).toISOString().slice(0, 10);

    const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
      initCourse: init,
      endCourse: end,
      conexiones: 0,
    });
    expect(r.ok).toBe(true);

    const despues = evaluateMockOrder(
      getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
      getCallRules(),
    );
    expect(despues.semana).toBe(3);
    expect(despues.pctConexion).toBe(0);
    expect(despues.nivel).toBe('CRITICO');
    expect(despues.regla.dispara).toBe(true);
  });

  it('los inscritos activos salen de CONTAR registros, no de un campo', () => {
    updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { inscritos: 7, conexiones: 3 });
    const e = evaluateMockOrder(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!, getCallRules());
    expect(e.inscritosActivos).toBe(7);
    expect(e.conectados).toBe(3);
    expect(e.pctConexion).toBeCloseTo(42.86, 1);
  });

  it('un estado DEAD hace desaparecer la OC del Semaforo: sin nivel, no en seccion A', () => {
    updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { orderStatus: 'FACTURADA' });
    const e = evaluateMockOrder(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!, getCallRules());
    expect(e.nivel).toBeNull();
    expect(e.enSeccionA).toBe(false);
    expect(e.motivoFueraDeSeccionA).toBe('estado_muerto');
    expect(e.regla.dispara).toBe(false);
  });

  it('un estado que deja a los alumnos inactivos deja la OC en 0 inscritos y fuera de seccion A', () => {
    updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { orderStatus: 'REVISAR' });
    const e = evaluateMockOrder(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!, getCallRules());
    expect(e.inscritosActivos).toBe(0);
    expect(e.enSeccionA).toBe(false);
  });

  it('nunca dispara una OC fuera de la seccion A, por laxos que sean los umbrales', () => {
    const hoy = new Date(FIXTURE_REFERENCE_NOW);
    const dia = 24 * 60 * 60 * 1000;
    // Curso ya terminado: eso es seccion B (Riesgo DJ), no A. No se llama por conexion.
    updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
      initCourse: new Date(hoy.getTime() - 40 * dia).toISOString().slice(0, 10),
      endCourse: new Date(hoy.getTime() - 5 * dia).toISOString().slice(0, 10),
      conexiones: 0,
    });
    const e = evaluateMockOrder(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!, getCallRules());
    expect(e.enSeccionA).toBe(false);
    // El motivo es `no_en_ejecucion`, no `curso_terminado`: la promocion por fechas corre ANTES
    // del gate y ya movio la OC a OBTENIENDO DJ. Por eso `curso_terminado` sale 0 tambien
    // contra el dato real de prod — es un gate defensivo que la promocion normalmente adelanta.
    expect(e.motivoFueraDeSeccionA).toBe('no_en_ejecucion');
    expect(e.regla.dispara).toBe(false);
  });

  describe('validacion (vive en el backend, nunca en el front)', () => {
    it('rechaza conexiones > inscritos', () => {
      const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
        inscritos: 3,
        conexiones: 5,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/conexiones no puede superar/);
    });

    it('rechaza fechas invalidas y termino anterior al inicio', () => {
      expect(updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { initCourse: 'ayer' }).ok).toBe(
        false,
      );
      expect(
        updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
          initCourse: '2026-09-10',
          endCourse: '2026-09-01',
        }).ok,
      ).toBe(false);
    });

    it('rechaza inscritos negativos o no enteros', () => {
      expect(updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { inscritos: -1 }).ok).toBe(
        false,
      );
      expect(updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { inscritos: 2.5 }).ok).toBe(
        false,
      );
    });

    it('rechaza un estado que el Semaforo no reconoce', () => {
      const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { orderStatus: 'INVENTADO' });
      expect(r.ok).toBe(false);
    });

    it('acepta todos los estados del editor que las fechas no contradicen', () => {
      const coherentes = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      ).estadosCoherentes;
      for (const estado of ESTADOS_EDITABLES) {
        expect(
          updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { orderStatus: estado }).ok,
        ).toBe(coherentes.includes(estado));
      }
    });

    it('rechaza una OC inexistente', () => {
      expect(updateMockOrder('nope', 'nope', { inscritos: 1 }).ok).toBe(false);
    });
  });

  /**
   * El estado NO es un campo libre: `promoteOrderStatus` lo deriva de las fechas. Sin esta
   * regla se podia guardar "NO INICIADA" con el inicio ya pasado; la UI mostraba NO INICIADA y
   * el Semaforo seguia clasificando la OC como CURSO EN OPERACIÓN, CRITICA y llamable.
   */
  describe('el ESTADO OC lo mandan las fechas', () => {
    it('no deja marcar NO INICIADA un curso que ya arranco, y no toca la OC', () => {
      const antes = getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!;
      const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
        orderStatus: 'NO INICIADA',
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/NO INICIADA/);
      // El mensaje nombra la fecha culpable y el estado que el Semaforo si va a usar.
      expect(r.error).toContain(antes.initCourse);
      expect(r.error).toMatch(/CURSO EN OPERACIÓN/);
      expect(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)).toEqual(antes);
    });

    it('la OC rechazada sigue exactamente como estaba para el Semaforo', () => {
      const antes = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { orderStatus: 'NO INICIADA' });
      const despues = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      expect(despues.nivel).toBe(antes.nivel);
      expect(despues.enSeccionA).toBe(antes.enSeccionA);
    });

    it('no deja marcar OBTENIENDO DJ un curso que no termino', () => {
      expect(
        updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { orderStatus: 'OBTENIENDO DJ' }).ok,
      ).toBe(false);
    });

    it('acepta NO INICIADA si el mismo guardado manda el inicio al futuro', () => {
      const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
        orderStatus: 'NO INICIADA',
        initCourse: enDias(5),
      });
      expect(r.ok).toBe(true);
      expect(r.order?.orderStatus).toBe('NO INICIADA');
      // Y ahora si sale de la seccion A de verdad, no solo en la pantalla.
      expect(evaluateMockOrder(r.order!, getCallRules()).enSeccionA).toBe(false);
    });

    it('los estados que pone una persona no dependen de las fechas', () => {
      for (const estado of ['REVISAR', 'ESPERA OC FINAL', 'ENVIADA A FACTURAR', 'FACTURADA']) {
        expect(
          updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { orderStatus: estado }).ok,
        ).toBe(true);
      }
      // El vacio tambien: es "sin estado", no una afirmacion sobre las fechas.
      expect(updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { orderStatus: '' }).ok).toBe(
        true,
      );
    });

    it('mover las fechas corrige el estado y lo avisa, en vez de rechazar la edicion', () => {
      const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { initCourse: enDias(5) });
      expect(r.ok).toBe(true);
      expect(r.order?.orderStatus).toBe('NO INICIADA');
      expect(r.aviso).toMatch(/NO INICIADA/);
    });

    it('una edicion cualquiera repara una OC cuyo estado ya no cuadra con sus fechas', () => {
      // Se deja NO INICIADA por el camino legitimo (inicio futuro)...
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
        orderStatus: 'NO INICIADA',
        initCourse: enDias(5),
      });
      // ...y despues el inicio vuelve al pasado: el estado sigue a la fecha.
      const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { initCourse: enDias(-5) });
      expect(r.ok).toBe(true);
      expect(r.order?.orderStatus).toBe('CURSO EN OPERACIÓN');
      expect(r.aviso).toBeDefined();
    });

    it('una edicion coherente no inventa avisos', () => {
      const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { conexiones: 1 });
      expect(r.ok).toBe(true);
      expect(r.aviso).toBeUndefined();
    });

    it('expone al front los estados que cuadran con las fechas, sin que el front sepa la regla', () => {
      const e = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      // Curso en marcha: de los tres que dependen de fechas sobrevive uno solo.
      expect(e.estadosCoherentes).toContain('CURSO EN OPERACIÓN');
      expect(e.estadosCoherentes).not.toContain('NO INICIADA');
      expect(e.estadosCoherentes).not.toContain('OBTENIENDO DJ');
      // Los manuales y el vacio siguen ofreciendose.
      expect(e.estadosCoherentes).toEqual(expect.arrayContaining(['', 'REVISAR', 'FACTURADA']));
    });
  });

  // -------------------------------------------------------------------------
  // Secciones B y C: se ven y se editan, pero NO llaman
  // -------------------------------------------------------------------------

  describe('seccion B - Riesgo DJ', () => {
    /** Deja la OC como el Semaforo la veria en la seccion B: cerrada hace 10 dias, DJ incompleta. */
    function cerrarCurso(djs = 0, conexiones = 8) {
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
        initCourse: enDias(-40),
        endCourse: enDias(-10),
      });
      return updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { conexiones, djs });
    }

    it('clasifica por dias desde el cierre y porcentaje de DJ sobre los CONECTADOS', () => {
      cerrarCurso(2, 8);
      const e = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      expect(e.dj.enSeccion).toBe(true);
      expect(e.dj.nivel).toBe('CRITICO');
      expect(e.dj.conDj).toBe(2);
      // 8 conectados de 20 inscritos: el denominador de la DJ son los 8, no los 20.
      expect(e.dj.base).toBe(8);
      expect(e.dj.pctDj).toBe(25);
      expect(e.dj.diasDesdeCierre).toBeGreaterThan(7);
    });

    it('sale de la seccion cuando se completa la DJ', () => {
      cerrarCurso(8, 8);
      const e = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      expect(e.dj.enSeccion).toBe(false);
      expect(e.dj.motivoFuera).toBe('dj_completa');
    });

    it('un curso que sigue corriendo no es un riesgo de DJ', () => {
      const e = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      expect(e.dj.enSeccion).toBe(false);
      expect(e.dj.motivoFuera).toBe('curso_no_terminado');
    });

    it('una DJ critica habilita seguimiento de declaraciones', () => {
      // Es la garantia que pide el negocio: la DJ se resuelve con el OTIC, no por telefono.
      cerrarCurso(0, 8);
      const e = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      expect(e.dj.nivel).toBe('CRITICO');
      expect(e.regla.dispara).toBe(true);
      expect(e.enSeccionA).toBe(false);
    });

    it('editar solo la DJ no mueve nada de la seccion A', () => {
      const antes = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { djs: 1 });
      const despues = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      expect(despues.nivel).toBe(antes.nivel);
      expect(despues.pctConexion).toBe(antes.pctConexion);
      expect(despues.enSeccionA).toBe(antes.enSeccionA);
      expect(despues.regla).toEqual(antes.regla);
    });

    it('rechaza mas DJs que conectados', () => {
      const r = updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { conexiones: 3, djs: 5 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/djs no puede superar conexiones/);
      expect(updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { djs: -1 }).ok).toBe(false);
      expect(updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { djs: 1.5 }).ok).toBe(false);
    });
  });

  // Fuente: ../semaforo-reglas-negocio/StatusCursosPage.tsx:83-87,582-657,1245.
  it.each([
    [3, false, 'NORMAL'],
    [4, true, 'ALERTA'],
    [7, true, 'ALERTA'],
    [8, true, 'CRITICO'],
  ])(
    'B a %s días coincide con la fuente, aunque se cambie la regla de llamada',
    (dias, visible, nivel) => {
      vi.setSystemTime(
        new Date(new Date(FIXTURE_REFERENCE_NOW).toISOString().slice(0, 10) + 'T00:00:00Z'),
      );
      expect(
        updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
          initCourse: enDias(-40),
          endCourse: enDias(-(dias as number)),
          conexiones: 8,
          djs: 2,
        }).ok,
      ).toBe(true);
      const order = getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!;
      const rules = getCallRules();
      const before = evaluateMockOrder(order, rules);
      rules.dj = { llamarSiDiasMayorA: 0, nivelesQueLlaman: ['NORMAL', 'ALERTA', 'CRITICO'] };
      const after = evaluateMockOrder(order, rules);
      expect(after.dj).toEqual(before.dj);
      expect(after.dj).toMatchObject({ enSeccion: visible, nivel, base: 8, conDj: 2, pctDj: 25 });
      expect(after.regla.dispara).toBe(visible);
    },
  );
  it.each([
    [3, false, 'NORMAL'],
    [4, true, 'NORMAL'],
    [15, true, 'NORMAL'],
    [16, true, 'ALERTA'],
    [30, true, 'ALERTA'],
    [31, true, 'CRITICO'],
  ])('C permite EN RECTIFICACION y respeta el corte de %s días', (dias, visible, nivel) => {
    vi.setSystemTime(
      new Date(new Date(FIXTURE_REFERENCE_NOW).toISOString().slice(0, 10) + 'T00:00:00Z'),
    );
    expect(
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
        orderStatus: 'EN RECTIFICACION',
        ultimaActualizacion: enDias(-(dias as number)),
      }).ok,
    ).toBe(true);
    const e = evaluateMockOrder(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!, getCallRules());
    expect(e.rectificacion).toMatchObject({ diasPendiente: dias, enSeccion: visible, nivel });
    expect(e.regla.dispara).toBe(false);
  });
  it.each(['OCF SOLICITADA', 'OC RECIBIDA'])(
    'conserva el estado manual %s y no inventa entrada en C',
    (orderStatus) => {
      expect(
        updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
          orderStatus,
          ultimaActualizacion: enDias(-40),
        }).ok,
      ).toBe(true);
      const e = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      expect(e.order.orderStatus).toBe(orderStatus);
      expect(e.enSeccionA).toBe(false);
      expect(e.rectificacion.enSeccion).toBe(false);
    },
  );

  describe('seccion C - Rectificacion', () => {
    it('clasifica por dias desde la ultima actualizacion de la OC', () => {
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
        orderStatus: 'ESPERA OC FINAL',
        ultimaActualizacion: enDias(-40),
      });
      const e = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      expect(e.rectificacion.enSeccion).toBe(true);
      expect(e.rectificacion.nivel).toBe('CRITICO');
      // 41 y no 40: la fecha se ancla a medianoche y el Semaforo redondea hacia arriba
      // (`Math.ceil`, `StatusCursosPage.tsx:646`). Se replica el borde, no se corrige.
      expect(e.rectificacion.diasPendiente).toBe(41);
    });

    it('el estado manda: sin ESPERA/RECTIFICACION la OC no entra, por vieja que sea', () => {
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { ultimaActualizacion: enDias(-90) });
      const e = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      expect(e.rectificacion.enSeccion).toBe(false);
      expect(e.rectificacion.motivoFuera).toBe('estado_no_espera_oc_final');
      expect(e.rectificacion.diasPendiente).toBe(91);
    });

    it('una rectificacion critica NO habilita ninguna llamada', () => {
      updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
        orderStatus: 'ESPERA OC FINAL',
        ultimaActualizacion: enDias(-40),
        conexiones: 0,
      });
      const e = evaluateMockOrder(
        getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!,
        getCallRules(),
      );
      expect(e.rectificacion.nivel).toBe('CRITICO');
      expect(e.regla.dispara).toBe(false);
    });

    it('rechaza una fecha de actualizacion invalida', () => {
      expect(
        updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { ultimaActualizacion: 'ayer' }).ok,
      ).toBe(false);
    });
  });

  it('una OC descartada por estado DEAD no tiene nivel en ninguna de las tres secciones', () => {
    updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { orderStatus: 'FACTURADA' });
    const e = evaluateMockOrder(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!, getCallRules());
    expect(e.nivel).toBeNull();
    expect(e.dj.nivel).toBeNull();
    expect(e.rectificacion.nivel).toBeNull();
    expect(e.dj.motivoFuera).toBe('estado_muerto');
    expect(e.rectificacion.motivoFuera).toBe('estado_muerto');
  });

  it('las tres secciones son independientes: una OC puede estar en una y no en las otras', () => {
    // Cerrada hace 10 dias y en espera de OC Final: seccion B y C a la vez, A nunca.
    updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
      initCourse: enDias(-40),
      endCourse: enDias(-10),
    });
    updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, {
      orderStatus: 'ESPERA OC FINAL',
      ultimaActualizacion: enDias(-20),
      conexiones: 5,
      djs: 1,
    });
    const e = evaluateMockOrder(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)!, getCallRules());
    expect(e.enSeccionA).toBe(false);
    expect(e.dj.enSeccion).toBe(true);
    expect(e.rectificacion.enSeccion).toBe(true);
    expect(e.regla.dispara).toBe(true);
    expect(e.variablesAgente.motivo).toBe('riesgo_dj_critico');
  });

  it('reset devuelve datos, umbrales y toggle al estado inicial', () => {
    updateMockOrder(NORMAL.clientId, NORMAL.orderNumber, { inscritos: 1, conexiones: 0 });
    setAutoCallEnabled('A_RIESGO_CONEXION', true);
    setAutoCallEnabled('B_RIESGO_DJ', true);
    resetMockStore();
    expect(getMockOrder(NORMAL.clientId, NORMAL.orderNumber)?.inscritos).toBeGreaterThan(1);
    expect(isAutoCallEnabled('A_RIESGO_CONEXION')).toBe(false);
    expect(isAutoCallEnabled('B_RIESGO_DJ')).toBe(false);
    expect(evaluateAllMockOrders().length).toBeGreaterThan(10);
  });
});
