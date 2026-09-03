import { useState } from 'react';
import { api } from '../api';
import { EstadoBadge } from './Badge';
import type { CallDetalleResponse, LlamadaResumen } from '../types';

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

function CamposExtraidos({ campos }: { campos: Record<string, unknown> }) {
  const entradas = Object.entries(campos);
  if (entradas.length === 0) return <span className="uv-note">sin campos extraidos</span>;
  return (
    <div className="uv-kv">
      {entradas.map(([clave, valor]) => (
        <div key={clave} style={{ display: 'contents' }}>
          <span className="uv-kv__k">{clave}</span>
          <span>{valor === '' || valor === null ? '—' : String(valor)}</span>
        </div>
      ))}
    </div>
  );
}

/** Fila expandible: el detalle (con transcripcion) se pide recien al abrirla. */
function FilaLlamada({ llamada }: { llamada: LlamadaResumen }) {
  const [abierta, setAbierta] = useState(false);
  const [detalle, setDetalle] = useState<CallDetalleResponse | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function alternar() {
    const siguiente = !abierta;
    setAbierta(siguiente);
    if (siguiente && !detalle) {
      setCargando(true);
      setError(null);
      try {
        setDetalle(await api.call(llamada.followupId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCargando(false);
      }
    }
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
        <td className="uv-mono">{llamada.orderNumber}</td>
        <td className="uv-mono">{llamada.telefonoMasked}</td>
        <td>
          <span className="uv-badge uv-badge--neutro">{llamada.origen}</span>
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
                    Todavia no llego el webhook post-call: no hay resultado ni transcripcion.
                  </p>
                ) : null}

                {detalle.llamadas.map((c) => (
                  <div key={c.conversationId} style={{ marginTop: 14 }}>
                    <div className="uv-kv">
                      <span className="uv-kv__k">conversation_id</span>
                      <span className="uv-mono">{c.conversationId}</span>
                      <span className="uv-kv__k">resultado</span>
                      <span>
                        {c.outcome ?? '—'} <span className="uv-note">({c.status})</span>
                      </span>
                      <span className="uv-kv__k">duracion</span>
                      <span>{formatearDuracion(c.durationSeconds)}</span>
                      <span className="uv-kv__k">resumen</span>
                      <span>{c.transcriptSummary ?? '—'}</span>
                    </div>

                    <strong className="uv-field__label">Campos extraidos</strong>
                    <CamposExtraidos campos={c.camposExtraidos} />

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
  return (
    <section className="uv-panel">
      <div className="uv-panel__header">
        <h2 className="uv-panel__title">Dashboard de llamadas</h2>
        <button className="uv-button" onClick={onRefrescar} disabled={cargando}>
          {cargando ? 'Cargando…' : 'Refrescar'}
        </button>
      </div>

      <p className="uv-note">
        {llamadas.length} followups. No hay refresco automatico a proposito: los datos se actualizan
        solo cuando aprietas Refrescar.
      </p>

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
