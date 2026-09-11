/**
 * Tablero Original — el dato REAL de `tablero-api`, estrictamente de lectura.
 *
 * Esta vista no puede crear candidatos, ni seguimientos, ni llamadas: el endpoint que la
 * alimenta (`GET /api/tablero/original`) construye su propio cliente HTTP y ese cliente nunca
 * entra en un camino de originacion. No hay boton de disparo aca, y no debe haberlo.
 *
 * Muestra las TRES secciones del Semaforo original, cada una en su propia vineta colapsable y
 * con su propia escala de criticidad:
 *
 *   A · Riesgo Conexion   — % de conexion contra lo esperado para la semana del curso
 *   B · Riesgo DJ         — dias que lleva el curso cerrado sin Declaracion Jurada
 *   C · Rectificacion     — dias que lleva la OC esperando la OC Final del OTIC
 *
 * Las tres escalas son independientes: un curso puede ser CRITICO en una y no aparecer en las
 * otras dos. Mezclarlas seria inventar una cuarta regla.
 *
 * Nada de eso se calcula aca. Este archivo recibe `nivel` y los contadores ya resueltos por el
 * backend (que a su vez es espejo del repo `micrositio-operaciones-tablero-sence`) y solo
 * filtra por nivel, ordena y pinta. Hay un test que falla si alguien copia un umbral al front:
 * `web/test/sin-logica-semaforo.spec.ts`.
 *
 * Tampoco imita al micrositio original ni lo embebe en un iframe: son tablas simples, suficiente
 * para comparar el Mock contra la realidad. Para ver el Semaforo tal cual, esta el enlace.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { NivelBadge } from './Badge';
import type {
  CursoOriginal,
  CursoRectificacion,
  CursoRiesgoDj,
  Nivel,
  TableroOriginalResponse,
} from '../types';

type Filtro = 'SEMAFORO' | 'TODOS' | Nivel;

const FILTROS: Array<{ value: Filtro; label: string }> = [
  { value: 'SEMAFORO', label: 'Como el Semaforo' },
  { value: 'CRITICO', label: 'Solo CRITICO' },
  { value: 'ALERTA', label: 'Solo ALERTA' },
  { value: 'NORMAL', label: 'Solo NORMAL' },
  { value: 'TODOS', label: 'Todas las urgencias' },
];

type SeccionId = 'conexion' | 'dj' | 'rectificacion';

declare global {
  interface Window {
    __UMINE_SEMAFORO_URL__?: string;
  }
}
function semaforoUrl(): string {
  const fromWindow = typeof window !== 'undefined' ? window.__UMINE_SEMAFORO_URL__ : undefined;
  return fromWindow ?? import.meta.env.VITE_SEMAFORO_URL ?? 'https://operacion.umine.com/semaforo';
}

/**
 * Filtro por nivel, comun a las tres secciones.
 *
 * `SEMAFORO` significa "lo que el Semaforo real muestra en esta seccion". En B y C eso es TODO
 * lo que llego: el backend ya aplico el gate de entrada de cada seccion y lo que no corresponde
 * ni siquiera viaja. La unica que necesita un descarte extra es A, donde el Semaforo esconde los
 * NORMAL de la tabla — y esa decision llega resuelta en `visibleEnSemaforo`.
 */
function pasaFiltro(filtro: Filtro, nivel: Nivel, visibleEnSemaforo: boolean): boolean {
  if (filtro === 'TODOS') return true;
  if (filtro === 'SEMAFORO') return visibleEnSemaforo;
  return nivel === filtro;
}

/** Cliente → OC. El Semaforo agrupa asi para poder atender todas las OCs de un cliente juntas. */
function porClienteYOc(
  a: { clientName: string; orderNumber: string },
  b: { clientName: string; orderNumber: string },
): number {
  const porCliente = a.clientName.localeCompare(b.clientName);
  if (porCliente !== 0) return porCliente;
  return a.orderNumber.localeCompare(b.orderNumber);
}

