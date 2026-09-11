/**
 * Tablero Mock — Semaforo de juguete, editable, para probar el flujo real de llamada sin
 * esperar a que un curso real caiga en banda critica.
 *
 * Tiene las TRES secciones del Semaforo original, cada una colapsable como alla
 * (`StatusCursosPage.tsx`), cada una con su propio semaforo y su propio criterio:
 *
 *   A · Riesgo Conexion — % de conexion contra lo esperado para la semana de curso.
 *   B · Riesgo DJ — dias desde el cierre del curso con la Declaracion Jurada incompleta.
 *   C · Rectificacion — dias esperando la OC Final del OTIC.
 *
 * Son tres vistas del MISMO juego de OCs, no tres listas distintas: una OC se evalua por los
 * tres criterios a la vez y cada tabla edita los campos que gobiernan SU criterio.
 *
 * **Solo la seccion A puede llamar.** B y C se ven y se editan, pero ninguna alimenta la regla
 * de llamada: eso se decide en el backend (`mock-tablero-store` arma `regla` unicamente desde la
 * seccion A) y aca ni siquiera existe la columna «¿Llama?» en esas dos tablas.
 *
 * REGLA ARQUITECTONICA (la misma que el resto del micrositio): esta vista NO clasifica nada.
 * No hay umbrales, ni semanas, ni estados hardcodeados — hasta la lista de estados del
 * desplegable viene del backend (`estadosEditables`). Se editan datos, se manda un PATCH, y el
 * backend devuelve semana, porcentajes, niveles de las tres secciones y decision de llamada ya
 * recalculados. `web/test/sin-logica-semaforo.spec.ts` falla si aparece logica del Semaforo aca.
 *
 * El guardado es EXPLICITO (boton por fila) y no por tecla: una edicion puede originar una
 * llamada telefonica real, asi que tiene que ser un acto deliberado.
 */

import { useMemo, useState } from 'react';
import { NivelBadge } from './Badge';
import type {
  CallRules,
  MockOrderEvaluation,
  MockOrderPatch,
  MockTableroResponse,
  MockTriggerOutcome,
  MotivoFueraDeSeccion,
  Nivel,
} from '../types';

type Borrador = Pick<
  MockOrderEvaluation['order'],
  | 'phone'
  | 'orderStatus'
  | 'initCourse'
  | 'endCourse'
  | 'inscritos'
  | 'conexiones'
  | 'djs'
  | 'ultimaActualizacion'
  | 'contactoNombre'
  | 'clientName'
  | 'courseName'
>;

function borradorDe(e: MockOrderEvaluation): Borrador {
  return {
    contactoNombre: e.order.contactoNombre,
    phone: e.order.phone,
    clientName: e.order.clientName,
    courseName: e.order.courseName,
    orderStatus: e.order.orderStatus,
    initCourse: e.order.initCourse,
    endCourse: e.order.endCourse,
    inscritos: e.order.inscritos,
    conexiones: e.order.conexiones,
    djs: e.order.djs,
    ultimaActualizacion: e.order.ultimaActualizacion,
  };
}

function cambios(base: Borrador, draft: Borrador): MockOrderPatch {
  const patch: MockOrderPatch = {};
  for (const k of Object.keys(base) as Array<keyof Borrador>) {
    if (base[k] !== draft[k]) (patch as Record<string, unknown>)[k] = draft[k];
  }
  return patch;
}

const MOTIVO_TRIGGER: Record<MockTriggerOutcome['motivo'], string> = {
  llamada_originada: 'Llamada originada',
  llamada_no_originada: 'La llamada no se origino',
  auto_call_desactivado: 'Llamadas automaticas apagadas: no se llamo',
  no_cumple_regla: 'La OC no cumple la regla de llamada',
  sin_transicion: 'Ya estaba en condicion de llamar (sin transicion): no se vuelve a llamar',
  en_cooldown: 'En cooldown: no se vuelve a llamar todavia',
  oc_no_encontrada: 'OC no encontrada',
};

/**
 * Rotulo legible de cada motivo de exclusion. Es SOLO presentacion: quien decide que una OC
 * queda fuera de una seccion es el backend (`semaforo-sections.ts`), aca se traduce el enum
 * que llega para no mostrarle `estado_no_espera_oc_final` en crudo al operador.
 */
