import { useMemo, useState } from 'react';
import { api, newIdempotencyKey } from '../api';
import { ConfirmModal } from './ConfirmModal';
import { NivelBadge } from './Badge';
import type { CursoTablero, DisparoResponse, Health } from '../types';

/** Valor centinela del desplegable que habilita el input manual. */
const MANUAL = '__manual__';

/**
 * Normaliza lo que el operador escribe a mano: saca espacios, guiones y parentesis.
 * NO inventa prefijo pais: si el numero no calza con lo que hay en la allowlist, tiene que
 * fallar de forma visible, no "arreglarse" solo.
 */
export function normalizarTelefono(raw: string): string {
  return raw.replace(/[\s()-]/g, '');
}

/** Formato E.164 laxo: `+` y entre 8 y 15 digitos. */
export function formatoValido(numero: string): boolean {
  return /^\+\d{8,15}$/.test(numero);
}

/**
 * Razones por las que el boton de disparo queda deshabilitado. Se calculan aca SOLO para poder
 * mostrarle al operador el motivo antes de que apriete; el backend las vuelve a evaluar y es el
 * que manda (403 / 429 / 503). Nunca se llama sin pasar por POST /api/calls.
 *
 * Importante: el input manual de telefono NO debilita nada. El guardrail de allowlist vive en
 * el backend (`services/guardrails.ts`), asi que un numero escrito a mano que no este en
 * ALLOWLIST_NUMBERS termina en 403 igual. Lo que se hace aca es avisarlo antes.
 */
function razonesDeBloqueo(
  health: Health | null,
  curso: CursoTablero | null,
  numero: string,
  escrituraManual: boolean,
): string[] {
  const razones: string[] = [];
  if (!health) {
    razones.push('No hay contacto con la API: no se puede verificar el estado del sistema.');
    return razones;
  }
  if (health.killSwitch) {
    razones.push('KILL_SWITCH esta activo: el sistema tiene las llamadas apagadas.');
  }
  if (health.cuota.restantes <= 0) {
    razones.push(
      `Cuota diaria agotada: ${health.cuota.usados}/${health.cuota.limite} llamadas el ${health.cuota.dateKey}.`,
    );
  }
  if (health.allowlist.length === 0) {
    razones.push('ALLOWLIST_NUMBERS esta vacia: no hay ningun numero autorizado para llamar.');
  }
  if (!numero) {
    razones.push(escrituraManual ? 'Escribe el numero a llamar.' : 'Elige un numero.');
  } else if (!formatoValido(numero)) {
    razones.push(
      `"${numero}" no tiene formato de telefono valido (se espera + y de 8 a 15 digitos, ej. +56912345678).`,
    );
  } else if (!health.allowlist.some((a) => a.value === numero)) {
    razones.push(
      `${numero} no esta en ALLOWLIST_NUMBERS: solo se puede llamar a los numeros autorizados ` +
        `(${health.allowlist.map((a) => a.value).join(', ')}).`,
    );
  }
  if (!curso) {
    razones.push('Elige un curso del tablero.');
  } else if (!curso.llamable) {
    razones.push(`El curso esta en nivel ${curso.nivel}: solo se llama a cursos CRITICO.`);
  }
  if (!health.ventanaHoraria.abiertaAhora) {
    razones.push(
      `Fuera de la ventana horaria (${health.ventanaHoraria.inicio}-${health.ventanaHoraria.fin} ${health.ventanaHoraria.timezone}, lunes a viernes).`,
    );
  }
  return razones;
}

