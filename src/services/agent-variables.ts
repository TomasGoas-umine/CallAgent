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

/**
 * Los nombres de las claves NO son libres: tienen que coincidir con las variables que declara
 * el agente en ElevenLabs, porque la API exige que el payload traiga TODAS las que el agente
 * usa en su prompt o primer mensaje. Si falta una, la llamada falla o el agente lee el
 * `{{placeholder}}` en voz alta.
 *
 * Agente actual ("Sence", es): nombre_interlocutor, nombre_cliente, nombre_curso,
 * dias_restantes, pct_conexion, dj_pendientes, orden_compra y motivo. La configuración versionable vive en
 * scripts/lib/sence-agent-config.ts; el test de contrato verifica que ambas partes coincidan.
 *
 * Si cambias el prompt del agente y agregas una variable, hay que agregarla ACA tambien.
 * `npm run agent:check` contrasta este contrato con el agente remoto sin llamar.
 */
export function buildAgentDynamicVariables(input: AgentVariablesInput): Record<string, string> {
  return {
    nombre_interlocutor: input.contactoNombre?.trim() || 'el encargado de capacitacion',
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
  };
}
