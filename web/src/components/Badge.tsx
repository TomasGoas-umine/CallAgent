import type { Nivel } from '../types';

const CLASS_BY_NIVEL: Record<Nivel, string> = {
  CRITICO: 'uv-badge--critico',
  ALERTA: 'uv-badge--alerta',
  NORMAL: 'uv-badge--normal',
};

export function NivelBadge({ nivel }: { nivel: Nivel }) {
  return <span className={`uv-badge ${CLASS_BY_NIVEL[nivel]}`}>{nivel}</span>;
}

/**
 * Estados de FOLLOWUP en los que la llamada termino bien vs. estados que piden atencion.
 * Es solo presentacion: la taxonomia real vive en el backend (`call-outcome-classifier`).
 */
const ESTADOS_OK = new Set(['RESUELTO', 'CERRADO', 'RESUELTO_SIN_LLAMADA']);
const ESTADOS_ATENCION = new Set(['ESCALADO', 'AGOTADO', 'ERROR', 'BLOQUEADO']);

export function EstadoBadge({ estado }: { estado: string }) {
  const clase = ESTADOS_OK.has(estado)
    ? 'uv-badge--normal'
    : ESTADOS_ATENCION.has(estado)
      ? 'uv-badge--critico'
      : 'uv-badge--neutro';
  return <span className={`uv-badge ${clase}`}>{estado}</span>;
}
