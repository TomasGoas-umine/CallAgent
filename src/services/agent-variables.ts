/**
 * agent-variables — las `dynamic_variables` que se le pasan al agente de ElevenLabs.
 *
 * Un solo lugar: las construye el call-dispatcher al originar la llamada, y las lee
 * `GET /api/tablero` para que el modal de confirmacion del micrositio muestre exactamente lo
 * que se va a enviar. Si el front las armara por su cuenta, el operador confirmaria una cosa y
 * se enviaria otra en cuanto alguien cambie el dispatcher.
 */

export interface AgentVariablesInput {
  clientName: string;
  courseName: string;
  orderNumber: string;
  motivo: string;
  /** Persona con la que espera hablar el agente (contacto del curso). */
  contactoNombre?: string | null;
  diasRestantes?: number;
  pctConexion?: number;
}

/**
 * Los nombres de las claves NO son libres: tienen que coincidir con las variables que declara
 * el agente en ElevenLabs, porque la API exige que el payload traiga TODAS las que el agente
 * usa en su prompt o primer mensaje. Si falta una, la llamada falla o el agente lee el
 * `{{placeholder}}` en voz alta.
 *
 * Agente actual ("Sence", es): nombre_interlocutor, nombre_cliente, nombre_curso,
 * dias_restantes, pct_conexion. Se mandan tambien orden_compra y motivo como extras utiles
 * (variables de sobra no molestan; las que faltan si).
 *
 * Si cambias el prompt del agente y agregas una variable, hay que agregarla ACA tambien.
 * `npm run providers:check` no lo detecta: revisalo a mano contra el panel.
 */
export function buildAgentDynamicVariables(input: AgentVariablesInput): Record<string, string> {
  return {
    nombre_interlocutor: input.contactoNombre?.trim() || 'el encargado de capacitacion',
    nombre_cliente: input.clientName,
    nombre_curso: input.courseName,
    dias_restantes: String(input.diasRestantes ?? ''),
    pct_conexion: input.pctConexion === undefined ? '' : `${Math.round(input.pctConexion)}%`,
    orden_compra: input.orderNumber,
    motivo: input.motivo,
  };
}
