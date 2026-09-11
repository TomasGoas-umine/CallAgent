import type { CursoTablero } from '../types';

/**
 * Modal de confirmacion. Es el ultimo paso obligatorio antes de originar una llamada: muestra a
 * QUIEN se llama, a QUE numero y con QUE variables va a hablar el agente. Las variables NO se
 * arman aca — se muestran tal como las devuelve la API (`variablesAgente`), que las construye
 * con el mismo modulo que usa el dispatcher al llamar de verdad.
 *
 * El numero se muestra COMPLETO (no enmascarado) a proposito: es el ultimo momento para que el
 * operador se de cuenta de que se equivoco de numero.
 */
export function ConfirmModal({
  curso,
  numero,
  numeroAutorizado,
  mockProviders,
  enviando,
  onConfirmar,
  onCancelar,
}: {
  curso: CursoTablero;
  /** Numero E.164 completo al que se va a llamar. */
  numero: string;
  /** `true` si esta en ALLOWLIST_NUMBERS. Si es `false`, el backend va a responder 403. */
  numeroAutorizado: boolean;
  mockProviders: boolean;
  enviando: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  return (
    <div
      className="uv-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="uv-confirm-title"
    >
      <div className="uv-modal">
        <h3 className="uv-modal__title" id="uv-confirm-title">
          Confirmar llamada
        </h3>

        <div className={`uv-banner ${mockProviders ? 'uv-banner--mock' : 'uv-banner--real'}`}>
          {mockProviders
            ? 'Simulacion (MOCK_PROVIDERS=true): no se marca ningun numero de verdad.'
            : 'LLAMADA REAL: se va a marcar el numero y se van a consumir minutos del plan.'}
        </div>

        <strong className="uv-field__label">A quien se llama</strong>
        <div className="uv-kv">
          <span className="uv-kv__k">Contacto</span>
          <span>
            {curso.contacto.nombre ?? 'sin nombre'}
            {curso.contacto.cargo ? ` — ${curso.contacto.cargo}` : ''}
          </span>
          <span className="uv-kv__k">Numero</span>
          <span className="uv-mono">
            {numero}{' '}
            {numeroAutorizado ? (
              <span className="uv-badge uv-badge--normal">AUTORIZADO</span>
            ) : (
              <span className="uv-badge uv-badge--critico">NO AUTORIZADO</span>
            )}
          </span>
          <span className="uv-kv__k">Cliente</span>
          <span>{curso.clientName}</span>
          <span className="uv-kv__k">Curso</span>
          <span>{curso.courseName}</span>
          <span className="uv-kv__k">OC</span>
          <span className="uv-mono">{curso.orderNumber}</span>
          <span className="uv-kv__k">Urgencia</span>
          <span>
            {curso.nivel} — semana {curso.semana}, {curso.pctConexion}% de conexion,{' '}
            {curso.diasRestantes === undefined
              ? 'Sin fecha de termino'
              : `${curso.diasRestantes} dias restantes`}
          </span>
        </div>

        <strong className="uv-field__label">Variables que recibe el agente</strong>
        <div className="uv-kv">
          {Object.entries(curso.variablesAgente).map(([clave, valor]) => (
            <div key={clave} style={{ display: 'contents' }}>
              <span className="uv-kv__k uv-mono">{clave}</span>
              <span>{valor}</span>
            </div>
          ))}
        </div>

        {!numeroAutorizado ? (
          <div className="uv-blocked">
            <strong>{numero} no esta en ALLOWLIST_NUMBERS.</strong> El backend va a rechazar el
            disparo con 403 sin llamar a nadie. Corrige el numero antes de confirmar.
          </div>
        ) : null}

        {curso.advertencias.length > 0 ? (
          <div className="uv-blocked">
            <strong>Ojo:</strong>
            <ul>
              {curso.advertencias.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="uv-modal__actions">
          <button className="uv-button" onClick={onCancelar} disabled={enviando}>
            Cancelar
          </button>
          <button
            className={`uv-button ${mockProviders ? 'uv-button--primary' : 'uv-button--danger'}`}
            onClick={onConfirmar}
            disabled={enviando}
          >
            {enviando ? 'Disparando…' : mockProviders ? 'Confirmar (simulado)' : 'Llamar de verdad'}
          </button>
        </div>
      </div>
    </div>
  );
}
