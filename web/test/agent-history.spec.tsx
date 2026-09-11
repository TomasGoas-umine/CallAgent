import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentHistory } from '../src/components/AgentHistory';
const row = {
  conversationId: 'conv_panel',
  status: 'done',
  startedAt: 1780000000,
  duration: 60,
  credits: 50,
  success: 'unknown',
  messages: 1,
  channel: 'web',
  summary: 'Prueba del panel',
  updatedAt: '2026-09-09T12:00:00Z',
  source: 'sync',
  hasAudio: false,
};
afterEach(() => vi.unstubAllGlobals());
describe('historial del agente', () => {
  it('muestra conversaciones sin OC, registros y estadísticas sin inventar éxito; solo importa por acción manual', async () => {
    const calls: { path: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        calls.push({ path, method: init?.method ?? 'GET' });
        const body = path.endsWith('/sync')
          ? { imported: 1, complete: true, errors: [] }
          : path.endsWith('/conv_panel')
            ? {
                summary: row,
                data: {
                  transcript: [{ role: 'user', message: 'Necesito ayuda', time_in_call_secs: 5 }],
                  metadata: { cost: 50 },
                },
              }
            : { agentId: 'agent_test', conversations: [row] };
        return new Response(JSON.stringify(body));
      }),
    );
    render(<AgentHistory />);
    const user = userEvent.setup();
    await screen.findByText('Sin evaluación');
    expect(screen.getByText('Objetivo logrado · 0 evaluadas')).toBeTruthy();
    expect(calls).toEqual([{ path: '/api/agent-history', method: 'GET' }]);
    await user.click(screen.getByRole('button', { name: 'Ver conversación conv_panel' }));
    await screen.findByText('Necesito ayuda');
    expect(screen.getByRole('button', { name: 'Descargar registros JSON' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Importar historial de ElevenLabs' }));
    await screen.findByText(/1 conversaciones importadas/);
    expect(calls.filter((call) => call.method === 'POST')).toEqual([
      { path: '/api/agent-history/sync', method: 'POST' },
    ]);
    await user.selectOptions(screen.getByLabelText('Canal'), 'phone');
    await screen.findByText(/No hay conversaciones para estos filtros/);
  });
  it('informa un error del proveedor y permite volver a intentarlo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_path: string, init?: RequestInit) =>
          new Response(
            JSON.stringify(
              init?.method === 'POST'
                ? { error: 'Sincronización incompleta' }
                : { agentId: 'agent_test', conversations: [] },
            ),
            { status: init?.method === 'POST' ? 502 : 200 },
          ),
      ),
    );
    render(<AgentHistory />);
    await screen.findByText(/No hay conversaciones/);
    await userEvent.click(screen.getByRole('button', { name: 'Importar historial de ElevenLabs' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Sincronización incompleta'),
    );
    expect(
      screen
        .getByRole('button', { name: 'Importar historial de ElevenLabs' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
});
