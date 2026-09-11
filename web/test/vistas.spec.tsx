/**
 * Tablero y Dashboard: lo que el operador tiene que poder ver y hacer sin disparar nada.
 * Ninguna de estas dos vistas puede originar una llamada — solo leen.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TableroMock } from '../src/components/TableroMock';
import { TableroOriginal } from '../src/components/TableroOriginal';
import { Dashboard } from '../src/components/Dashboard';
import { Banner } from '../src/components/Banner';
import {
  HEALTH_OK,
  TELEFONO_PRUEBAS,
  TELEFONO_PRUEBAS_2,
  LLAMADA_RESUELTA,
  cursoOriginal,
  cursoRectificacion,
  cursoRiesgoDj,
  mockOrden,
  mockTablero,
  tableroOriginal,
} from './fixtures';

// El historial independiente tiene sus propias pruebas y lecturas; acá se prueba FOLLOWUP.
vi.mock('../src/components/AgentHistory', () => ({ AgentHistory: () => null }));

const noop = () => {};
const noopAsync = async () => {};

/**
 * La misma OC vive en las tres secciones del Mock, asi que hay un boton Guardar por seccion.
 * El `aria-label` los distingue; el texto visible sigue siendo "Guardar" en las tres.
 */
const botonGuardar = (seccion = 'Riesgo Conexion', oc = 'TEST-9600') =>
  screen.getByRole('button', { name: `Guardar ${oc} · ${seccion}` }) as HTMLButtonElement;

/** Una de las tres secciones colapsables del Tablero Mock, por su nombre accesible. */
const seccionMock = (titulo: string) =>
  screen.getByLabelText(`Seccion ${titulo}`) as HTMLDetailsElement;

function renderMock(overrides = {}, handlers = {}) {
  return render(
    <TableroMock
      data={mockTablero(overrides)}
      cargando={false}
      error={null}
      onRecargar={noop}
      onGuardar={noopAsync}
      onToggleAutoCall={noop}
      onGuardarReglas={noop}
      onRestaurarReglas={noop}
      onReset={noop}
      {...handlers}
    />,
  );
}

