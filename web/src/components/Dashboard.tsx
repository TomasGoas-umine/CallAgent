import { AgentHistory } from './AgentHistory';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { EstadoBadge } from './Badge';
import type { CallDetalleResponse, LlamadaResumen, SyncResponse } from '../types';

/** De donde salio el resultado de una llamada. `twilio` = no hubo conversacion que traer. */
const ORIGEN_DEL_DATO: Record<string, string> = {
  webhook: 'webhook post-call',
  sync: 'sincronizado por API',
  twilio: 'estado final de Twilio (sin conversacion)',
};

function formatearDuracion(segundos: number | null): string {
  if (segundos === null || segundos === undefined) return '—';
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function formatearFecha(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CL');
}

function CamposExtraidos({
  campos,
  detalle,
}: {
  campos: Record<string, unknown>;
  /** El mismo campo con el `rationale`: por que el modelo extrajo ese valor. */
  detalle?: Record<string, { value?: unknown; rationale?: string }>;
}) {
  const entradas = Object.entries(campos);
  if (entradas.length === 0) return <span className="uv-note">sin campos extraidos</span>;
  return (
    <div className="uv-kv">
      {entradas.map(([clave, valor]) => {
        const rationale = detalle?.[clave]?.rationale;
        return (
          <div key={clave} style={{ display: 'contents' }}>
            <span className="uv-kv__k">{clave}</span>
            <span>
              {valor === '' || valor === null ? '—' : String(valor)}
              {rationale ? (
                <>
                  <br />
                  <span className="uv-note">{rationale}</span>
                </>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Criterios de evaluacion del agente (hoy solo `objetivo_resuelto`). Llegaban en la API y no se
 * mostraban en ningun lado: son la justificacion de por que una llamada se cerro como resuelta.
 */
function Evaluacion({
  criterios,
}: {
  criterios: Record<string, { result?: string; rationale?: string }>;
}) {
  const entradas = Object.entries(criterios);
  if (entradas.length === 0) {
    return <span className="uv-note">sin criterios evaluados</span>;
  }
  return (
    <div className="uv-kv">
      {entradas.map(([clave, valor]) => (
        <div key={clave} style={{ display: 'contents' }}>
          <span className="uv-kv__k">{clave}</span>
          <span>
            {valor?.result ?? '—'}
            {valor?.rationale ? (
              <>
                <br />
                <span className="uv-note">{valor.rationale}</span>
              </>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Fila expandible: el detalle (con transcripcion) se pide recien al abrirla.
 *
 * El pedido se rehace cada vez que se abre Y cada vez que cambia `updatedAt` del followup
 * estando abierta. Antes se pedia una sola vez (`if (!detalle)`) y el componente sobrevivia a
 * los refrescos: si abrias la fila mientras la llamada estaba en DIALING, quedaba cacheada una
 * respuesta sin transcripcion y no habia forma de ver la buena sin recargar la pagina —
 * justo el escenario normal ahora que el resultado puede llegar despues, por sync.
 */
function FilaLlamada({ llamada }: { llamada: LlamadaResumen }) {
  const [abierta, setAbierta] = useState(false);
  const [detalle, setDetalle] = useState<CallDetalleResponse | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { followupId, updatedAt } = llamada;

  useEffect(() => {
    if (!abierta) return;
    let vigente = true;
    setCargando(true);
    setError(null);
    api
      .call(followupId)
      .then((datos) => {
        if (vigente) setDetalle(datos);
      })
      .catch((err: unknown) => {
        if (vigente) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      // Evita que una respuesta lenta de un followup ya cerrado pise el estado actual.
      vigente = false;
    };
  }, [abierta, followupId, updatedAt]);

  function alternar() {
    setAbierta((previo) => !previo);
  }

  return (
    <>
      <tr>
        <td>
          <button className="uv-button--link" onClick={alternar} aria-expanded={abierta}>
            {abierta ? '▾ ocultar' : '▸ ver'}
          </button>
        </td>
        <td>
          <EstadoBadge estado={llamada.estado} />
        </td>
        <td>
          {llamada.clientName}
          <br />
          <span className="uv-note">{llamada.courseName}</span>
        </td>
        <td className="uv-mono uv-oc">{llamada.orderNumber}</td>
        <td className="uv-mono">{llamada.telefonoMasked}</td>
        <td>
          <span className="uv-badge uv-badge--origen">{llamada.origen}</span>
          {llamada.requestedBy ? (
            <>
              <br />
              <span className="uv-note">{llamada.requestedBy}</span>
            </>
          ) : null}
        </td>
        <td className="uv-num">{formatearDuracion(llamada.resultado?.durationSeconds ?? null)}</td>
        <td>{llamada.resultado?.outcome ?? '—'}</td>
        <td className="uv-num">{llamada.intentos}</td>
        <td className="uv-note">{formatearFecha(llamada.updatedAt)}</td>
      </tr>
      {abierta ? (
        <tr>
          <td colSpan={10} className="uv-detail">
            {cargando ? <p className="uv-note">Cargando detalle…</p> : null}
            {error ? <div className="uv-blocked">{error}</div> : null}
            {detalle ? (
              <>
                <div className="uv-kv">
                  <span className="uv-kv__k">followup_id</span>
                  <span className="uv-mono">{detalle.followup.followupId}</span>
                  <span className="uv-kv__k">motivo</span>
                  <span>{detalle.followup.motivo}</span>
                  <span className="uv-kv__k">creado</span>
                  <span>{formatearFecha(detalle.followup.createdAt)}</span>
                  <span className="uv-kv__k">proximo intento</span>
                  <span>{formatearFecha(detalle.followup.nextAttemptAt)}</span>
                </div>

                {detalle.llamadas.length === 0 ? (
                  <p className="uv-note">
                    Sin resultado todavia. Si la llamada ya termino, el webhook post-call no llego:
                    apreta <strong>Sincronizar</strong> arriba para traerlo desde la API de
                    ElevenLabs.
                  </p>
                ) : null}

                {detalle.llamadas.map((c) => (
                  <div key={c.conversationId} style={{ marginTop: 14 }}>
                    <div className="uv-kv">
                      <span className="uv-kv__k">conversation_id</span>
                      <span className="uv-mono">{c.conversationId}</span>
                      <span className="uv-kv__k">call_sid</span>
                      <span className="uv-mono">{c.callSid ?? '—'}</span>
                      <span className="uv-kv__k">resultado</span>
                      <span>
                        {c.outcome ?? '—'} <span className="uv-note">({c.status})</span>
                      </span>
                      <span className="uv-kv__k">inicio / fin</span>
                      <span>
                        {formatearFecha(c.startedAt)} <span className="uv-note">→</span>{' '}
                        {formatearFecha(c.endedAt)}
                      </span>
                      <span className="uv-kv__k">duracion</span>
                      <span>{formatearDuracion(c.durationSeconds)}</span>
                      <span className="uv-kv__k">corte</span>
                      <span>{c.terminationReason ?? '—'}</span>
                      <span className="uv-kv__k">estado en Twilio</span>
                      <span>
                        {c.twilio
                          ? `${c.twilio.status}${c.twilio.answeredBy ? ` (${c.twilio.answeredBy})` : ''}`
                          : 'no consultado'}
                      </span>
                      <span className="uv-kv__k">origen del dato</span>
                      <span>
                        {ORIGEN_DEL_DATO[c.fuente] ?? c.fuente}
                        {c.cost === null ? null : (
                          <span className="uv-note"> · {c.cost} creditos</span>
                        )}
                      </span>
                      <span className="uv-kv__k">resumen</span>
                      <span>{c.transcriptSummary ?? '—'}</span>
                    </div>

                    <strong className="uv-field__label">Campos extraidos</strong>
                    <CamposExtraidos
                      campos={c.camposExtraidos}
                      detalle={c.camposExtraidosDetalle}
                    />

                    <strong className="uv-field__label">Criterios de evaluacion</strong>
                    <Evaluacion criterios={c.evaluacion} />

                    <strong className="uv-field__label">Transcripcion</strong>
                    {c.transcript.length === 0 ? (
                      <p className="uv-note">sin transcripcion</p>
                    ) : (
                      <div className="uv-transcript">
                        {c.transcript.map((turno, i) => (
                          <div className="uv-turn" key={`${c.conversationId}-${i}`}>
                            <span className="uv-turn__role">{turno.role}</span>
                            <span>{turno.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function Dashboard({
  llamadas,
  cargando,
  onRefrescar,
}: {
  llamadas: LlamadaResumen[];
  cargando: boolean;
  onRefrescar: () => void;
}) {
  const [sincronizando, setSincronizando] = useState(false);
  const [resumenSync, setResumenSync] = useState<SyncResponse | null>(null);
  const [errorSync, setErrorSync] = useState<string | null>(null);

  /**
   * Trae los resultados desde la API de ElevenLabs. NO origina llamadas: el backend solo hace
   * GET contra el proveedor, asi que este boton se puede apretar sin miedo y no necesita el
   * modal de confirmacion que si exige el Disparador.
   */
  const sincronizar = useCallback(async () => {
    setSincronizando(true);
    setErrorSync(null);
    try {
      const resumen = await api.sincronizar();
      setResumenSync(resumen);
      onRefrescar();
    } catch (err) {
      setErrorSync(err instanceof Error ? err.message : String(err));
    } finally {
      setSincronizando(false);
    }
  }, [onRefrescar]);

  return (
    <section className="uv-panel">
      <div className="uv-panel__header">
        <h2 className="uv-panel__title">Dashboard de llamadas</h2>
        <span>
          <button
            className="uv-button"
            onClick={() => void sincronizar()}
            disabled={sincronizando || cargando}
            title="Trae los resultados desde la API de ElevenLabs. No origina ninguna llamada."
          >
            {sincronizando ? 'Sincronizando…' : 'Sincronizar'}
          </button>{' '}
          <button className="uv-button" onClick={onRefrescar} disabled={cargando}>
            {cargando ? 'Cargando…' : 'Refrescar'}
          </button>
        </span>
      </div>

      <AgentHistory />
      <h2 className="uv-panel__title">Seguimientos de CallAgent</h2>
      <p className="uv-note">
        {llamadas.length} followups. No hay refresco automatico a proposito: los datos se actualizan
        solo cuando aprietas Refrescar. <strong>Sincronizar</strong> va a buscar a la API de
        ElevenLabs el resultado de las llamadas que ya terminaron — no depende del webhook y no
        origina ninguna llamada.
      </p>

      {errorSync ? <div className="uv-blocked">{errorSync}</div> : null}
      {resumenSync ? (
        <p className="uv-note">
          Sincronizacion: <strong>{resumenSync.registradas}</strong> resultado(s) nuevo(s) ·{' '}
          {resumenSync.yaRegistradas} ya estaban · {resumenSync.noFinales} aun en curso ·{' '}
          {resumenSync.noAtribuibles} no atribuibles · {resumenSync.errores} error(es).
          {!resumenSync.twilio ? null : resumenSync.twilio.consultado ? (
            <>
              {' '}
              Twilio: <strong>{resumenSync.twilio.dialingResueltos}</strong> seguimiento(s) en
              DIALING resuelto(s) con el estado final de la llamada.
            </>
          ) : (
            <> Twilio no se consulto: {resumenSync.twilio.motivo}</>
          )}
          {resumenSync.noAtribuibles > 0 ? (
            <>
              {' '}
              Las no atribuibles son conversaciones que este proyecto no origino (pruebas desde el
              panel de ElevenLabs): se pueden consultar en el Historial del agente sin asignarles
              una OC.
            </>
          ) : null}
        </p>
      ) : null}

      <div className="uv-table-wrap">
        <table className="uv-table">
          <thead>
            <tr>
              <th />
              <th>Estado</th>
              <th>Cliente / curso</th>
              <th>OC</th>
              <th>Telefono</th>
              <th>Origen</th>
              <th className="uv-num">Duracion</th>
              <th>Resultado</th>
              <th className="uv-num">Intentos</th>
              <th>Actualizado</th>
            </tr>
          </thead>
          <tbody>
            {llamadas.map((llamada) => (
              <FilaLlamada key={llamada.followupId} llamada={llamada} />
            ))}
            {llamadas.length === 0 ? (
              <tr>
                <td colSpan={10} className="uv-note">
                  Todavia no hay llamadas registradas. Dispara una desde la pestana Disparador.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
