import type { Health } from '../types';

/**
 * Banner PERMANENTE con el modo en que corre el sistema. Es lo primero que se ve y no se puede
 * cerrar: la diferencia entre `MOCK_PROVIDERS=true` y `false` es la diferencia entre una
 * simulacion y gastar minutos reales del plan.
 */
export function Banner({ health }: { health: Health | null }) {
  if (!health) {
    return (
      <div className="uv-banner uv-banner--real">
        Sin contacto con la API — no se sabe en que modo esta el sistema. No dispares llamadas.
      </div>
    );
  }

  const mock = health.mockProviders;
  return (
    <div className={`uv-banner ${mock ? 'uv-banner--mock' : 'uv-banner--real'}`}>
      <span>
        {mock
          ? 'MOCK_PROVIDERS=true — SIMULACION: no se llama a Twilio/ElevenLabs de verdad.'
          : 'MOCK_PROVIDERS=false — LLAMADAS REALES: cada disparo consume minutos del plan.'}
      </span>
      <span className="uv-banner__meta">
        cuota {health.cuota.usados}/{health.cuota.limite} hoy ({health.cuota.dateKey}) · kill switch{' '}
        {health.killSwitch ? 'ACTIVO' : 'off'} · DRY_RUN {String(health.dryRun)} · semaforo{' '}
        {health.tableroApiMode} · disparo automatico{' '}
        {health.disparoAutomatico ? 'ON' : 'off (manual)'}
      </span>
    </div>
  );
}
