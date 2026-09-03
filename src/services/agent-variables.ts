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
}

export function buildAgentDynamicVariables(input: AgentVariablesInput): Record<string, string> {
  return {
    nombre_cliente: input.clientName,
    curso: input.courseName,
    orden_compra: input.orderNumber,
    motivo: input.motivo,
  };
}
