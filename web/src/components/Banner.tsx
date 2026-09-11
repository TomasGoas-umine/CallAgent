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
  // Llamar de verdad sin webhook post-call es un estado valido pero confuso: la llamada suena y
  // el resultado no llega solo. Ya no es irrecuperable — el boton Sincronizar del Dashboard lo
  // trae desde la API — pero conviene avisarlo para que no parezca que el sistema se rompio.
  const sinWebhook =
    !mock &&
    (!health.webhookPostCall.urlConfigurada ||
      health.webhookPostCall.registroConfigurado === false);
  return (
    <div className={`uv-banner ${mock ? 'uv-banner--mock' : 'uv-banner--real'}`}>
      <span>
        {mock
          ? 'MOCK_PROVIDERS=true — SIMULACION: no se llama a Twilio/ElevenLabs de verdad.'
          : 'MOCK_PROVIDERS=false — LLAMADAS REALES: cada disparo consume minutos del plan.'}
      </span>
      {sinWebhook ? (
        <span>
          Webhook post-call SIN configurar: el resultado no va a llegar solo. Traelo con Sincronizar
          en el Dashboard (lee la API de ElevenLabs, no origina llamadas).
        </span>
      ) : null}
      {/* Cada dato va en su propio chip (mismo patron que la barra de filtros de Cotizaciones),
          pero el TEXTO de cada uno se mantiene completo dentro del chip: es lo que los tests
          buscan (`disparo automatico off (manual)`). */}
      <span className="uv-banner__meta">
        <span className="uv-chip">
          cuota {health.cuota.usados}/{health.cuota.limite} hoy ({health.cuota.dateKey})
        </span>
        <span className={`uv-chip${health.killSwitch ? ' uv-chip--alerta' : ''}`}>
          kill switch {health.killSwitch ? 'ACTIVO' : 'off'}
        </span>
        <span className="uv-chip">DRY_RUN {String(health.dryRun)}</span>
        <span className="uv-chip">semaforo {health.tableroApiMode}</span>
        <span className={`uv-chip${health.disparoAutomatico ? ' uv-chip--alerta' : ''}`}>
          disparo automatico {health.disparoAutomatico ? 'ON' : 'off (manual)'}
        </span>
      </span>
    </div>
  );
}
