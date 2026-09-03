/**
 * El test mas importante del front: **no se puede originar una llamada sin pasar por el modal
 * de confirmacion**. Con un plan de muy pocos minutos, un click accidental en el tablero no
 * puede terminar en una llamada.
 *
 * Tambien cubre que el boton quede deshabilitado con la razon VISIBLE cuando falta cuota, hay
 * kill switch o el numero no esta en la allowlist — y que el desplegable de numeros se pueble
 * solo con la allowlist (nunca input libre).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Disparador } from '../src/components/Disparador';
import { CURSO_CRITICO, CURSO_NORMAL, HEALTH_OK } from './fixtures';

/** Espia el `fetch` global: si se llama, alguien intento originar una llamada. */
function spyFetch() {
  const fetchSpy = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: 'dialing',
          followupId: 'followup-nuevo',
          conversationId: 'conv_mock_nuevo',
          cuota: { dateKey: '2026-09-03', usados: 2, limite: 5, restantes: 3 },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('Disparador — confirmacion obligatoria', () => {
  it('elegir curso y numero NO dispara nada: solo abre el modal', async () => {
    const fetchSpy = spyFetch();
    const user = userEvent.setup();
    render(<Disparador health={HEALTH_OK} cursos={[CURSO_CRITICO]} onDisparado={() => {}} />);

    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    await user.selectOptions(screen.getByLabelText(/numero/i), '+56900100141');

    // Elegir en los desplegables no puede originar nada.
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /disparar llamada/i }));

    // Se abrio el modal, pero TODAVIA no se llamo a la API.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cancelar el modal no dispara nada', async () => {
    const fetchSpy = spyFetch();
    const user = userEvent.setup();
    render(<Disparador health={HEALTH_OK} cursos={[CURSO_CRITICO]} onDisparado={() => {}} />);

    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    await user.selectOptions(screen.getByLabelText(/numero/i), '+56900100141');
    await user.click(screen.getByRole('button', { name: /disparar llamada/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancelar/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('recien al confirmar en el modal se hace UN POST /api/calls con Idempotency-Key', async () => {
    const fetchSpy = spyFetch();
    const onDisparado = vi.fn();
    const user = userEvent.setup();
    render(<Disparador health={HEALTH_OK} cursos={[CURSO_CRITICO]} onDisparado={onDisparado} />);

    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    await user.selectOptions(screen.getByLabelText(/numero/i), '+56900100141');
    await user.click(screen.getByRole('button', { name: /disparar llamada/i }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /confirmar/i }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain('/calls');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeTruthy();

    expect(JSON.parse(init.body as string)).toMatchObject({
      clientId: CURSO_CRITICO.clientId,
      orderNumber: CURSO_CRITICO.orderNumber,
      phone: '+56900100141',
    });

    // El modal se cierra y se avisa al contenedor para que refresque cuota/dashboard.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onDisparado).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/HTTP 201/)).toBeTruthy();
  });

  it('el modal muestra a quien se llama y con que variables antes de confirmar', async () => {
    spyFetch();
    const user = userEvent.setup();
    render(<Disparador health={HEALTH_OK} cursos={[CURSO_CRITICO]} onDisparado={() => {}} />);

    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    await user.selectOptions(screen.getByLabelText(/numero/i), '+56900100141');
    await user.click(screen.getByRole('button', { name: /disparar llamada/i }));

    const modal = within(screen.getByRole('dialog'));
    expect(modal.getByText(/TEST · Marcela Bravo/)).toBeTruthy();
    expect(modal.getByText('***0141')).toBeTruthy();
    expect(modal.getByText('orden_compra')).toBeTruthy();
    // Aparece dos veces: como la OC del curso y como el valor de `orden_compra`.
    expect(modal.getAllByText('TEST-9600')).toHaveLength(2);
    expect(modal.getByText(/Simulacion/)).toBeTruthy();
    // Nunca se muestra el numero completo.
    expect(modal.queryByText('+56900100141')).toBeNull();
  });
});

describe('Disparador — el boton se deshabilita con la razon visible', () => {
  const seleccionValida = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    await user.selectOptions(screen.getByLabelText(/numero/i), '+56900100141');
  };

  it('kill switch activo', async () => {
    const user = userEvent.setup();
    render(
      <Disparador
        health={{ ...HEALTH_OK, killSwitch: true }}
        cursos={[CURSO_CRITICO]}
        onDisparado={() => {}}
      />,
    );
    await seleccionValida(user);

    expect(screen.getByRole('button', { name: /disparar llamada/i })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/KILL_SWITCH esta activo/)).toBeTruthy();
  });

  it('cuota diaria agotada', async () => {
    const user = userEvent.setup();
    render(
      <Disparador
        health={{
          ...HEALTH_OK,
          cuota: { dateKey: '2026-09-03', usados: 5, limite: 5, restantes: 0 },
        }}
        cursos={[CURSO_CRITICO]}
        onDisparado={() => {}}
      />,
    );
    await seleccionValida(user);

    expect(screen.getByRole('button', { name: /disparar llamada/i })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Cuota diaria agotada: 5\/5/)).toBeTruthy();
  });

  it('allowlist vacia: no hay ningun numero para elegir', () => {
    render(
      <Disparador
        health={{ ...HEALTH_OK, allowlist: [] }}
        cursos={[CURSO_CRITICO]}
        onDisparado={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: /disparar llamada/i })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/ALLOWLIST_NUMBERS esta vacia/)).toBeTruthy();
    // El desplegable solo tiene el placeholder: nunca hay input libre de telefono.
    expect(within(screen.getByLabelText(/numero/i)).getAllByRole('option')).toHaveLength(1);
  });

  it('fuera de la ventana horaria', () => {
    render(
      <Disparador
        health={{
          ...HEALTH_OK,
          ventanaHoraria: { ...HEALTH_OK.ventanaHoraria, abiertaAhora: false },
        }}
        cursos={[CURSO_CRITICO]}
        onDisparado={() => {}}
      />,
    );
    expect(screen.getByText(/Fuera de la ventana horaria/)).toBeTruthy();
  });

  it('sin contacto con la API', () => {
    render(<Disparador health={null} cursos={[CURSO_CRITICO]} onDisparado={() => {}} />);
    expect(screen.getByRole('button', { name: /disparar llamada/i })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/No hay contacto con la API/)).toBeTruthy();
  });

  it('los cursos que no son CRITICO no aparecen como opcion', () => {
    render(
      <Disparador
        health={HEALTH_OK}
        cursos={[CURSO_CRITICO, CURSO_NORMAL]}
        onDisparado={() => {}}
      />,
    );
    const opciones = within(screen.getByLabelText(/curso/i)).getAllByRole('option');
    // placeholder + solo el CRITICO
    expect(opciones).toHaveLength(2);
    expect(opciones.map((o) => o.textContent).join(' ')).not.toContain('TEST-9104');
  });
});