const MOTIVO_FUERA: Record<MotivoFueraDeSeccion, string> = {
  no_en_ejecucion: 'El estado de la OC no es el de un curso corriendo',
  curso_terminado: 'El curso ya termino',
  conexion_completa: 'La conexion ya esta completa',
  curso_no_terminado: 'El curso todavia no termina',
  sin_conectados: 'Nadie se conecto: no hay DJ que reclamar',
  dj_completa: 'La DJ ya esta completa',
  cierre_reciente: 'Cerro hace muy poco: sigue en el plazo de gracia',
  estado_no_espera_oc_final: 'El estado no es de espera de OC Final ni de rectificacion',
  espera_reciente: 'Lleva muy poco esperando: sigue en el plazo de gracia',
  estado_muerto: 'El Semaforo descarta la OC entera por su estado',
};

function motivoLegible(motivo: MotivoFueraDeSeccion | null): string {
  return motivo ? (MOTIVO_FUERA[motivo] ?? motivo) : '';
}

/** Nombres cortos de las tres secciones. Se usan en los titulos y en los `aria-label`. */
const SECCION_A = 'Riesgo Conexion';
const SECCION_B = 'Riesgo DJ';
const SECCION_C = 'Rectificacion';

/** Plumbing compartido por las tres tablas: borradores, edicion y guardado por fila. */
interface Editor {
  data: MockTableroResponse | null;
  draftDe: (e: MockOrderEvaluation) => Borrador;
  editar: (e: MockOrderEvaluation, campo: keyof Borrador, valor: string | number) => void;
  guardar: (e: MockOrderEvaluation) => void;
  sucia: (e: MockOrderEvaluation) => boolean;
  guardando: string | null;
  clave: (e: MockOrderEvaluation) => string;
}

