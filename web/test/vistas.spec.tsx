/**
 * Tablero y Dashboard: lo que el operador tiene que poder ver y hacer sin disparar nada.
 * Ninguna de estas dos vistas puede originar una llamada — solo leen.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tablero } from '../src/components/Tablero';
import { Dashboard } from '../src/components/Dashboard';
import { Banner } from '../src/components/Banner';
import { CURSO_CRITICO, CURSO_NORMAL, HEALTH_OK, LLAMADA_RESUELTA } from './fixtures';

describe('Tablero', () => {
  const cursos = [CURSO_NORMAL, CURSO_CRITICO];

  it('muestra estado, % de conexion, semana, dias restantes, contacto y telefono enmascarado', () => {
    render(<Tablero cursos={cursos} cargando={false} onRefrescar={() => {}} />);

    const fila = screen.getByText('TEST-9600').closest('tr');
    expect(fila).toBeTruthy();
    const celdas = within(fila!);
    expect(celdas.getByText('CRITICO')).toBeTruthy();
    expect(celdas.getByText(/0%/)).toBeTruthy();
    expect(celdas.getByText('0/10')).toBeTruthy();
    expect(celdas.getByText('TEST · Marcela Bravo')).toBeTruthy();
    expect(celdas.getByText('Encargada de Capacitacion')).toBeTruthy();
    expect(celdas.getByText('***0141')).toBeTruthy();
  });

  it('nunca muestra un telefono completo', () => {
    const { container } = render(
      <Tablero cursos={cursos} cargando={false} onRefrescar={() => {}} />,
    );
    expect(container.textContent).not.toContain('+56900100141');
  });

  it('filtra por urgencia', async () => {
    const user = userEvent.setup();
    render(<Tablero cursos={cursos} cargando={false} onRefrescar={() => {}} />);

    expect(screen.getByText('TEST-9600')).toBeTruthy();
    expect(screen.getByText('TEST-9104')).toBeTruthy();

    await user.selectOptions(screen.getByLabelText(/filtro por urgencia/i), 'CRITICO');

    expect(screen.getByText('TEST-9600')).toBeTruthy();
    expect(screen.queryByText('TEST-9104')).toBeNull();
  });

  it('ordena lo mas urgente primero', () => {
    render(<Tablero cursos={cursos} cargando={false} onRefrescar={() => {}} />);
    const ocs = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.querySelector('td.uv-mono')?.textContent);
    expect(ocs).toEqual(['TEST-9600', 'TEST-9104']);
  });

  it('refresca solo cuando se aprieta el boton (no hay polling)', async () => {
    const onRefrescar = vi.fn();
    const user = userEvent.setup();
    render(<Tablero cursos={cursos} cargando={false} onRefrescar={onRefrescar} />);

    expect(onRefrescar).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /refrescar/i }));
    expect(onRefrescar).toHaveBeenCalledTimes(1);
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