describe('Tablero Mock', () => {
  it('permite preparar el contacto de voz y muestra las variables guardadas sin llamar', async () => {
    const user = userEvent.setup();
    const onGuardar = vi.fn(async () => {});
    renderMock({}, { onGuardar });
    await user.click(screen.getByText('Contexto del agente'));
    expect(screen.getByText('nombre_interlocutor')).toBeTruthy();
    expect(screen.getByText('Carolina Soto')).toBeTruthy();
    await user.clear(screen.getByLabelText('Contacto de TEST-9600'));
    await user.type(screen.getByLabelText('Contacto de TEST-9600'), 'Francisca Rojas');
    expect(screen.getByText(/Hay cambios sin guardar/)).toBeTruthy();
    expect(onGuardar).not.toHaveBeenCalled();
    await user.click(botonGuardar());
    expect(onGuardar).toHaveBeenCalledWith('client_test_demo', 'TEST-9600', {
      contactoNombre: 'Francisca Rojas',
    });
  });
  it('permite editar en la propia tabla solo los campos que el Semaforo usa para la criticidad', () => {
    renderMock();
    // Estado, fechas del curso, inscritos y conexiones. Nada mas: montos, RUT o DJ no
    // intervienen en la seccion A y no deben ser editables.
    expect(screen.getByLabelText(/Estado de TEST-9600/)).toBeTruthy();
    expect(screen.getByLabelText(/Inicio de TEST-9600/)).toBeTruthy();
    expect(screen.getByLabelText(/Termino de TEST-9600/)).toBeTruthy();
    expect(screen.getByLabelText(/Inscritos de TEST-9600/)).toBeTruthy();
    expect(screen.getByLabelText(/Conexiones de TEST-9600/)).toBeTruthy();
  });

  it('marca en el desplegable los estados que las fechas contradicen, sin decidirlo aca', () => {
    renderMock();
    const estado = screen.getByLabelText(/Estado de TEST-9600/) as HTMLSelectElement;
    const etiqueta = (valor: string) =>
      [...estado.options].find((o) => o.value === valor)!.textContent!;

    // `estadosCoherentes` viene del backend; el front solo lo refleja.
    expect(etiqueta('CURSO EN OPERACIÓN')).not.toMatch(/no cuadra/);
    expect(etiqueta('NO INICIADA')).toMatch(/no cuadra con las fechas/);
    // Se marcan pero NO se deshabilitan: un guardado puede mover estado y fechas a la vez.
    expect([...estado.options].every((o) => !o.disabled)).toBe(true);
  });

  it('deja elegir a que numero autorizado llama esta OC, y lo manda en el patch', async () => {
    const user = userEvent.setup();
    const onGuardar = vi.fn(async () => {});
    renderMock({}, { onGuardar });
    await user.click(screen.getByText('Contexto del agente'));

    const telefono = screen.getByLabelText('Telefono de TEST-9600') as HTMLSelectElement;
    // Las opciones las decide el backend (`telefonos`), no esta vista.
    expect([...telefono.options].map((o) => o.value)).toEqual([
      TELEFONO_PRUEBAS,
      TELEFONO_PRUEBAS_2,
    ]);
    expect(telefono.value).toBe(TELEFONO_PRUEBAS);

    await user.selectOptions(telefono, TELEFONO_PRUEBAS_2);
    await user.click(botonGuardar());
    expect(onGuardar).toHaveBeenCalledWith('client_test_demo', 'TEST-9600', {
      phone: TELEFONO_PRUEBAS_2,
    });
  });

  it('avisa si un numero autorizado esta bloqueado, sin esconder el otro', () => {
    renderMock({
      telefonos: [
        {
          valor: TELEFONO_PRUEBAS,
          masked: '***4817',
          doNotCall: true,
          ultimoContactoAt: null,
          enAllowlist: true,
        },
        {
          valor: TELEFONO_PRUEBAS_2,
          masked: '***6503',
          doNotCall: false,
          ultimoContactoAt: null,
          enAllowlist: false,
        },
      ],
    });
    // El aviso sale en el banner y ademas en la opcion del desplegable de cada fila.
    expect(screen.getAllByText(/do_not_call/).length).toBeGreaterThan(1);
    expect(screen.getByText(/no esta en/)).toBeTruthy();
    const telefono = screen.getByLabelText('Telefono de TEST-9600') as HTMLSelectElement;
    const etiqueta = (valor: string) =>
      [...telefono.options].find((o) => o.value === valor)!.textContent!;
    expect(etiqueta(TELEFONO_PRUEBAS)).toMatch(/do_not_call/);
    expect(etiqueta(TELEFONO_PRUEBAS_2)).toMatch(/fuera de la allowlist/);
  });

  it('muestra el aviso cuando el backend corrigio el estado por las fechas', () => {
    renderMock({ aviso: 'El estado paso de "NO INICIADA" a "CURSO EN OPERACIÓN".' });
    expect(screen.getByText(/El estado paso de/)).toBeTruthy();
  });

  it('muestra semana, % y nivel ya calculados por el backend', () => {
    renderMock();
    const fila = screen.getAllByText('TEST-9600')[0]!.closest('tr')!;
    expect(within(fila).getByText('CRITICO')).toBeTruthy();
    expect(within(fila).getAllByText(/0%/).length).toBeGreaterThan(0);
    expect(within(fila).getByText('0/10')).toBeTruthy();
  });

  it('el boton Guardar esta apagado sin cambios y manda solo los campos editados', async () => {
    const user = userEvent.setup();
    const onGuardar = vi.fn(async () => {});
    renderMock({}, { onGuardar });

    expect(botonGuardar().disabled).toBe(true);

    const conexiones = screen.getByLabelText(/Conexiones de TEST-9600/);
    await user.clear(conexiones);
    await user.type(conexiones, '5');
    expect(botonGuardar().disabled).toBe(false);

    await user.click(botonGuardar());
    expect(onGuardar).toHaveBeenCalledTimes(1);
    expect(onGuardar).toHaveBeenCalledWith('client_test_demo', 'TEST-9600', { conexiones: 5 });
  });

  it('escribir NO dispara nada: el guardado es explicito', async () => {
    const user = userEvent.setup();
    const onGuardar = vi.fn(async () => {});
    renderMock({}, { onGuardar });
    await user.clear(screen.getByLabelText(/Conexiones de TEST-9600/));
    await user.type(screen.getByLabelText(/Conexiones de TEST-9600/), '3');
    expect(onGuardar).not.toHaveBeenCalled();
  });

  it('el interruptor de llamadas automaticas arranca apagado y avisa', () => {
    renderMock();
    const toggle = screen.getByLabelText(/Llamadas automaticas del Mock/);
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/no se va a llamar a nadie/i)).toBeTruthy();
  });

  it('muestra siempre la configuracion activa de disparo al final del tablero', () => {
    renderMock();
    const panel = screen.getByLabelText('Configuracion de disparo de llamadas');
    expect(within(panel).getByText(/Semana 2/)).toBeTruthy();
    expect(within(panel).getAllByText('55%').length).toBeGreaterThan(0);
    // Sin cambios, "Restaurar valores del Semaforo" no tiene nada que restaurar.
    const restaurar = within(panel).getByRole('button', { name: /Restaurar valores del Semaforo/ });
    expect((restaurar as HTMLButtonElement).disabled).toBe(true);
  });

  it('marca los umbrales modificados frente a los del Semaforo', () => {
    renderMock({
      callRules: {
        llamarSiPctMenorA: { 1: null, 2: 90, 3: 80, 4: 90 },
        nivelesQueLlaman: ['CRITICO'],
      },
    });
    const panel = screen.getByLabelText('Configuracion de disparo de llamadas');
    expect(within(panel).getAllByText('modificado').length).toBe(1);
    const restaurar = within(panel).getByRole('button', { name: /Restaurar valores del Semaforo/ });
    expect((restaurar as HTMLButtonElement).disabled).toBe(false);
  });

  it('el modal edita los umbrales de LLAMADA, no la criticidad del Semaforo', async () => {
    const user = userEvent.setup();
    const onGuardarReglas = vi.fn();
    renderMock({}, { onGuardarReglas });

    await user.click(screen.getByRole('button', { name: 'Editar umbrales' }));
    const modal = screen.getByRole('dialog');
    const s2 = within(modal).getByLabelText(/Semana 2/);
    await user.clear(s2);
    await user.type(s2, '70');
    await user.click(within(modal).getByRole('button', { name: 'Guardar umbrales' }));

    expect(onGuardarReglas).toHaveBeenCalledTimes(1);
    expect(onGuardarReglas.mock.calls[0]?.[0]?.llamarSiPctMenorA[2]).toBe(70);
  });

  it('informa cuando una edicion no llamo por falta de transicion o por cooldown', () => {
    renderMock({ trigger: { disparo: false, motivo: 'sin_transicion', detalle: 'ya estaba' } });
    expect(screen.getByRole('status').textContent).toMatch(/sin transicion/i);
  });

  // -------------------------------------------------------------------------
  // Las otras dos secciones del Semaforo: se ven, se editan, no llaman
  // -------------------------------------------------------------------------

  it('trae las tres secciones del Semaforo, colapsables y con su propio recuento', () => {
    renderMock();
    // La de conexion arranca abierta; las otras dos, cerradas: llegar al tablero no puede
    // significar tres tablas largas de golpe.
    expect(seccionMock('A · Riesgo Conexion').open).toBe(true);
    expect(seccionMock('B · Riesgo DJ').open).toBe(false);
    expect(seccionMock('C · Rectificacion').open).toBe(false);
    expect(seccionMock('A · Riesgo Conexion').textContent).toMatch(/1 de 1 OCs en la seccion/);
  });

  it('solo la seccion de conexion ofrece llamar; las otras dos lo dicen explicitamente', () => {
    renderMock();
    expect(seccionMock('A · Riesgo Conexion').textContent).toMatch(
      /unica seccion que puede llamar/,
    );

    // La columna «¿Llama?» existe SOLO en la seccion de conexion.
    expect(
      within(seccionMock('A · Riesgo Conexion')).getByRole('columnheader', { name: '¿Llama?' }),
    ).toBeTruthy();

    for (const titulo of ['B · Riesgo DJ', 'C · Rectificacion']) {
      const seccion = seccionMock(titulo);
      expect(seccion.textContent).toMatch(/no origina llamadas/);
      expect(within(seccion).queryByRole('columnheader', { name: '¿Llama?' })).toBeNull();
    }
  });

  it('la seccion B clasifica por DJ y edita los campos de SU criterio', async () => {
    const user = userEvent.setup();
    const onGuardar = vi.fn(async () => {});
    renderMock(
      {
        ordenes: [
          mockOrden({
            dj: {
              conDj: 2,
              base: 8,
              pctDj: 25,
              diasDesdeCierre: 11,
              nivel: 'CRITICO',
              enSeccion: true,
              motivoFuera: null,
            },
          }),
        ],
      },
      { onGuardar },
    );
    const seccionB = seccionMock('B · Riesgo DJ');
    // Nivel, porcentaje y dias vienen calculados del backend.
    expect(within(seccionB).getByText('CRITICO')).toBeTruthy();
    expect(within(seccionB).getByText('2/8')).toBeTruthy();
    expect(within(seccionB).getByText('11')).toBeTruthy();

    // Los campos editables son los de la seccion B, y el patch solo lleva lo tocado.
    const conDj = within(seccionB).getByLabelText('Con DJ de TEST-9600');
    await user.clear(conDj);
    await user.type(conDj, '5');
    await user.click(botonGuardar('Riesgo DJ'));
    expect(onGuardar).toHaveBeenCalledWith('client_test_demo', 'TEST-9600', { djs: 5 });
  });

  it('la seccion C clasifica por dias esperando al OTIC y edita la ultima actualizacion', async () => {
    const user = userEvent.setup();
    const onGuardar = vi.fn(async () => {});
    renderMock(
      {
        ordenes: [
          mockOrden({
            rectificacion: {
              diasPendiente: 41,
              nivel: 'CRITICO',
              enSeccion: true,
              motivoFuera: null,
            },
          }),
        ],
      },
      { onGuardar },
    );
    const seccionC = seccionMock('C · Rectificacion');
    expect(within(seccionC).getByText('CRITICO')).toBeTruthy();
    expect(within(seccionC).getByText('41')).toBeTruthy();

    const fecha = within(seccionC).getByLabelText('Ultima actualizacion de TEST-9600');
    await user.clear(fecha);
    await user.type(fecha, '2026-08-01');
    await user.click(botonGuardar('Rectificacion'));
    expect(onGuardar).toHaveBeenCalledWith('client_test_demo', 'TEST-9600', {
      ultimaActualizacion: '2026-08-01',
    });
  });

  it('explica en palabras por que una OC queda fuera de cada seccion, sin decidirlo aca', () => {
    // El motivo llega como enum del backend; esta vista solo lo rotula.
    renderMock();
    const seccionB = seccionMock('B · Riesgo DJ');
    expect(within(seccionB).getByText(/El curso todavia no termina/)).toBeTruthy();
    const seccionC = seccionMock('C · Rectificacion');
    expect(
      within(seccionC).getByText(/El estado no es de espera de OC Final ni de rectificacion/),
    ).toBeTruthy();
  });

  it('muestra el contacto de cada OC enmascarado', () => {
    // Regla del micrositio: los numeros de TERCEROS van siempre enmascarados. El unico numero
    // que se muestra completo es la whitelist de pruebas, que es el del propio operador — misma
    // excepcion que ya aplica la allowlist en GET /api/health.
    renderMock();
    expect(screen.getByText(/\*\*\*4817/)).toBeTruthy();
    const panel = screen.getByLabelText('Configuracion de disparo de llamadas');
    expect(panel.textContent).toContain(TELEFONO_PRUEBAS);
  });
});

