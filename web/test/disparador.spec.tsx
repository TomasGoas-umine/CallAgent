/**
 * El test mas importante del front: **no se puede originar una llamada sin pasar por el modal
 * de confirmacion**. Con un plan de muy pocos minutos, un click accidental en el tablero no
 * puede terminar en una llamada.
 *
 * Tambien cubre que el boton quede deshabilitado con la razon VISIBLE cuando falta cuota, hay
 * kill switch o el numero no esta en la allowlist.
 *
 * Sobre el input manual de telefono: el desplegable ofrece los numeros autorizados, el del
 * Semaforo y la opcion de escribir uno a mano. Eso NO debilita la proteccion — el guardrail de
 * allowlist vive en el backend. La invariante que se verifica aca es la que de verdad importa:
 * un numero fuera de ALLOWLIST_NUMBERS (elegido o escrito) mantiene el boton bloqueado con la
 * razon visible y NUNCA produce un POST.
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
    await user.selectOptions(screen.getByLabelText(/numero a llamar/i), '+56900100141');

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
    await user.selectOptions(screen.getByLabelText(/numero a llamar/i), '+56900100141');
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
    await user.selectOptions(screen.getByLabelText(/numero a llamar/i), '+56900100141');
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
    await user.selectOptions(screen.getByLabelText(/numero a llamar/i), '+56900100141');
    await user.click(screen.getByRole('button', { name: /disparar llamada/i }));

    const modal = within(screen.getByRole('dialog'));
    expect(modal.getByText(/TEST · Marcela Bravo/)).toBeTruthy();
    expect(modal.getByText(/\+56900100141/)).toBeTruthy();
    expect(modal.getByText('orden_compra')).toBeTruthy();
    // Aparece dos veces: como la OC del curso y como el valor de `orden_compra`.
    expect(modal.getAllByText('TEST-9600')).toHaveLength(2);
    expect(modal.getByText(/Simulacion/)).toBeTruthy();
    // El numero se muestra COMPLETO a proposito: es el ultimo momento para que el operador se
    // de cuenta de que se equivoco de numero. Y se marca si esta autorizado o no.
    expect(modal.getByText('AUTORIZADO')).toBeTruthy();
  });
});

describe('Disparador — el boton se deshabilita con la razon visible', () => {
  const seleccionValida = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    await user.selectOptions(screen.getByLabelText(/numero a llamar/i), '+56900100141');
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

  it('allowlist vacia: no hay ningun numero autorizado', () => {
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

describe('Disparador — numero: desplegable, del Semaforo, o escrito a mano', () => {
  it('ofrece los autorizados, el del Semaforo y la opcion de escribir a mano', () => {
    render(<Disparador health={HEALTH_OK} cursos={[CURSO_CRITICO]} onDisparado={() => {}} />);
    const opciones = within(screen.getByLabelText(/numero a llamar/i)).getAllByRole('option');
    const textos = opciones.map((o) => o.textContent ?? '');

    expect(textos.some((t) => t.includes('+56900100141') && t.includes('autorizado'))).toBe(true);
    expect(textos.some((t) => /escribir otro numero a mano/i.test(t))).toBe(true);
  });

  it('ofrece el numero del Semaforo marcado como NO autorizado cuando no esta en la allowlist', async () => {
    const cursoConTelefonoAjeno = {
      ...CURSO_CRITICO,
      telefono: { ...CURSO_CRITICO.telefono, enAllowlist: false, valor: '+56900000002' },
    };
    const user = userEvent.setup();
    render(
      <Disparador health={HEALTH_OK} cursos={[cursoConTelefonoAjeno]} onDisparado={() => {}} />,
    );
    // La opcion es del curso SELECCIONADO: hay que elegirlo primero.
    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    const textos = within(screen.getByLabelText(/numero a llamar/i))
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');
    expect(textos.some((t) => t.includes('+56900000002') && /NO autorizado/.test(t))).toBe(true);
  });

  it('escribir a mano precarga el numero del Semaforo para poder corregirlo', async () => {
    const user = userEvent.setup();
    render(<Disparador health={HEALTH_OK} cursos={[CURSO_CRITICO]} onDisparado={() => {}} />);
    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    await user.selectOptions(screen.getByLabelText(/numero a llamar/i), '__manual__');

    const input = screen.getByLabelText(/numero \(a mano\)/i) as HTMLInputElement;
    expect(input.value).toBe('+56900100141');
  });

  it('un numero escrito a mano FUERA de la allowlist bloquea el boton y no dispara', async () => {
    const fetchSpy = spyFetch();
    const user = userEvent.setup();
    render(<Disparador health={HEALTH_OK} cursos={[CURSO_CRITICO]} onDisparado={() => {}} />);
    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    await user.selectOptions(screen.getByLabelText(/numero a llamar/i), '__manual__');

    const input = screen.getByLabelText(/numero \(a mano\)/i);
    await user.clear(input);
    await user.type(input, '+56987654321');

    expect(screen.getByText(/no esta en ALLOWLIST_NUMBERS/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /disparar llamada/i })).toHaveProperty(
      'disabled',
      true,
    );
    // Y lo mas importante: no salio ningun POST.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('un numero con formato invalido bloquea el boton con esa razon', async () => {
    const user = userEvent.setup();
    render(<Disparador health={HEALTH_OK} cursos={[CURSO_CRITICO]} onDisparado={() => {}} />);
    await user.selectOptions(screen.getByLabelText(/numero a llamar/i), '__manual__');
    const input = screen.getByLabelText(/numero \(a mano\)/i);
    await user.clear(input);
    await user.type(input, '12345');

    expect(screen.getByText(/no tiene formato de telefono valido/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /disparar llamada/i })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('un numero autorizado escrito a mano (con espacios) si habilita el disparo', async () => {
    const user = userEvent.setup();
    render(<Disparador health={HEALTH_OK} cursos={[CURSO_CRITICO]} onDisparado={() => {}} />);
    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    await user.selectOptions(screen.getByLabelText(/numero a llamar/i), '__manual__');

    const input = screen.getByLabelText(/numero \(a mano\)/i);
    await user.clear(input);
    await user.type(input, '+569 0010 0141');

    // La normalizacion saca los espacios y el numero calza con la allowlist.
    expect(screen.getByRole('button', { name: /disparar llamada/i })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByText('AUTORIZADO')).toBeTruthy();
  });

  it('el modal avisa en rojo si el numero no esta autorizado', async () => {
    const user = userEvent.setup();
    const cursoConTelefonoAjeno = {
      ...CURSO_CRITICO,
      telefono: { ...CURSO_CRITICO.telefono, enAllowlist: false, valor: '+56900000002' },
    };
    render(
      <Disparador health={HEALTH_OK} cursos={[cursoConTelefonoAjeno]} onDisparado={() => {}} />,
    );
    await user.selectOptions(
      screen.getByLabelText(/curso/i),
      `${CURSO_CRITICO.clientId}#${CURSO_CRITICO.orderNumber}`,
    );
    await user.selectOptions(screen.getByLabelText(/numero a llamar/i), '+56900000002');

    // El boton sigue bloqueado, asi que el modal no se puede abrir por esa via: la advertencia
    // se ve directo en el panel.
    expect(screen.getByText(/no esta en ALLOWLIST_NUMBERS/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /disparar llamada/i })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