export function Disparador({
  health,
  cursos,
  onDisparado,
}: {
  health: Health | null;
  cursos: CursoTablero[];
  /** Refresca health + tablero + dashboard despues de un disparo exitoso. */
  onDisparado: () => void;
}) {
  const [cursoKey, setCursoKey] = useState('');
  const [seleccion, setSeleccion] = useState('');
  const [numeroManual, setNumeroManual] = useState('');
  const [operador, setOperador] = useState('');
  const [modalAbierto, setModalAbierto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<{
    httpStatus: number;
    data: DisparoResponse;
  } | null>(null);

  // La idempotency key se genera al ABRIR el modal y se conserva mientras el modal este abierto:
  // si el operador hace doble click en "Confirmar", el segundo POST llega con la misma key y el
  // backend responde already_processed sin originar una segunda llamada.
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const candidatos = useMemo(
    () => cursos.filter((c) => c.llamable).sort((a, b) => a.diasRestantes - b.diasRestantes),
    [cursos],
  );
  const curso = useMemo(
    () => candidatos.find((c) => `${c.clientId}#${c.orderNumber}` === cursoKey) ?? null,
    [candidatos, cursoKey],
  );

  const escrituraManual = seleccion === MANUAL;
  const numero = escrituraManual ? normalizarTelefono(numeroManual) : seleccion;

  const razones = razonesDeBloqueo(health, curso, numero, escrituraManual);
  const bloqueado = razones.length > 0;
  const enAllowlist = Boolean(health?.allowlist.some((a) => a.value === numero));

  /**
   * El precargado del numero del curso pasa UNA sola vez, al momento de elegir "escribir a
   * mano". No puede vivir en un efecto que reaccione a "el campo esta vacio": ahi el campo se
   * vuelve a llenar solo en cuanto el operador lo borra, y termina escribiendo sobre el numero
   * viejo en vez de reemplazarlo.
   */
  function cambiarSeleccion(valor: string) {
    setSeleccion(valor);
    if (valor === MANUAL && !numeroManual) {
      setNumeroManual(curso?.telefono.valor ?? '');
    }
  }

  function abrirConfirmacion() {
    setResultado(null);
    setIdempotencyKey(newIdempotencyKey());
    setModalAbierto(true);
  }

  async function confirmar() {
    if (!curso || !numero) return;
    setEnviando(true);
    try {
      const respuesta = await api.disparar({
        clientId: curso.clientId,
        orderNumber: curso.orderNumber,
        phone: numero,
        requestedBy: operador.trim() || undefined,
        idempotencyKey,
      });
      setResultado(respuesta);
      setModalAbierto(false);
      onDisparado();
    } catch (err) {
      setResultado({
        httpStatus: 0,
        data: { status: 'error_de_red', detalle: err instanceof Error ? err.message : String(err) },
      });
      setModalAbierto(false);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="uv-panel">
      <div className="uv-panel__header">
        <h2 className="uv-panel__title">Disparador manual</h2>
        <span className="uv-note">
          Una llamada por click. No hay disparo automatico, ni reintentos automaticos.
        </span>
      </div>

      <div className="uv-controls">
        <label className="uv-field">
          <span className="uv-field__label">Curso (solo CRITICO)</span>
          <select
            className="uv-select"
            value={cursoKey}
            onChange={(e) => setCursoKey(e.target.value)}
          >
            <option value="">— elegir curso —</option>
            {candidatos.map((c) => (
              <option
                key={`${c.clientId}#${c.orderNumber}`}
                value={`${c.clientId}#${c.orderNumber}`}
              >
                {c.orderNumber} · {c.clientName} · {c.pctConexion}% · {c.diasRestantes}d
              </option>
            ))}
          </select>
        </label>

        <label className="uv-field">
          <span className="uv-field__label">Numero a llamar</span>
          <select
            className="uv-select"
            value={seleccion}
            onChange={(e) => cambiarSeleccion(e.target.value)}
          >
            <option value="">— elegir numero —</option>
            {(health?.allowlist ?? []).map((a) => (
              <option key={a.value} value={a.value}>
                {a.value} · autorizado
              </option>
            ))}
            {curso?.telefono.valor && !curso.telefono.enAllowlist ? (
              <option value={curso.telefono.valor}>
                {curso.telefono.valor} · del Semaforo (NO autorizado)
              </option>
            ) : null}
            <option value={MANUAL}>Escribir otro numero a mano…</option>
          </select>
        </label>

        {escrituraManual ? (
          <label className="uv-field">
            <span className="uv-field__label">Numero (a mano)</span>
            <input
              className="uv-select"
              type="tel"
              value={numeroManual}
              placeholder="+56912345678"
              onChange={(e) => setNumeroManual(e.target.value)}
            />
          </label>
        ) : null}

        <label className="uv-field">
          <span className="uv-field__label">Quien dispara (opcional)</span>
          <input
            className="uv-select"
            type="text"
            value={operador}
            placeholder="tu.nombre@umine.com"
            onChange={(e) => setOperador(e.target.value)}
          />
        </label>

        <button
          className="uv-button uv-button--primary"
          onClick={abrirConfirmacion}
          disabled={bloqueado}
        >
          Disparar llamada…
        </button>
      </div>

      <p className="uv-note" style={{ marginTop: 8 }}>
        Puedes elegir un numero autorizado, tomar el del Semaforo o escribirlo a mano. Cualquiera
        que sea, solo se marca si esta en <code>ALLOWLIST_NUMBERS</code> — el guardrail vive en el
        backend, asi que escribirlo a mano no lo saltea.
        {health?.allowlist.length ? (
          <>
            {' '}
            Autorizados hoy: <strong>{health.allowlist.map((a) => a.value).join(', ')}</strong>.
          </>
        ) : null}
      </p>

      {numero && formatoValido(numero) ? (
        <p className="uv-note">
          Numero elegido: <span className="uv-mono">{numero}</span>{' '}
          {enAllowlist ? (
            <span className="uv-badge uv-badge--normal">AUTORIZADO</span>
          ) : (
            <span className="uv-badge uv-badge--critico">NO AUTORIZADO</span>
          )}
        </p>
      ) : null}

      {bloqueado ? (
        <div className="uv-blocked">
          <strong>El boton esta deshabilitado porque:</strong>
          <ul>
            {razones.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {curso ? (
        <div style={{ marginTop: 14 }}>
          <strong className="uv-field__label">Curso seleccionado</strong>
          <div className="uv-kv">
            <span className="uv-kv__k">Urgencia</span>
            <span>
              <NivelBadge nivel={curso.nivel} /> semana {curso.semana}
            </span>
            <span className="uv-kv__k">Cliente</span>
            <span>{curso.clientName}</span>
            <span className="uv-kv__k">Curso</span>
            <span>{curso.courseName}</span>
            <span className="uv-kv__k">Conexion</span>
            <span>
              {curso.pctConexion}% ({curso.conectados}/{curso.inscritos} alumnos)
            </span>
            <span className="uv-kv__k">Contacto del Semaforo</span>
            <span>
              {curso.contacto.nombre ?? '—'} · {curso.telefono.masked}
            </span>
          </div>
        </div>
      ) : null}

      {resultado ? (
        <div className={resultado.httpStatus === 201 ? 'uv-ok' : 'uv-blocked'}>
          <strong>
            HTTP {resultado.httpStatus} — {resultado.data.status ?? resultado.data.error}
          </strong>
          {resultado.data.detalle ? <div>{resultado.data.detalle}</div> : null}
          {resultado.data.followupId ? (
            <div className="uv-mono">followup: {resultado.data.followupId}</div>
          ) : null}
          {resultado.data.conversationId ? (
            <div className="uv-mono">conversation: {resultado.data.conversationId}</div>
          ) : null}
          {resultado.data.cuota ? (
            <div>
              cuota: {resultado.data.cuota.usados}/{resultado.data.cuota.limite} (
              {resultado.data.cuota.restantes} restantes)
            </div>
          ) : null}
        </div>
      ) : null}

      {modalAbierto && curso && numero ? (
        <ConfirmModal
          curso={curso}
          numero={numero}
          numeroAutorizado={enAllowlist}
          mockProviders={health?.mockProviders ?? false}
          enviando={enviando}
          onConfirmar={confirmar}
          onCancelar={() => setModalAbierto(false)}
        />
      ) : null}
    </section>
  );
}
