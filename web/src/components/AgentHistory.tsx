import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../api';

interface Conversation {
  conversationId: string;
  status: string;
  startedAt: number | null;
  duration: number | null;
  credits: number | null;
  success: string;
  messages: number;
  channel: string;
  summary: string;
  updatedAt: string;
  source: string;
  hasAudio: boolean;
}
interface History {
  agentId: string;
  conversations: Conversation[];
}
interface Detail {
  summary: Conversation;
  data: Record<string, unknown>;
}
async function fetchJson<T>(path: string, method = 'GET'): Promise<T> {
  const response = await fetch(`${API_BASE}/agent-history${path}`, { method });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}
const label: Record<string, string> = {
  done: 'Finalizada',
  failed: 'Fallida',
  'in-progress': 'En curso',
  initiated: 'Iniciada',
  processing: 'Procesando',
  success: 'Logrado',
  failure: 'No logrado',
  unknown: 'Sin evaluación',
  phone: 'Teléfono',
  web: 'Web / panel',
  text: 'Texto',
};
function JsonLog({ value }: { value: unknown }) {
  return <pre className="uv-history__json">{JSON.stringify(value ?? {}, null, 2)}</pre>;
}
function ConversationDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError('');
    void fetchJson<Detail>(`/${encodeURIComponent(id)}`)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((err) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [id]);
  if (error) return <p role="alert">{error}</p>;
  if (!detail) return <p>Cargando registros…</p>;
  const transcript = (Array.isArray(detail.data.transcript) ? detail.data.transcript : []) as {
    role?: string;
    message?: string;
    time_in_call_secs?: number;
  }[];
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(detail.data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="uv-history__detail">
      <p>
        <strong>{id}</strong>
      </p>
      <p>{detail.summary.summary || 'Sin resumen disponible.'}</p>
      <p className="uv-note">
        Última captura: {new Date(detail.summary.updatedAt).toLocaleString('es-CL')} ·{' '}
        {detail.summary.source === 'sync' ? 'API ElevenLabs' : 'Webhook'}
      </p>
      <button className="uv-button" onClick={download}>
        Descargar registros JSON
      </button>
      {detail.summary.hasAudio ? (
        <audio
          controls
          preload="none"
          src={`${API_BASE}/agent-history/${encodeURIComponent(id)}/audio`}
        />
      ) : (
        <p className="uv-note">ElevenLabs no ofrece audio para esta conversación.</p>
      )}
      <h3>Transcripción</h3>
      {transcript.length ? (
        <ol className="uv-history__transcript">
          {transcript.map((turn, index) => (
            <li key={index}>
              <span className="uv-note">
                {Math.round(turn.time_in_call_secs ?? 0)}s ·{' '}
                {turn.role === 'agent'
                  ? 'Agente'
                  : turn.role === 'user'
                    ? 'Interlocutor'
                    : turn.role}
              </span>
              <p>{turn.message || '(evento técnico; ver registros de turnos)'}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p>Sin transcripción disponible.</p>
      )}
      <details>
        <summary>Evaluación, datos extraídos y justificaciones</summary>
        <JsonLog value={detail.data.analysis} />
      </details>
      <details>
        <summary>Registros de turnos, herramientas y latencias</summary>
        <JsonLog value={detail.data.transcript} />
      </details>
      <details>
        <summary>Metadatos: costos, telefonía, errores y versión</summary>
        <JsonLog value={detail.data.metadata} />
      </details>
      <details>
        <summary>Registro completo recibido de ElevenLabs</summary>
        <JsonLog value={detail.data} />
      </details>
    </div>
  );
}
export function AgentHistory() {
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const refresh = useCallback(async () => {
    setHistory(await fetchJson<History>(''));
  }, []);
  useEffect(() => {
    void refresh().catch((err) => setError(String(err)));
  }, [refresh]);
  useEffect(() => {
    setPage(0);
  }, [query, status, channel, from, to]);
  const rows = useMemo(
    () =>
      (history?.conversations ?? []).filter((row) => {
        const date = row.startedAt
          ? new Intl.DateTimeFormat('en-CA', {
              timeZone: 'America/Santiago',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            }).format(new Date(row.startedAt * 1000))
          : '';
        return (
          (!status || row.status === status) &&
          (!channel || row.channel === channel) &&
          (!from || date >= from) &&
          (!to || (Boolean(date) && date <= to)) &&
          `${row.conversationId} ${row.summary}`.toLowerCase().includes(query.toLowerCase())
        );
      }),
    [history, query, status, channel, from, to],
  );
  const evaluated = rows.filter((row) => ['success', 'failure'].includes(row.success));
  const durations = rows.filter((row) => row.duration !== null);
  const seconds = durations.reduce((sum, row) => sum + row.duration!, 0);
  const run = async (sync: boolean) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (sync) {
        const result = await fetchJson<{ imported: number; complete: boolean; errors: unknown[] }>(
          '/sync',
          'POST',
        );
        setNotice(
          `${result.imported} conversaciones importadas. ${result.complete ? 'Historial disponible en ElevenLabs recorrido completo.' : `Importación parcial: ${result.errors.length} errores. Vuelve a sincronizar.`}`,
        );
      }
      await refresh();
      setSelected(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="uv-history" aria-label="Historial del agente">
      <div className="uv-panel__header">
        <h2 className="uv-panel__title">Historial del agente</h2>
        <span>
          <button className="uv-button" disabled={busy} onClick={() => void run(true)}>
            {busy ? 'Actualizando…' : 'Importar historial de ElevenLabs'}
          </button>{' '}
          <button className="uv-button" disabled={busy} onClick={() => void run(false)}>
            Actualizar historial local
          </button>
        </span>
      </div>
      <p className="uv-note">
        Llamadas telefónicas y pruebas de este agente, incluso sin OC. El webhook guarda las nuevas;
        importa el historial para recuperar las anteriores o las recibidas mientras el servidor
        estuvo apagado. Actualización manual.
      </p>
      {error && (
        <p className="uv-blocked" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="uv-history__filters">
        <label>
          Buscar
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ID o resumen"
          />
        </label>
        <label>
          Estado
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Todos</option>
            {['done', 'failed', 'in-progress', 'initiated', 'processing'].map((key) => (
              <option key={key} value={key}>
                {label[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Canal
          <select value={channel} onChange={(event) => setChannel(event.target.value)}>
            <option value="">Todos</option>
            {['phone', 'web', 'text'].map((key) => (
              <option key={key} value={key}>
                {label[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Desde
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          Hasta
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>
      <div className="uv-history__stats">
        <div>
          <strong>{rows.length}</strong>
          <span>Conversaciones</span>
        </div>
        <div>
          <strong>{(seconds / 60).toFixed(1)}</strong>
          <span>Minutos · {durations.length} con duración</span>
        </div>
        <div>
          <strong>{durations.length ? `${Math.round(seconds / durations.length)}s` : '—'}</strong>
          <span>Duración promedio</span>
        </div>
        <div>
          <strong>
            {evaluated.length
              ? `${Math.round((100 * evaluated.filter((row) => row.success === 'success').length) / evaluated.length)}%`
              : '—'}
          </strong>
          <span>Objetivo logrado · {evaluated.length} evaluadas</span>
        </div>
        <div>
          <strong>
            {rows.reduce((sum, row) => sum + (row.credits ?? 0), 0).toLocaleString('es-CL')}
          </strong>
          <span>Créditos · {rows.filter((row) => row.credits !== null).length} con costo</span>
        </div>
        <div>
          <strong>{rows.filter((row) => row.status === 'failed').length}</strong>
          <span>Fallidas</span>
        </div>
      </div>
      <p className="uv-note">
        Estadísticas de los registros filtrados. Créditos de ElevenLabs; no incluyen cargos
        independientes de Twilio. Las evaluaciones históricas que no existen se muestran sin
        evaluación.
      </p>
      <div className="uv-table-wrap">
        <table className="uv-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Canal</th>
              <th>Estado</th>
              <th>Duración</th>
              <th>Objetivo</th>
              <th>Créditos</th>
              <th>Registros</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(page * 20, (page + 1) * 20).map((row) => (
              <tr key={row.conversationId}>
                <td>
                  {row.startedAt
                    ? new Date(row.startedAt * 1000).toLocaleString('es-CL', {
                        timeZone: 'America/Santiago',
                      })
                    : 'Sin fecha'}
                </td>
                <td>{label[row.channel] ?? row.channel}</td>
                <td>{label[row.status] ?? row.status}</td>
                <td>{row.duration === null ? '—' : `${row.duration}s`}</td>
                <td>{label[row.success] ?? row.success}</td>
                <td>{row.credits ?? '—'}</td>
                <td>
                  <button
                    className="uv-button"
                    aria-label={`Ver conversación ${row.conversationId}`}
                    onClick={() =>
                      setSelected(selected === row.conversationId ? null : row.conversationId)
                    }
                  >
                    Ver registros
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <p>
          {history
            ? 'No hay conversaciones para estos filtros. Puedes importar el historial del agente.'
            : 'Cargando historial…'}
        </p>
      )}
      {rows.length > 20 && (
        <p>
          <button className="uv-button" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Anterior
          </button>{' '}
          Página {page + 1} de {Math.ceil(rows.length / 20)}{' '}
          <button
            className="uv-button"
            disabled={(page + 1) * 20 >= rows.length}
            onClick={() => setPage(page + 1)}
          >
            Siguiente
          </button>
        </p>
      )}
      {selected && <ConversationDetail key={selected} id={selected} />}
    </section>
  );
}
