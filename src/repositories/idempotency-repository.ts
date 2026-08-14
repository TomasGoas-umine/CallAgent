/**
 * IdempotencyRepository — IDEMP#<key> LOCK, ver prompt §8.
 *
 * Usado en dos puntos distintos del flujo (misma pieza, dos llaves distintas):
 *  1. candidate-evaluator: idempotency_key = sha256(destinatario+motivo+order_number+ventana_semanal)
 *     -> evita crear dos FOLLOWUP para el mismo caso en la misma semana.
 *  2. webhooks/elevenlabs-post-call: conversation_id -> evita procesar el mismo webhook dos veces
 *     (ElevenLabs puede reintentar la entrega).
 *
 * `attribute_not_exists(PK)` es la unica fuente de verdad de "ya fue procesado" — no se confia
 * en headers de idempotencia del lado del cliente.
 */

import { BaseRepository, ConditionalCheckFailedError } from './base-repository.js';

interface IdempotencyItem {
  PK: string;
  SK: 'LOCK';
  followupId: string;
  ttl: number;
  createdAt: string;
}

function idempotencyPk(key: string): string {
  return `IDEMP#${key}`;
}

export class IdempotencyRepository extends BaseRepository {
  /**
   * Intenta adquirir el lock. Devuelve true si se adquirio (primera vez que se ve esta key),
   * false si ya existia (procesamiento duplicado — el llamador debe hacer no-op).
   */
  async tryAcquireLock(
    key: string,
    followupId: string,
    ttlSeconds = 60 * 60 * 24 * 30,
  ): Promise<boolean> {
    const nowSec = Math.floor(Date.now() / 1000);
    const item: IdempotencyItem = {
      PK: idempotencyPk(key),
      SK: 'LOCK',
      followupId,
      ttl: nowSec + ttlSeconds,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.putItemConditional(item, 'attribute_not_exists(PK)');
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedError) return false;
      throw err;
    }
  }

  async get(key: string): Promise<{ followupId: string } | null> {
    const item = await this.getItem<IdempotencyItem>({ PK: idempotencyPk(key), SK: 'LOCK' });
    return item ? { followupId: item.followupId } : null;
  }
}
