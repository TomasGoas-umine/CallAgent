/**
 * Cola de FOLLOWUPs listos para llamar.
 *
 * Decision documentada (ver CLAUDE.md / docs/architecture/DECISIONS.md ADR-005): para el MVP
 * local se eligio una cola EN MEMORIA en vez de SQS FIFO + ElasticMQ. En local/tests el flujo
 * evaluator -> dispatcher se ejecuta de forma secuencial en el mismo proceso (o via el server
 * Fastify), asi que una cola real con Docker adicional no aporta valor de prueba y si aporta
 * una dependencia extra que este sandbox no puede levantar (no hay Docker disponible). El
 * MessageGroupId real de SQS FIFO (destinatario, ver BPMN flujo-1) se modela igual aqui para
 * que el contrato sea el mismo si mas adelante se reemplaza por SQS real.
 */

export interface QueueMessage {
  followupId: string;
  messageGroupId: string;
  enqueuedAt: string;
}

export interface QueueClient {
  publish(message: Omit<QueueMessage, 'enqueuedAt'>): Promise<void>;
  /** Sin importar el groupId — FIFO simple, saca el primero encolado. */
  receive(): Promise<QueueMessage | null>;
  size(): number;
}

export class InMemoryQueueClient implements QueueClient {
  private readonly messages: QueueMessage[] = [];

  async publish(message: Omit<QueueMessage, 'enqueuedAt'>): Promise<void> {
    this.messages.push({ ...message, enqueuedAt: new Date().toISOString() });
  }

  async receive(): Promise<QueueMessage | null> {
    return this.messages.shift() ?? null;
  }

  size(): number {
    return this.messages.length;
  }
}

/** Instancia compartida por proceso — usada por src/local/server.ts para pasar mensajes entre
 *  el endpoint del evaluador y el del dispatcher dentro del mismo server local. */
export const sharedLocalQueue = new InMemoryQueueClient();
