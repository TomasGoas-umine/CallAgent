/**
 * agent-variables — las `dynamic_variables` que se le pasan al agente de ElevenLabs.
 *
 * Un solo lugar: las construye el call-dispatcher al originar la llamada, y las lee
 * `GET /api/tablero` para que el modal de confirmacion del micrositio muestre exactamente lo
 * que se va a enviar. Si el front las armara por su cuenta, el operador confirmaria una cosa y
 * se enviaria otra en cuanto alguien cambie el dispatcher.
 */

import type { CourseEvaluation } from './course-lookup.js';

/** Usa datos del registro fresco; los fallbacks visuales del agrupador no son datos de voz. */
export function buildCourseAgentVariables(
  evaluation: CourseEvaluation,
  motivo: string,
): Record<string, string> {
  const record = evaluation.group.records[0];
  return buildAgentDynamicVariables({
    clientName: record?.client_name ?? '',
    courseName: record?.course_name ?? '',
    orderNumber: evaluation.group.orderNumber,
    motivo,
    contactoNombre: evaluation.contactoNombre,
    diasRestantes: evaluation.diasRestantes,
    pctConexion: evaluation.group.pctConexion,
    djPendientes: evaluation.dj?.pendientes,
  });
}

export interface AgentVariablesInput {
  clientName: string;
  courseName: string;
  orderNumber: string;
  motivo: string;
  /** Persona con la que espera hablar el agente (contacto del curso). */
  contactoNombre?: string | null;
  diasRestantes?: number;
  pctConexion?: number;
  djPendientes?: number;
}

/** Resumen de apertura con el curso, sin empresa ni cifras internas. */
function buildOpeningSummary(input: AgentVariablesInput): string {
  const fallback = 'estamos dando seguimiento a tu curso.';
  const course = input.courseName.trim();
  if (!course || course === 'NO_DISPONIBLE' || /\{\{|\}\}/.test(course)) return fallback;

  const days = Number.isInteger(input.diasRestantes) ? input.diasRestantes : undefined;
  if (input.motivo.trim() === 'riesgo_dj_critico') {
    return days !== undefined &&
      days < 0 &&
      Number.isInteger(input.djPendientes) &&
      input.djPendientes! > 0
      ? `aún figura pendiente hacer la declaración jurada del curso ${course}, que ya terminó.`
      : fallback;
  }
  if (
    input.motivo.trim() !== 'riesgo_conexion_critico' ||
    !Number.isFinite(input.pctConexion) ||
    input.pctConexion! < 0 ||
    input.pctConexion! >= 100
  )
    return fallback;

  if (days !== undefined && days < 0)
    return `el curso ${course} terminó y aún figura pendiente su ejecución.`;
  const pending = `aún figura pendiente la ejecución del curso ${course}`;
  if (days === 0) return `${pending} y el curso termina hoy.`;
  if (days === 1) return `${pending} y queda un día de curso.`;
  if (days !== undefined) return `${pending} y quedan ${days} días de curso.`;
  return `${pending}.`;
}

/**
 * Los nombres de las claves NO son libres: tienen que coincidir con las variables que declara
 * el agente en ElevenLabs, porque la API exige que el payload traiga TODAS las que el agente
 * usa en su prompt o primer mensaje. Si falta una, la llamada falla o el agente lee el
 * `{{placeholder}}` en voz alta.
 *
 * Agente actual ("Sence", es): nombre_interlocutor, nombre_cliente, nombre_curso,
 * dias_restantes, pct_conexion, dj_pendientes, orden_compra, motivo y resumen_seguimiento. La configuración versionable vive en
 * scripts/lib/sence-agent-config.ts; el test de contrato verifica que ambas partes coincidan.
 *
 * Si cambias el prompt del agente y agregas una variable, hay que agregarla ACA tambien.
 * `npm run agent:check` contrasta este contrato con el agente remoto sin llamar.
 */
export function buildAgentDynamicVariables(input: AgentVariablesInput): Record<string, string> {
  return {
    nombre_interlocutor: input.contactoNombre?.trim() || 'responsable de capacitación',
    nombre_cliente: input.clientName.trim(),
    nombre_curso: input.courseName.trim(),
    dias_restantes: Number.isFinite(input.diasRestantes) ? String(input.diasRestantes) : '',
    // No redondear a entero: 99.6% no es conexión completa y 12.5% debe conservarse.
    pct_conexion:
      input.pctConexion !== undefined &&
      Number.isFinite(input.pctConexion) &&
      input.pctConexion >= 0 &&
      input.pctConexion <= 100
        ? `${input.pctConexion === 100 ? 100 : Math.min(99.999999, Number(input.pctConexion.toFixed(6)))}%`
        : '',
    dj_pendientes:
      Number.isInteger(input.djPendientes) && input.djPendientes! >= 0
        ? String(input.djPendientes)
        : '',
    orden_compra: input.orderNumber.trim(),
    motivo: input.motivo.trim(),
    resumen_seguimiento: buildOpeningSummary(input),
  };
}
