import { useMemo, useState } from 'react';
import { NivelBadge } from './Badge';
import type { CursoTablero, Nivel } from '../types';

const FILTROS: Array<{ value: 'TODOS' | Nivel; label: string }> = [
  { value: 'TODOS', label: 'Todas las urgencias' },
  { value: 'CRITICO', label: 'Solo CRITICO' },
  { value: 'ALERTA', label: 'Solo ALERTA' },
  { value: 'NORMAL', label: 'Solo NORMAL' },
];

const ORDEN_NIVEL: Record<Nivel, number> = { CRITICO: 0, ALERTA: 1, NORMAL: 2 };

export function Tablero({
  cursos,
  cargando,
  onRefrescar,
}: {
  cursos: CursoTablero[];
  cargando: boolean;
  onRefrescar: () => void;
}) {
  const [filtro, setFiltro] = useState<'TODOS' | Nivel>('TODOS');

  const visibles = useMemo(() => {
    const filtrados = filtro === 'TODOS' ? cursos : cursos.filter((c) => c.nivel === filtro);
    // Lo mas urgente primero, y dentro del mismo nivel, el curso al que le queda menos tiempo.
    return [...filtrados].sort(
      (a, b) => ORDEN_NIVEL[a.nivel] - ORDEN_NIVEL[b.nivel] || a.diasRestantes - b.diasRestantes,
    );
  }, [cursos, filtro]);

  return (
    <section className="uv-panel">
      <div className="uv-panel__header">
        <h2 className="uv-panel__title">Tablero — riesgo de conexion SENCE</h2>
        <div className="uv-controls">
          <label className="uv-field">
            <span className="uv-field__label">Filtro por urgencia</span>
            <select
              className="uv-select"
              value={filtro}
              onChange={(e) => setFiltro(e.target.value as 'TODOS' | Nivel)}
            >
              {FILTROS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <button className="uv-button" onClick={onRefrescar} disabled={cargando}>
            {cargando ? 'Cargando…' : 'Refrescar'}
          </button>
        </div>
      </div>

      <p className="uv-note">
        {visibles.length} de {cursos.length} cursos. Los telefonos se muestran enmascarados: el
        numero completo nunca sale de la API.
      </p>

      <div className="uv-table-wrap">
        <table className="uv-table">
          <thead>
            <tr>
              <th>Urgencia</th>
              <th>Cliente</th>
              <th>Curso</th>
              <th>OC</th>
              <th className="uv-num">Semana</th>
              <th className="uv-num">% conexion</th>
              <th className="uv-num">Dias rest.</th>
              <th>Contacto</th>
              <th>Telefono</th>
            </tr>
          </thead>
          <tbody>
            {visibles.map((curso) => (
              <tr key={`${curso.clientId}#${curso.orderNumber}`}>
                <td>
                  <NivelBadge nivel={curso.nivel} />
                </td>
                <td>{curso.clientName}</td>
                <td>{curso.courseName}</td>
                <td className="uv-mono">{curso.orderNumber}</td>
                <td className="uv-num">{curso.semana}</td>
                <td className="uv-num">
                  {curso.pctConexion}%
                  <br />
                  <span className="uv-note">
                    {curso.conectados}/{curso.inscritos}
                  </span>
                </td>
                <td className="uv-num">{curso.diasRestantes}</td>
                <td>
                  {curso.contacto.nombre ?? '—'}
                  {curso.contacto.cargo ? (
                    <>
                      <br />
                      <span className="uv-note">{curso.contacto.cargo}</span>
                    </>
                  ) : null}
                </td>
                <td>
                  <span className="uv-mono">{curso.telefono.masked}</span>
                  {curso.telefono.doNotCall ? (
                    <>
                      <br />
                      <span className="uv-badge uv-badge--critico">NO CONTACTAR</span>
                    </>
                  ) : null}
                  {!curso.telefono.enAllowlist && curso.telefono.disponible ? (
                    <>
                      <br />
                      <span className="uv-note">fuera de allowlist</span>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {visibles.length === 0 ? (
              <tr>
                <td colSpan={9} className="uv-note">
                  No hay cursos para este filtro.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