function ordenarConexion(cursos: CursoOriginal[]): CursoOriginal[] {
  // Mismo orden que la seccion A del Semaforo: cliente, OC, CRITICO antes que ALERTA, menor %.
  return [...cursos].sort((a, b) => {
    const base = porClienteYOc(a, b);
    if (base !== 0) return base;
    if (a.nivel !== b.nivel) return a.nivel === 'CRITICO' ? -1 : 1;
    return a.pctConexion - b.pctConexion;
  });
}

function ordenarDj(cursos: CursoRiesgoDj[]): CursoRiesgoDj[] {
  // Seccion B del Semaforo: cliente, OC, y dentro de eso lo que lleva mas dias cerrado primero.
  return [...cursos].sort((a, b) => {
    const base = porClienteYOc(a, b);
    if (base !== 0) return base;
    return b.diasDesdeCierre - a.diasDesdeCierre;
  });
}

function ordenarRectificacion(cursos: CursoRectificacion[]): CursoRectificacion[] {
  // Seccion C del Semaforo: solo por antiguedad. Aca lo que importa es a quien hace mas tiempo
  // que no le contestan, no de que cliente es.
  return [...cursos].sort((a, b) => b.diasPendiente - a.diasPendiente);
}

/** Vineta colapsable: el encabezado cuenta las filas y el cuerpo aparece al tocarlo. */
function Seccion({
  id,
  titulo,
  criterio,
  filas,
  abierta,
  onToggle,
  children,
}: {
  id: SeccionId;
  titulo: string;
  criterio: string;
  filas: number;
  abierta: boolean;
  onToggle: (id: SeccionId) => void;
  children: ReactNode;
}) {
  return (
    <section className="uv-seccion">
      <button
        type="button"
        className="uv-seccion__header"
        aria-expanded={abierta}
        aria-controls={`seccion-${id}`}
        onClick={() => onToggle(id)}
      >
        <span className="uv-seccion__caret" aria-hidden="true">
          {abierta ? '▼' : '▶'}
        </span>
        <span className="uv-seccion__titulo">{titulo}</span>
        <span className="uv-seccion__contador">{filas} OCs</span>
        <span className="uv-seccion__criterio">{criterio}</span>
      </button>
      {abierta ? (
        <div id={`seccion-${id}`} className="uv-seccion__cuerpo">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function SinFilas({ columnas, mensaje }: { columnas: number; mensaje: string }) {
  return (
    <tr>
      <td colSpan={columnas} className="uv-note">
        {mensaje}
      </td>
    </tr>
  );
}

export function TableroOriginal({
  data,
  cargando,
  error,
  onRecargar,
}: {
  data: TableroOriginalResponse | null;
  cargando: boolean;
  error: string | null;
  onRecargar: () => void;
}) {
  const [filtro, setFiltro] = useState<Filtro>('SEMAFORO');
  // Las tres arrancan abiertas, como en el Semaforo original.
  const [abiertas, setAbiertas] = useState<Set<SeccionId>>(
    () => new Set<SeccionId>(['conexion', 'dj', 'rectificacion']),
  );

  function toggle(id: SeccionId) {
    setAbiertas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const conexion = useMemo(() => {
    const cursos = (data?.cursos ?? []).filter((c) =>
      pasaFiltro(filtro, c.nivel, c.visibleEnSemaforo),
    );
    return ordenarConexion(cursos);
  }, [data, filtro]);

  const dj = useMemo(() => {
    const cursos = (data?.riesgoDj ?? []).filter((c) => pasaFiltro(filtro, c.nivel, true));
    return ordenarDj(cursos);
  }, [data, filtro]);

  const rectificacion = useMemo(() => {
    const cursos = (data?.rectificacion ?? []).filter((c) => pasaFiltro(filtro, c.nivel, true));
    return ordenarRectificacion(cursos);
  }, [data, filtro]);

  const vacio = data ? 'No hay OCs para este filtro.' : 'Sin datos todavia — apreta Recargar.';

  return (
    <section className="uv-panel">
      <div className="uv-panel__header">
        <h2 className="uv-panel__title">Tablero Original — dato real de tablero-api</h2>
        <div className="uv-controls">
          <label className="uv-field">
            <span className="uv-field__label">Filtro por urgencia</span>
            <select
              className="uv-select"
              value={filtro}
              onChange={(e) => setFiltro(e.target.value as Filtro)}
            >
              {FILTROS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <button className="uv-button" onClick={onRecargar} disabled={cargando}>
            {cargando ? 'Leyendo…' : 'Recargar'}
          </button>
        </div>
      </div>

      <div className="uv-banner uv-banner--info">
        <strong>Solo lectura.</strong> Esta vista no crea candidatos, ni seguimientos, ni llamadas.
        Para probar el agente, usa el Tablero Mock o el Disparador. Las secciones B y C no tienen
        camino a una llamada en ningun modo: una DJ que falta o una OC Final que no llega se
        resuelven con el OTIC, no con el alumno.
      </div>

      {error ? <div className="uv-blocked">{error}</div> : null}

      {cargando ? (
        // La primera lectura son ~6.000 registros en 3 paginas: ~22s. Decirlo evita que parezca
        // que la vista quedo colgada o vacia.
        <div className="uv-banner uv-banner--info" role="status">
          <strong>Leyendo tablero-api…</strong> La primera lectura tarda ~20-25 s: son unos 6.000
          registros reales, paginados. Las siguientes salen de cache y son instantaneas.
        </div>
      ) : null}

      {data ? (
        <>
          <p className="uv-note">
            {data.total} OCs en seccion A · {data.riesgoDj.length} en riesgo de DJ ·{' '}
            {data.rectificacion.length} en rectificacion · fuente: <code>{data.fuente}</code> ·{' '}
            <a href={semaforoUrl()} target="_blank" rel="noreferrer">
              ver el Semaforo original
            </a>
          </p>
          <p className="uv-note">
            Ultima actualizacion: {new Date(data.actualizadoAt).toLocaleString()}
            {data.desdeCache ? ' (desde cache — "Recargar" fuerza una lectura fresca)' : ''} · leida
            en {(data.duracionMs / 1000).toFixed(1)}s · {data.stats.paginas} paginas ·{' '}
            {data.stats.registrosRecibidos} registros · {data.stats.ocsAgrupadas} OCs agrupadas ·{' '}
            {data.stats.ocsSeccionA} en seccion A · {data.stats.ocsCriticas} criticas
            {data.stats.truncado ? ' · ⚠ LECTURA TRUNCADA' : ''}
          </p>
        </>
      ) : null}

      <Seccion
        id="conexion"
        titulo="A · Riesgo Conexion"
        criterio="% de conexion contra lo esperado para la semana del curso"
        filas={conexion.length}
        abierta={abiertas.has('conexion')}
        onToggle={toggle}
      >
        <div className="uv-table-wrap">
          <table className="uv-table">
            <thead>
              <tr>
                <th>Urgencia</th>
                <th>Cliente</th>
                <th>Curso</th>
                <th>OC</th>
                <th>Estado OC</th>
                <th className="uv-num">Semana</th>
                <th className="uv-num">% conexion</th>
                <th className="uv-num">Dias rest.</th>
              </tr>
            </thead>
            <tbody>
              {conexion.map((c) => (
                <tr key={`${c.clientId}#${c.orderNumber}`}>
                  <td>
                    <NivelBadge nivel={c.nivel} />
                  </td>
                  <td>{c.clientName}</td>
                  <td>{c.courseName}</td>
                  <td className="uv-mono uv-oc">{c.orderNumber}</td>
                  <td>{c.orderStatus}</td>
                  <td className="uv-num">{c.semana}</td>
                  <td className="uv-num">
                    {c.pctConexion}%
                    <br />
                    <span className="uv-note">
                      {c.conectados}/{c.inscritos}
                    </span>
                  </td>
                  <td className="uv-num">{c.diasRestantes ?? '—'}</td>
                </tr>
              ))}
              {conexion.length === 0 && !cargando ? (
                <SinFilas columnas={8} mensaje={vacio} />
              ) : null}
            </tbody>
          </table>
        </div>
      </Seccion>

      <Seccion
        id="dj"
        titulo="B · Riesgo DJ"
        criterio="dias que lleva el curso cerrado sin Declaracion Jurada completa"
        filas={dj.length}
        abierta={abiertas.has('dj')}
        onToggle={toggle}
      >
        <div className="uv-table-wrap">
          <table className="uv-table">
            <thead>
              <tr>
                <th>Urgencia</th>
                <th>Cliente</th>
                <th>Curso</th>
                <th>OC</th>
                <th>Termino</th>
                <th className="uv-num">Dias cerrado</th>
                <th className="uv-num">% DJ</th>
                <th className="uv-num">Faltan</th>
              </tr>
            </thead>
            <tbody>
              {dj.map((c) => (
                <tr key={`${c.clientId}#${c.orderNumber}`}>
                  <td>
                    <NivelBadge nivel={c.nivel} />
                  </td>
                  <td>{c.clientName}</td>
                  <td>{c.courseName}</td>
                  <td className="uv-mono uv-oc">{c.orderNumber}</td>
                  <td>{c.endCourse || '—'}</td>
                  <td className="uv-num">{c.diasDesdeCierre}</td>
                  <td className="uv-num">
                    {c.pctDj}%
                    <br />
                    {/* El denominador son los conectados, no los inscritos: se dice, para que
                        nadie lo lea como "% de alumnos". */}
                    <span className="uv-note">
                      {c.conDj}/{c.conectados} conectados
                    </span>
                  </td>
                  <td className="uv-num">{c.pendientes}</td>
                </tr>
              ))}
              {dj.length === 0 && !cargando ? <SinFilas columnas={8} mensaje={vacio} /> : null}
            </tbody>
          </table>
        </div>
      </Seccion>

      <Seccion
        id="rectificacion"
        titulo="C · Rectificacion"
        criterio="dias que lleva la OC esperando la OC Final del OTIC"
        filas={rectificacion.length}
        abierta={abiertas.has('rectificacion')}
        onToggle={toggle}
      >
        <div className="uv-table-wrap">
          <table className="uv-table">
            <thead>
              <tr>
                <th>Urgencia</th>
                <th>Cliente</th>
                <th>Curso</th>
                <th>OC</th>
                <th>Estado OC</th>
                <th>OTIC</th>
                <th className="uv-num">Dias esperando</th>
              </tr>
            </thead>
            <tbody>
              {rectificacion.map((c) => (
                <tr key={`${c.clientId}#${c.orderNumber}`}>
                  <td>
                    <NivelBadge nivel={c.nivel} />
                  </td>
                  <td>{c.clientName}</td>
                  <td>{c.courseName}</td>
                  <td className="uv-mono uv-oc">{c.orderNumber}</td>
                  <td>{c.orderStatus}</td>
                  <td>{c.otic || '—'}</td>
                  <td className="uv-num">{c.diasPendiente}</td>
                </tr>
              ))}
              {rectificacion.length === 0 && !cargando ? (
                <SinFilas columnas={7} mensaje={vacio} />
              ) : null}
            </tbody>
          </table>
        </div>
      </Seccion>

      <p className="uv-note">
        Las tres escalas son distintas y no se comparan entre si: A mide porcentaje de conexion
        contra la semana del curso, B y C miden dias. Un CRITICO de una seccion no equivale al de
        otra.
      </p>
    </section>
  );
}