export function TableroMock({
  data,
  cargando,
  error,
  onRecargar,
  onGuardar,
  onToggleAutoCall,
  onGuardarReglas,
  onRestaurarReglas,
  onReset,
}: {
  data: MockTableroResponse | null;
  cargando: boolean;
  error: string | null;
  onRecargar: () => void;
  onGuardar: (clientId: string, orderNumber: string, patch: MockOrderPatch) => Promise<void>;
  onToggleAutoCall: (enabled: boolean) => void;
  onGuardarReglas: (rules: CallRules) => void;
  onRestaurarReglas: () => void;
  onReset: () => void;
}) {
  const [borradores, setBorradores] = useState<Record<string, Borrador>>({});
  const [modalAbierto, setModalAbierto] = useState(false);
  const [guardando, setGuardando] = useState<string | null>(null);

  const clave = (e: MockOrderEvaluation) => `${e.order.clientId}#${e.order.orderNumber}`;

  const ordenes = data?.ordenes ?? [];
  const trigger = data?.trigger ?? null;

  const draftDe = (e: MockOrderEvaluation): Borrador => borradores[clave(e)] ?? borradorDe(e);
  const sucia = (e: MockOrderEvaluation) =>
    Object.keys(cambios(borradorDe(e), draftDe(e))).length > 0;

  function editar(e: MockOrderEvaluation, campo: keyof Borrador, valor: string | number) {
    setBorradores((prev) => ({ ...prev, [clave(e)]: { ...draftDe(e), [campo]: valor } }));
  }

  async function guardar(e: MockOrderEvaluation) {
    const patch = cambios(borradorDe(e), draftDe(e));
    if (Object.keys(patch).length === 0) return;
    setGuardando(clave(e));
    try {
      await onGuardar(e.order.clientId, e.order.orderNumber, patch);
      setBorradores((prev) => {
        const next = { ...prev };
        delete next[clave(e)];
        return next;
      });
    } finally {
      setGuardando(null);
    }
  }

  const editor: Editor = {
    data,
    draftDe,
    editar,
    guardar: (e) => void guardar(e),
    sucia,
    guardando,
    clave,
  };

  const criticasQueLlaman = useMemo(() => ordenes.filter((o) => o.regla.dispara).length, [ordenes]);
  const enB = useMemo(() => ordenes.filter((o) => o.dj.enSeccion).length, [ordenes]);
  const enC = useMemo(() => ordenes.filter((o) => o.rectificacion.enSeccion).length, [ordenes]);
  const enA = useMemo(() => ordenes.filter((o) => o.enSeccionA).length, [ordenes]);

  return (
    <section className="uv-panel">
      <div className="uv-panel__header">
        <h2 className="uv-panel__title">Tablero Mock — datos simulados, editables</h2>
        <div className="uv-controls">
          <label className="uv-field uv-field--inline">
            <input
              type="checkbox"
              checked={data?.autoCallEnabled ?? false}
              disabled={!data || cargando}
              onChange={(ev) => onToggleAutoCall(ev.target.checked)}
            />
            <span className="uv-field__label">Llamadas automaticas del Mock</span>
          </label>
          <button className="uv-button" onClick={onRecargar} disabled={cargando}>
            {cargando ? 'Cargando…' : 'Refrescar'}
          </button>
          <button className="uv-button" onClick={onReset} disabled={cargando}>
            Restaurar datos
          </button>
        </div>
      </div>

      {error ? <div className="uv-blocked">{error}</div> : null}

      <p className="uv-note">
        {ordenes.length} OCs simuladas · {criticasQueLlaman} en condicion de llamar. Las mismas OCs
        se evaluan por los <strong>tres criterios</strong> del Semaforo, uno por seccion; cada
        seccion se abre y se cierra por separado. Solo la seccion{' '}
        <strong>A · Riesgo Conexion</strong> puede originar una llamada: cada OC llama a uno de los
        numeros de pruebas autorizados (
        <strong>{(data?.telefonos ?? []).map((t) => t.masked).join(' · ') || '—'}</strong>), que se
        elige por OC en el detalle de la fila. Editar y guardar una fila de la seccion A puede
        originar una <strong>llamada telefonica real</strong> si el interruptor de arriba esta
        encendido. El <strong>Estado OC</strong> lo mandan las fechas: el backend no guarda un
        estado que el inicio o el termino contradigan.
      </p>

      {data && !data.autoCallEnabled ? (
        <div className="uv-banner uv-banner--info">
          Las llamadas automaticas estan <strong>apagadas</strong>. Podes editar libremente: no se
          va a llamar a nadie. Encenderlas tampoco llama por si solo — hace falta guardar una
          edicion que lleve una OC a la condicion configurada.
        </div>
      ) : null}
      {data?.autoCallEnabled ? (
        <div className="uv-banner uv-banner--info" role="status">
          Automaticas activadas: <strong>esperando una transicion de NO a SI al guardar</strong>.{' '}
          Encender el interruptor no llama a los {criticasQueLlaman} cursos que ya cumplen la regla
          ni los deja en una cola. Para probar uno de ellos, guarda primero una edicion que lo deje
          en «¿Llama? = NO» y despues otra que lo devuelva a «SI». Solo ese ultimo guardado intenta
          llamar a nadie.
        </div>
      ) : null}
      {(data?.telefonos ?? [])
        .filter((t) => t.doNotCall)
        .map((t) => (
          <div className="uv-blocked" key={`dnc-${t.valor}`}>
            {t.masked} esta marcado <strong>do_not_call</strong>. Es permanente por diseno
            (consentimiento): ninguna OC asignada a ese numero va a llamar hasta que se limpie la
            base local.
          </div>
        ))}
      {(data?.telefonos ?? [])
        .filter((t) => !t.enAllowlist)
        .map((t) => (
          <div className="uv-blocked" key={`allow-${t.valor}`}>
            {t.masked} no esta en <code>ALLOWLIST_NUMBERS</code>: el backend va a rechazar el
            disparo de cualquier OC asignada a ese numero.
          </div>
        ))}

      {data?.aviso ? (
        <div className="uv-banner uv-banner--info" role="status">
          {data.aviso}
        </div>
      ) : null}

      {trigger ? (
        <div
          className={trigger.disparo ? 'uv-banner uv-banner--ok' : 'uv-banner uv-banner--info'}
          role="status"
        >
          <strong>{MOTIVO_TRIGGER[trigger.motivo]}</strong>
          {trigger.llamada ? ` · estado: ${trigger.llamada.status}` : ''}
          {trigger.cooldownRestanteSegundos ? ` · faltan ${trigger.cooldownRestanteSegundos}s` : ''}
          {trigger.detalle ? <div className="uv-note">{trigger.detalle}</div> : null}
        </div>
      ) : null}

      <Seccion
        titulo={`A · ${SECCION_A}`}
        pregunta="¿que OCs corriendo van atrasadas en % de conexion para su semana de curso?"
        enSeccion={enA}
        total={ordenes.length}
        llama
        abiertaPorDefecto
      >
        <TablaConexion ordenes={ordenes} editor={editor} cargando={cargando} />
      </Seccion>

      <Seccion
        titulo={`B · ${SECCION_B}`}
        pregunta="¿que cursos ya cerrados tienen conectados sin Declaracion Jurada?"
        enSeccion={enB}
        total={ordenes.length}
        llama={false}
        abiertaPorDefecto={false}
      >
        <TablaDj ordenes={ordenes} editor={editor} cargando={cargando} />
      </Seccion>

      <Seccion
        titulo={`C · ${SECCION_C}`}
        pregunta="¿que OCs llevan mucho esperando la OC Final del OTIC?"
        enSeccion={enC}
        total={ordenes.length}
        llama={false}
        abiertaPorDefecto={false}
      >
        <TablaRectificacion ordenes={ordenes} editor={editor} cargando={cargando} />
      </Seccion>

      <ConfigDeLlamadas
        data={data}
        onAbrirModal={() => setModalAbierto(true)}
        onRestaurar={onRestaurarReglas}
      />

      {modalAbierto && data ? (
        <ModalReglas
          rules={data.callRules}
          defaults={data.callRulesDefault}
          onCerrar={() => setModalAbierto(false)}
          onGuardar={(r) => {
            onGuardarReglas(r);
            setModalAbierto(false);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Una seccion del Semaforo, colapsada en una vineta como en el original. `<details>` nativo:
 * el estado de abierto/cerrado es del navegador, no hay que sincronizarlo con nada.
 */
function Seccion({
  titulo,
  pregunta,
  enSeccion,
  total,
  llama,
  abiertaPorDefecto,
  children,
}: {
  titulo: string;
  pregunta: string;
  enSeccion: number;
  total: number;
  llama: boolean;
  abiertaPorDefecto: boolean;
  children: React.ReactNode;
}) {
  return (
    // `aria-label` en el `<details>`: es lo que nombra la seccion entera para un lector de
    // pantalla (y lo que permite apuntarle desde un test sin depender del texto del resumen).
    <details className="uv-seccion" aria-label={`Seccion ${titulo}`} open={abiertaPorDefecto}>
      <summary className="uv-seccion__titulo">
        {titulo}
        <span className="uv-note">
          {' '}
          — {enSeccion} de {total} OCs en la seccion ·{' '}
          {llama ? 'unica seccion que puede llamar' : 'no origina llamadas'}
        </span>
      </summary>
      <p className="uv-note">{pregunta}</p>
      {children}
    </details>
  );
}

/**
 * Orden de las filas: primero las que el backend marca dentro de la seccion. Es agrupacion
 * visual, no clasificacion — quien decide la pertenencia es `semaforo-sections.ts`.
 */
function conLasDeLaSeccionPrimero(
  ordenes: MockOrderEvaluation[],
  dentro: (e: MockOrderEvaluation) => boolean,
): MockOrderEvaluation[] {
  return [...ordenes].sort((a, b) => Number(dentro(b)) - Number(dentro(a)));
}

/** Celda de identidad: OC, cliente y curso. Comun a las tres tablas. */
function CeldaOc({ e }: { e: MockOrderEvaluation }) {
  return (
    <>
      {e.order.clientName}
      <div className="uv-note">{e.order.courseName}</div>
    </>
  );
}

/**
 * La misma OC aparece en las tres tablas, asi que el boton lleva OC + seccion en el
 * `aria-label`: sin eso hay tres botones llamados "Guardar" para la misma fila y no se puede
 * distinguir cual es cual ni con lector de pantalla ni desde un test.
 */
function BotonGuardar({
  e,
  editor,
  seccion,
}: {
  e: MockOrderEvaluation;
  editor: Editor;
  seccion: string;
}) {
  return (
    <button
      className="uv-button uv-button--sm"
      aria-label={`Guardar ${e.order.orderNumber} · ${seccion}`}
      disabled={!editor.sucia(e) || editor.guardando !== null}
      onClick={() => editor.guardar(e)}
    >
      {editor.guardando === editor.clave(e) ? 'Guardando…' : 'Guardar'}
    </button>
  );
}

/** Nivel del semaforo de la seccion + por que la OC no entra, si no entra. */
function CeldaNivel({
  nivel,
  enSeccion,
  motivo,
}: {
  nivel: Nivel | null;
  enSeccion: boolean;
  motivo: MotivoFueraDeSeccion | null;
}) {
  return (
    <>
      {nivel ? <NivelBadge nivel={nivel} /> : <span>—</span>}
      {!enSeccion ? (
        <>
          <br />
          <span className="uv-note">{motivoLegible(motivo)}</span>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// A · Riesgo Conexion — la unica seccion que puede terminar en una llamada
// ---------------------------------------------------------------------------

function TablaConexion({
  ordenes,
  editor,
  cargando,
}: {
  ordenes: MockOrderEvaluation[];
  editor: Editor;
  cargando: boolean;
}) {
  const filas = useMemo(() => conLasDeLaSeccionPrimero(ordenes, (e) => e.enSeccionA), [ordenes]);
  const { data } = editor;

  return (
    <div className="uv-table-wrap">
      <table className="uv-table">
        <thead>
          <tr>
            <th>OC</th>
            <th>Cliente</th>
            <th>Estado OC</th>
            <th>Inicio</th>
            <th>Termino</th>
            <th className="uv-num">Inscritos</th>
            <th className="uv-num">Conexiones</th>
            <th className="uv-num">Semana</th>
            <th className="uv-num">% conexion</th>
            <th>Nivel</th>
            <th>¿Llama?</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filas.map((e) => {
            const d = editor.draftDe(e);
            const sucio = editor.sucia(e);
            return (
              <tr key={editor.clave(e)} className={sucio ? 'uv-row--sucia' : undefined}>
                <td className="uv-mono uv-oc">{e.order.orderNumber}</td>
                <td>
                  <CeldaOc e={e} />
                  <details>
                    <summary>Contexto del agente</summary>
                    <p className="uv-note">
                      Contacto ficticio para la prueba de voz. Puedes representar a esta persona al
                      contestar.
                    </p>
                    {(
                      [
                        ['contactoNombre', 'Contacto'],
                        ['clientName', 'Empresa'],
                        ['courseName', 'Curso'],
                      ] as const
                    ).map(([campo, label]) => (
                      <label className="uv-field" key={campo}>
                        <span>{label}</span>
                        <input
                          className="uv-input"
                          aria-label={`${label} de ${e.order.orderNumber}`}
                          maxLength={300}
                          value={d[campo]}
                          onChange={(ev) => editor.editar(e, campo, ev.target.value)}
                        />
                      </label>
                    ))}
                    <label className="uv-field">
                      <span>Telefono a llamar</span>
                      <select
                        className="uv-select"
                        aria-label={`Telefono de ${e.order.orderNumber}`}
                        value={d.phone}
                        onChange={(ev) => editor.editar(e, 'phone', ev.target.value)}
                      >
                        {(data?.telefonos ?? []).map((t) => (
                          <option key={t.valor} value={t.valor}>
                            {t.valor}
                            {t.doNotCall ? ' — do_not_call' : ''}
                            {t.enAllowlist ? '' : ' — fuera de la allowlist'}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="uv-note">
                      A este numero se llama por esta OC. Los autorizados los decide el backend
                      (whitelist de la etapa de pruebas); cualquier otro se rechaza.{' '}
                      <strong>No</strong> es una variable del agente: no se le dice al interlocutor.
                    </p>
                    <p className="uv-note">
                      Variables guardadas para la llamada. Se revalidan al marcar.
                      {sucio
                        ? ' Hay cambios sin guardar: estos valores aun corresponden al ultimo guardado.'
                        : ''}{' '}
                      El porcentaje y la OC son referencias internas que el agente no debe decir.
                    </p>
                    <dl>
                      {Object.entries(e.variablesAgente).map(([key, value]) => (
                        <div key={key}>
                          <dt>
                            <code>{key}</code>
                          </dt>
                          <dd>{value || 'Sin dato'}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </td>
                <td>
                  <select
                    className="uv-select uv-select--sm"
                    aria-label={`Estado de ${e.order.orderNumber}`}
                    value={d.orderStatus}
                    onChange={(ev) => editor.editar(e, 'orderStatus', ev.target.value)}
                  >
                    {(data?.estadosEditables ?? []).map((s) => {
                      // Cuales cuadran con las fechas lo decide el BACKEND (`estadosCoherentes`):
                      // esta vista no sabe la regla, solo la muestra. Se marcan pero no se
                      // deshabilitan — un guardado puede mover estado y fechas a la vez.
                      const cuadra = (e.estadosCoherentes ?? []).includes(s);
                      return (
                        <option key={s || '(vacio)'} value={s}>
                          {(s || '(vacio)') + (cuadra ? '' : ' — no cuadra con las fechas')}
                        </option>
                      );
                    })}
                  </select>
                </td>
                <td>
                  <input
                    className="uv-input uv-input--date"
                    type="date"
                    aria-label={`Inicio de ${e.order.orderNumber}`}
                    value={d.initCourse}
                    onChange={(ev) => editor.editar(e, 'initCourse', ev.target.value)}
                  />
                </td>
                <td>
                  <input
                    className="uv-input uv-input--date"
                    type="date"
                    aria-label={`Termino de ${e.order.orderNumber}`}
                    value={d.endCourse}
                    onChange={(ev) => editor.editar(e, 'endCourse', ev.target.value)}
                  />
                </td>
                <td className="uv-num">
                  <input
                    className="uv-input uv-input--num"
                    type="number"
                    min={0}
                    aria-label={`Inscritos de ${e.order.orderNumber}`}
                    value={d.inscritos}
                    onChange={(ev) => editor.editar(e, 'inscritos', Number(ev.target.value))}
                  />
                </td>
                <td className="uv-num">
                  <input
                    className="uv-input uv-input--num"
                    type="number"
                    min={0}
                    aria-label={`Conexiones de ${e.order.orderNumber}`}
                    value={d.conexiones}
                    onChange={(ev) => editor.editar(e, 'conexiones', Number(ev.target.value))}
                  />
                </td>
                <td className="uv-num">{e.semana}</td>
                <td className="uv-num">
                  {e.pctConexion.toFixed(0)}%
                  <br />
                  <span className="uv-note">
                    {e.conectados}/{e.inscritosActivos}
                  </span>
                </td>
                <td>
                  <CeldaNivel
                    nivel={e.nivel}
                    enSeccion={e.enSeccionA}
                    motivo={e.motivoFueraDeSeccionA}
                  />
                </td>
                <td>
                  {e.regla.dispara ? (
                    <span className="uv-badge uv-badge--critico">SI</span>
                  ) : (
                    <span className="uv-note">no</span>
                  )}
                  {e.ultimoDisparoAt ? (
                    <>
                      <br />
                      <span className="uv-note">ultimo: {e.ultimoResultado}</span>
                    </>
                  ) : null}
                </td>
                <td>
                  <BotonGuardar e={e} editor={editor} seccion={SECCION_A} />
                </td>
              </tr>
            );
          })}
          {filas.length === 0 ? (
            <tr>
              <td colSpan={12} className="uv-note">
                {cargando ? 'Cargando…' : 'Sin datos del Mock.'}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B · Riesgo DJ — se ve y se edita, nunca llama
// ---------------------------------------------------------------------------

function TablaDj({
  ordenes,
  editor,
  cargando,
}: {
  ordenes: MockOrderEvaluation[];
  editor: Editor;
  cargando: boolean;
}) {
  const filas = useMemo(() => conLasDeLaSeccionPrimero(ordenes, (e) => e.dj.enSeccion), [ordenes]);

  return (
    <>
      <p className="uv-note">
        Esta seccion <strong>no origina llamadas</strong> y no tiene columna «¿Llama?»: una DJ
        pendiente se resuelve con el OTIC, no con el alumno por telefono. Se edita para poder ver
        como cambia su semaforo. Campos que mandan aca: <strong>termino</strong> del curso (de ahi
        salen los dias desde el cierre), <strong>conectados</strong> y <strong>con DJ</strong> — el
        porcentaje se calcula sobre los conectados, no sobre los inscritos.
      </p>
      <div className="uv-table-wrap">
        <table className="uv-table">
          <thead>
            <tr>
              <th>OC</th>
              <th>Cliente</th>
              <th>Estado OC</th>
              <th>Termino</th>
              <th className="uv-num">Conectados</th>
              <th className="uv-num">Con DJ</th>
              <th className="uv-num">% DJ</th>
              <th className="uv-num">Dias desde el cierre</th>
              <th>Nivel</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filas.map((e) => {
              const d = editor.draftDe(e);
              return (
                <tr key={editor.clave(e)} className={editor.sucia(e) ? 'uv-row--sucia' : undefined}>
                  <td className="uv-mono uv-oc">{e.order.orderNumber}</td>
                  <td>
                    <CeldaOc e={e} />
                  </td>
                  {/* El estado lo derivan las fechas: se muestra, se edita en la seccion A. */}
                  <td className="uv-note">{e.order.orderStatus || '(vacio)'}</td>
                  <td>
                    <input
                      className="uv-input uv-input--date"
                      type="date"
                      aria-label={`Termino DJ de ${e.order.orderNumber}`}
                      value={d.endCourse}
                      onChange={(ev) => editor.editar(e, 'endCourse', ev.target.value)}
                    />
                  </td>
                  <td className="uv-num">
                    <input
                      className="uv-input uv-input--num"
                      type="number"
                      min={0}
                      aria-label={`Conectados de ${e.order.orderNumber}`}
                      value={d.conexiones}
                      onChange={(ev) => editor.editar(e, 'conexiones', Number(ev.target.value))}
                    />
                  </td>
                  <td className="uv-num">
                    <input
                      className="uv-input uv-input--num"
                      type="number"
                      min={0}
                      aria-label={`Con DJ de ${e.order.orderNumber}`}
                      value={d.djs}
                      onChange={(ev) => editor.editar(e, 'djs', Number(ev.target.value))}
                    />
                  </td>
                  <td className="uv-num">
                    {e.dj.pctDj.toFixed(0)}%
                    <br />
                    <span className="uv-note">
                      {e.dj.conDj}/{e.dj.base}
                    </span>
                  </td>
                  <td className="uv-num">{e.dj.diasDesdeCierre}</td>
                  <td>
                    <CeldaNivel
                      nivel={e.dj.nivel}
                      enSeccion={e.dj.enSeccion}
                      motivo={e.dj.motivoFuera}
                    />
                  </td>
                  <td>
                    <BotonGuardar e={e} editor={editor} seccion={SECCION_B} />
                  </td>
                </tr>
              );
            })}
            {filas.length === 0 ? (
              <tr>
                <td colSpan={10} className="uv-note">
                  {cargando ? 'Cargando…' : 'Sin datos del Mock.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// C · Rectificacion — se ve y se edita, nunca llama
// ---------------------------------------------------------------------------

function TablaRectificacion({
  ordenes,
  editor,
  cargando,
}: {
  ordenes: MockOrderEvaluation[];
  editor: Editor;
  cargando: boolean;
}) {
  const filas = useMemo(
    () => conLasDeLaSeccionPrimero(ordenes, (e) => e.rectificacion.enSeccion),
    [ordenes],
  );
  const { data } = editor;

  return (
    <>
      <p className="uv-note">
        Esta seccion <strong>no origina llamadas</strong> y no tiene columna «¿Llama?»: la OC Final
        la emite el OTIC, no el alumno. Los dias pendientes se cuentan desde la{' '}
        <strong>ultima actualizacion</strong> de la OC, que es el mismo proxy que usa el Semaforo
        real: no existe una fecha de «se pidio la rectificacion» en el dato.
      </p>
      <div className="uv-table-wrap">
        <table className="uv-table">
          <thead>
            <tr>
              <th>OC</th>
              <th>Cliente</th>
              <th>Estado OC</th>
              <th>Ultima actualizacion</th>
              <th className="uv-num">Dias pendiente</th>
              <th>Nivel</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filas.map((e) => {
              const d = editor.draftDe(e);
              return (
                <tr key={editor.clave(e)} className={editor.sucia(e) ? 'uv-row--sucia' : undefined}>
                  <td className="uv-mono uv-oc">{e.order.orderNumber}</td>
                  <td>
                    <CeldaOc e={e} />
                  </td>
                  <td>
                    <select
                      className="uv-select uv-select--sm"
                      aria-label={`Estado de rectificacion de ${e.order.orderNumber}`}
                      value={d.orderStatus}
                      onChange={(ev) => editor.editar(e, 'orderStatus', ev.target.value)}
                    >
                      {(data?.estadosEditables ?? []).map((s) => {
                        const cuadra = (e.estadosCoherentes ?? []).includes(s);
                        return (
                          <option key={s || '(vacio)'} value={s}>
                            {(s || '(vacio)') + (cuadra ? '' : ' — no cuadra con las fechas')}
                          </option>
                        );
                      })}
                    </select>
                  </td>
                  <td>
                    <input
                      className="uv-input uv-input--date"
                      type="date"
                      aria-label={`Ultima actualizacion de ${e.order.orderNumber}`}
                      value={d.ultimaActualizacion}
                      onChange={(ev) => editor.editar(e, 'ultimaActualizacion', ev.target.value)}
                    />
                  </td>
                  <td className="uv-num">{e.rectificacion.diasPendiente}</td>
                  <td>
                    <CeldaNivel
                      nivel={e.rectificacion.nivel}
                      enSeccion={e.rectificacion.enSeccion}
                      motivo={e.rectificacion.motivoFuera}
                    />
                  </td>
                  <td>
                    <BotonGuardar e={e} editor={editor} seccion={SECCION_C} />
                  </td>
                </tr>
              );
            })}
            {filas.length === 0 ? (
              <tr>
                <td colSpan={7} className="uv-note">
                  {cargando ? 'Cargando…' : 'Sin datos del Mock.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Seccion SIEMPRE visible al pie del tablero: que configuracion esta activa ahora mismo. */
function ConfigDeLlamadas({
  data,
  onAbrirModal,
  onRestaurar,
}: {
  data: MockTableroResponse | null;
  onAbrirModal: () => void;
  onRestaurar: () => void;
}) {
  if (!data) return null;
  const { callRules, callRulesDefault } = data;
  const semanas = ['1', '2', '3', '4'];
  const modificado = semanas.some(
    (s) => callRules.llamarSiPctMenorA[s] !== callRulesDefault.llamarSiPctMenorA[s],
  );
  const nivelesDistintos =
    callRules.nivelesQueLlaman.join(',') !== callRulesDefault.nivelesQueLlaman.join(',');

  return (
    <section className="uv-subpanel" aria-label="Configuracion de disparo de llamadas">
      <div className="uv-panel__header">
        <h3 className="uv-panel__title">Configuracion de disparo de llamadas</h3>
        <div className="uv-controls">
          <button className="uv-button uv-button--sm" onClick={onAbrirModal}>
            Editar umbrales
          </button>
          <button
            className="uv-button uv-button--sm"
            onClick={onRestaurar}
            disabled={!modificado && !nivelesDistintos}
          >
            Restaurar valores del Semaforo
          </button>
        </div>
      </div>

      <p className="uv-note">
        Estos umbrales deciden <strong>cuando el agente llama</strong>, y solo aplican a la seccion
        A · Riesgo Conexion. No cambian la criticidad que muestra el Semaforo —esa se calcula
        siempre con los umbrales reales del original y no es configurable— ni tocan las secciones B
        y C, que no llaman. Cambiarlos aca no llama por si solo: re-alinea el estado de cada OC.
      </p>

      <table className="uv-table uv-table--compact">
        <thead>
          <tr>
            <th>Semana de curso</th>
            <th className="uv-num">Llamar si % conexion &lt;</th>
            <th className="uv-num">Valor del Semaforo</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {semanas.map((s) => {
            const activo = callRules.llamarSiPctMenorA[s];
            const original = callRulesDefault.llamarSiPctMenorA[s];
            return (
              <tr key={s}>
                <td>Semana {s}</td>
                <td className="uv-num">{activo === null ? 'nunca' : `${activo}%`}</td>
                <td className="uv-num">{original === null ? 'nunca' : `${original}%`}</td>
                <td>
                  {activo === original ? (
                    <span className="uv-note">original</span>
                  ) : (
                    <span className="uv-badge uv-badge--alerta">modificado</span>
                  )}
                </td>
              </tr>
            );
          })}
          <tr>
            <td>Niveles que llaman</td>
            <td className="uv-num">{callRules.nivelesQueLlaman.join(', ')}</td>
            <td className="uv-num">{callRulesDefault.nivelesQueLlaman.join(', ')}</td>
            <td>
              {nivelesDistintos ? (
                <span className="uv-badge uv-badge--alerta">modificado</span>
              ) : (
                <span className="uv-note">original</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="uv-note">
        Cooldown entre disparos de una misma OC: {data.cooldownSegundos}s · Whitelist de pruebas:{' '}
        {data.whitelistPruebas.join(', ')}
      </p>
    </section>
  );
}

function ModalReglas({
  rules,
  defaults,
  onCerrar,
  onGuardar,
}: {
  rules: CallRules;
  defaults: CallRules;
  onCerrar: () => void;
  onGuardar: (r: CallRules) => void;
}) {
  const [draft, setDraft] = useState<CallRules>(() => structuredClone(rules));
  const semanas = ['1', '2', '3', '4'];

  function setUmbral(semana: string, valor: string) {
    setDraft((prev) => ({
      ...prev,
      llamarSiPctMenorA: {
        ...prev.llamarSiPctMenorA,
        [semana]: valor === '' ? null : Number(valor),
      },
    }));
  }

  function toggleNivel(nivel: Nivel, activo: boolean) {
    setDraft((prev) => ({
      ...prev,
      nivelesQueLlaman: activo
        ? [...new Set([...prev.nivelesQueLlaman, nivel])]
        : prev.nivelesQueLlaman.filter((n) => n !== nivel),
    }));
  }

  return (
    <div
      className="uv-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Editar umbrales de llamada"
    >
      <div className="uv-modal">
        <h3 className="uv-panel__title">Umbrales que disparan llamadas</h3>
        <p className="uv-note">
          Vacio = esa semana nunca llama. Los valores del Semaforo son{' '}
          {semanas.map((s) => `S${s}: ${defaults.llamarSiPctMenorA[s] ?? 'nunca'}`).join(' · ')}.
        </p>

        {semanas.map((s) => (
          <label className="uv-field" key={s}>
            <span className="uv-field__label">Semana {s} — llamar si % conexion &lt;</span>
            <input
              className="uv-input"
              type="number"
              min={0}
              max={100}
              placeholder="nunca"
              value={draft.llamarSiPctMenorA[s] ?? ''}
              onChange={(e) => setUmbral(s, e.target.value)}
            />
          </label>
        ))}

        <fieldset className="uv-field">
          <legend className="uv-field__label">Niveles que habilitan la llamada</legend>
          {(['CRITICO', 'ALERTA', 'NORMAL'] as Nivel[]).map((n) => (
            <label className="uv-field uv-field--inline" key={n}>
              <input
                type="checkbox"
                checked={draft.nivelesQueLlaman.includes(n)}
                onChange={(e) => toggleNivel(n, e.target.checked)}
              />
              <span>{n}</span>
            </label>
          ))}
        </fieldset>

        <div className="uv-controls">
          <button className="uv-button" onClick={() => onGuardar(draft)}>
            Guardar umbrales
          </button>
          <button className="uv-button" onClick={onCerrar}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