describe('Tablero Original', () => {
  function renderOriginal(data = tableroOriginal(), extra = {}) {
    return render(
      <TableroOriginal data={data} cargando={false} error={null} onRecargar={noop} {...extra} />,
    );
  }

  it('deja claro que es solo lectura y no ofrece ninguna forma de llamar', () => {
    renderOriginal();
    expect(screen.getByText(/Solo lectura/)).toBeTruthy();
    const botones = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(botones.some((t) => /llamar|disparar|guardar/i.test(t))).toBe(false);
  });

  it('muestra ultima actualizacion y contadores de la lectura', () => {
    renderOriginal();
    expect(screen.getByText(/Ultima actualizacion:/)).toBeTruthy();
    expect(screen.getByText(/5943 registros/)).toBeTruthy();
    expect(screen.getByText(/225 OCs agrupadas/)).toBeTruthy();
  });

  it('avisa cuanto tarda la primera lectura, para que no parezca colgada', () => {
    render(<TableroOriginal data={null} cargando={true} error={null} onRecargar={noop} />);
    expect(screen.getByRole('status').textContent).toMatch(/Leyendo tablero-api/);
    expect(screen.getByRole('status').textContent).toMatch(/20-25 s/);
  });

  it('avisa cuando los datos vienen de la cache del backend', () => {
    renderOriginal({ ...tableroOriginal(), desdeCache: true });
    expect(screen.getByText(/desde cache/)).toBeTruthy();
  });

  it('sin datos y sin cargar, invita a recargar en vez de quedar en blanco', () => {
    render(<TableroOriginal data={null} cargando={false} error={null} onRecargar={noop} />);
    // Una invitacion por seccion: las tres estan abiertas y las tres estan vacias.
    expect(screen.getAllByText(/apreta Recargar/)).toHaveLength(3);
  });

  it('muestra el error si la lectura falla', () => {
    render(
      <TableroOriginal
        data={null}
        cargando={false}
        error={'tablero-api respondio 502'}
        onRecargar={noop}
      />,
    );
    expect(screen.getByText(/respondio 502/)).toBeTruthy();
  });

  it('avisa cuando la lectura vino truncada', () => {
    const base = tableroOriginal();
    renderOriginal({ ...base, stats: { ...base.stats, truncado: true } });
    expect(screen.getByText(/LECTURA TRUNCADA/)).toBeTruthy();
  });

  it('por defecto muestra la misma seleccion que el Semaforo: oculta NORMAL', () => {
    renderOriginal(
      tableroOriginal({
        cursos: [
          cursoOriginal(),
          cursoOriginal({
            orderNumber: '9999999',
            nivel: 'NORMAL',
            visibleEnSemaforo: false,
          }),
        ],
      }),
    );
    expect(screen.getByText('2142332')).toBeTruthy();
    expect(screen.queryByText('9999999')).toBeNull();
  });

  it('recarga solo cuando se aprieta el boton (no hay polling)', async () => {
    const user = userEvent.setup();
    const onRecargar = vi.fn();
    renderOriginal(tableroOriginal(), { onRecargar });
    expect(onRecargar).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Recargar' }));
    expect(onRecargar).toHaveBeenCalledTimes(1);
  });

  it('muestra las tres secciones del Semaforo, cada una con su criterio', () => {
    renderOriginal();
    expect(screen.getByRole('button', { name: /A · Riesgo Conexion/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /B · Riesgo DJ/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /C · Rectificacion/ })).toBeTruthy();
  });

  it('pinta las filas de riesgo DJ con su propia escala (dias cerrado, no % de conexion)', () => {
    renderOriginal();
    expect(screen.getByText('3311002')).toBeTruthy();
    expect(screen.getByText('3/10 conectados')).toBeTruthy();
  });

  it('pinta las filas de rectificacion con el OTIC y los dias esperando', () => {
    renderOriginal();
    expect(screen.getByText('8741939')).toBeTruthy();
    expect(screen.getByText('ALIANZA PYME')).toBeTruthy();
  });

  it('colapsa y vuelve a abrir una seccion sin tocar las otras', async () => {
    const user = userEvent.setup();
    renderOriginal();
    const encabezadoDj = screen.getByRole('button', { name: /B · Riesgo DJ/ });
    expect(encabezadoDj.getAttribute('aria-expanded')).toBe('true');

    await user.click(encabezadoDj);
    expect(encabezadoDj.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('3311002')).toBeNull();
    // La seccion A sigue abierta: las vinetas son independientes.
    expect(screen.getByText('2142332')).toBeTruthy();

    await user.click(encabezadoDj);
    expect(screen.getByText('3311002')).toBeTruthy();
  });

  it('el filtro por urgencia se aplica a las tres secciones', async () => {
    const user = userEvent.setup();
    renderOriginal(
      tableroOriginal({
        riesgoDj: [cursoRiesgoDj({ nivel: 'ALERTA' })],
        rectificacion: [cursoRectificacion({ nivel: 'ALERTA' })],
      }),
    );
    await user.selectOptions(screen.getByRole('combobox'), 'CRITICO');
    // La OC de conexion es CRITICO y se queda; las de B y C son ALERTA y se van.
    expect(screen.getByText('2142332')).toBeTruthy();
    expect(screen.queryByText('3311002')).toBeNull();
    expect(screen.queryByText('8741939')).toBeNull();
  });
});

describe('Dashboard', () => {
  it('muestra estado, duracion y resultado clasificado', () => {
    render(<Dashboard llamadas={[LLAMADA_RESUELTA]} cargando={false} onRefrescar={() => {}} />);

    expect(screen.getByText('RESUELTO')).toBeTruthy();
    expect(screen.getByText('1m 35s')).toBeTruthy();
    expect(screen.getByText('resolved')).toBeTruthy();
    expect(screen.getByText('manual')).toBeTruthy();
    expect(screen.getByText('tomas.goas@umine.com')).toBeTruthy();
  });

  it('la fila expandible pide el detalle recien al abrirse y muestra la transcripcion', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            followup: {
              followupId: 'followup-1',
              estado: 'RESUELTO',
              motivo: 'riesgo_conexion_critico',
              prioridad: 'ALTA',
              origen: 'manual',
              requestedBy: 'tomas.goas@umine.com',
              orderNumber: 'TEST-9600',
              courseName: 'CURSO DUMMY',
              telefonoMasked: '***0141',
              intentos: 0,
              nextAttemptAt: null,
              createdAt: '2026-09-03T15:00:00.000Z',
              updatedAt: '2026-09-03T15:01:00.000Z',
              contexto: {},
            },
            llamadas: [
              {
                conversationId: 'conv_mock_1',
                callSid: 'CA_1',
                status: 'done',
                outcome: 'resolved',
                durationSeconds: 95,
                endedAt: '2026-09-03T15:01:00.000Z',
                camposExtraidos: { motivo_no_conexion: 'olvido_conectarse' },
                evaluacion: {},
                transcriptSummary: 'Se compromete a conectarse manana.',
                transcript: [
                  { role: 'agent', message: 'Le llamo de Umine por el curso SENCE.' },
                  { role: 'user', message: 'Me conecto manana sin falta.' },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const user = userEvent.setup();
    render(<Dashboard llamadas={[LLAMADA_RESUELTA]} cargando={false} onRefrescar={() => {}} />);

    // Con la fila cerrada no se pide nada.
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /ver/i }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Le llamo de Umine por el curso SENCE.')).toBeTruthy();
    expect(screen.getByText('Se compromete a conectarse manana.')).toBeTruthy();
    expect(screen.getByText('olvido_conectarse')).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it('el boton Sincronizar trae los resultados por API y no necesita confirmacion', async () => {
    // A diferencia del Disparador, sincronizar NO origina llamadas: el backend solo hace GET
    // contra ElevenLabs. Por eso no pasa por el modal de confirmacion obligatorio.
    const fetchSpy = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            total: 4,
            registradas: 2,
            yaRegistradas: 1,
            noFinales: 0,
            noAtribuibles: 1,
            errores: 0,
            items: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const onRefrescar = vi.fn();

    const user = userEvent.setup();
    render(<Dashboard llamadas={[LLAMADA_RESUELTA]} cargando={false} onRefrescar={onRefrescar} />);
    await user.click(screen.getByRole('button', { name: 'Sincronizar' }));

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/calls/sync');
    expect(init?.method).toBe('POST');
    // Al terminar, refresca la lista para que el resultado nuevo aparezca sin tocar nada mas.
    expect(onRefrescar).toHaveBeenCalled();
    // El resumen dice cuantos resultados nuevos entraron y cuantas conversaciones se dejaron
    // sin tocar por no ser atribuibles.
    expect(await screen.findByText(/resultado\(s\) nuevo\(s\)/)).toBeTruthy();
    expect(screen.getByText(/1 no atribuibles/)).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it('reabrir una fila vuelve a pedir el detalle en vez de mostrar uno cacheado', async () => {
    // Si se abre durante DIALING, la primera respuesta no trae transcripcion. Antes quedaba
    // cacheada por followupId y no habia forma de ver la buena sin recargar la pagina.
    const respuestas = [
      { llamadas: [] as unknown[] },
      {
        llamadas: [
          {
            conversationId: 'conv_1',
            callSid: null,
            status: 'done',
            outcome: 'resolved',
            durationSeconds: 95,
            startedAt: null,
            endedAt: null,
            camposExtraidos: {},
            camposExtraidosDetalle: {},
            evaluacion: {},
            cost: null,
            terminationReason: null,
            fuente: 'sync',
            transcriptSummary: 'Resumen que llego despues.',
            transcript: [],
          },
        ],
      },
    ];
    let llamada = 0;
    const fetchSpy = vi.fn(async () => {
      const cuerpo = respuestas[Math.min(llamada++, respuestas.length - 1)];
      return new Response(
        JSON.stringify({
          followup: {
            followupId: 'followup-1',
            estado: 'RESUELTO',
            motivo: 'riesgo_conexion_critico',
            prioridad: 'ALTA',
            origen: 'manual',
            requestedBy: null,
            orderNumber: 'TEST-9600',
            courseName: 'CURSO DUMMY',
            telefonoMasked: '***0141',
            intentos: 0,
            nextAttemptAt: null,
            createdAt: '2026-09-03T15:00:00.000Z',
            updatedAt: '2026-09-03T15:01:00.000Z',
            contexto: {},
          },
          ...cuerpo,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const user = userEvent.setup();
    render(<Dashboard llamadas={[LLAMADA_RESUELTA]} cargando={false} onRefrescar={() => {}} />);

    await user.click(screen.getByRole('button', { name: /ver/i }));
    expect(await screen.findByText(/Sin resultado todavia/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /ocultar/i }));
    await user.click(screen.getByRole('button', { name: /ver/i }));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Resumen que llego despues.')).toBeTruthy();

    vi.unstubAllGlobals();
  });
});

describe('Banner de modo', () => {
  it('en modo mock avisa que es simulacion', () => {
    render(<Banner health={HEALTH_OK} />);
    expect(screen.getByText(/MOCK_PROVIDERS=true — SIMULACION/)).toBeTruthy();
    expect(screen.getByText(/disparo automatico off \(manual\)/)).toBeTruthy();
  });

  it('con proveedores reales avisa que se consumen minutos', () => {
    render(<Banner health={{ ...HEALTH_OK, mockProviders: false }} />);
    expect(screen.getByText(/LLAMADAS REALES/)).toBeTruthy();
  });

  it('sin API avisa que no se sabe el modo y que no se disparen llamadas', () => {
    render(<Banner health={null} />);
    expect(screen.getByText(/No dispares llamadas/)).toBeTruthy();
  });
});
