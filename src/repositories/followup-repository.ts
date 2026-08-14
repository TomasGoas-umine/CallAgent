/**
 * FollowupRepository — persistencia de FOLLOWUP y sus CALL asociadas.
 * Modelo single-table, ver prompt §8 y docs/architecture/ARCHITECTURE.md.
 *
 *   FOLLOWUP#<id>   META                    -> el Followup completo
 *   FOLLOWUP#<id>   CALL#<conversation_id>  -> FollowupCall (una por intento de llamada)
 *
 *   GSI1: GSI1PK=ESTADO#<estado>      GSI1SK=<next_attempt_at>   -> "que toca llamar ahora"
 *   GSI2: GSI2PK=DEST#<destinatario>  GSI2SK=<created_at>        -> "no llamar 2 veces al mismo en cooldown"
 */

import { BaseRepository, ConditionalCheckFailedError } from './base-repository.js';
import type { Followup, FollowupCall, FollowupEstado } from '../domain/followup.js';

interface FollowupItem extends Followup {
  PK: string;
  SK: 'META';
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK: string;
  GSI2SK: string;
}

interface FollowupCallItem extends FollowupCall {
  PK: string;
  SK: string;
}

function followupPk(followupId: string): string {
  return `FOLLOWUP#${followupId}`;
}

function conversationPk(conversationId: string): string {
  return `CONVERSATION#${conversationId}`;
}

interface ConversationLinkItem {
  PK: string;
  SK: 'META';
  followupId: string;
}

function toItem(f: Followup): FollowupItem {
  return {
    ...f,
    PK: followupPk(f.followupId),
    SK: 'META',
    GSI1PK: `ESTADO#${f.estado}`,
    GSI1SK: f.nextAttemptAt ?? f.createdAt,
    GSI2PK: `DEST#${f.destinatarioPhone}`,
    GSI2SK: f.createdAt,
  };
}

export class FollowupRepository extends BaseRepository {
  /** Crea el FOLLOWUP con estado inicial READY. Falla si ya existe ese followupId (anti duplicado). */
  async create(followup: Followup): Promise<void> {
    const item = toItem(followup);
    await this.putItemConditional(item, 'attribute_not_exists(PK)');
  }

  async getById(followupId: string): Promise<Followup | null> {
    const item = await this.getItem<FollowupItem>({ PK: followupPk(followupId), SK: 'META' });
    return item;
  }

  /**
   * Transicion READY -> DIALING con escritura condicional (anti doble disparo, prompt §5.3).
   * Lanza ConditionalCheckFailedError si el estado ya no era READY (ya lo tomo otro worker,
   * o ya fue procesado).
   */
  async markDialing(followupId: string): Promise<void> {
    await this.updateItemConditional(
      { PK: followupPk(followupId), SK: 'META' },
      'SET estado = :dialing, updatedAt = :now, GSI1PK = :gsi1pk',
      'estado = :ready',
      {
        ':dialing': 'DIALING',
        ':ready': 'READY',
        ':now': new Date().toISOString(),
        ':gsi1pk': 'ESTADO#DIALING',
      },
    );
  }

  /** Transicion generica de estado (para cierres tras procesar el resultado de la llamada). */
  async setEstado(
    followupId: string,
    estado: FollowupEstado,
    extra: Partial<Pick<Followup, 'intentos' | 'nextAttemptAt'>> = {},
  ): Promise<void> {
    const sets: string[] = ['estado = :estado', 'updatedAt = :now', 'GSI1PK = :gsi1pk'];
    const values: Record<string, unknown> = {
      ':estado': estado,
      ':now': new Date().toISOString(),
      ':gsi1pk': `ESTADO#${estado}`,
    };
    if (extra.intentos !== undefined) {
      sets.push('intentos = :intentos');
      values[':intentos'] = extra.intentos;
    }
    if (extra.nextAttemptAt !== undefined) {
      sets.push('nextAttemptAt = :nextAttemptAt', 'GSI1SK = :gsi1sk');
      values[':nextAttemptAt'] = extra.nextAttemptAt;
      values[':gsi1sk'] = extra.nextAttemptAt ?? new Date().toISOString();
    }
    await this.updateItem(
      { PK: followupPk(followupId), SK: 'META' },
      `SET ${sets.join(', ')}`,
      values,
    );
  }

  /** Registra el resultado de un intento de llamada. Idempotente por conversation_id (SK unico). */
  async recordCall(call: FollowupCall): Promise<'created' | 'already_exists'> {
    const item: FollowupCallItem = {
      ...call,
      PK: followupPk(call.followupId),
      SK: `CALL#${call.conversationId}`,
    };
    try {
      await this.putItemConditional(item, 'attribute_not_exists(PK) AND attribute_not_exists(SK)');
      return 'created';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedError) return 'already_exists';
      throw err;
    }
  }

  async getCall(followupId: string, conversationId: string): Promise<FollowupCall | null> {
    return this.getItem<FollowupCallItem>({
      PK: followupPk(followupId),
      SK: `CALL#${conversationId}`,
    });
  }

  /** GSI1: followups listos para marcar/reintentar, cuyo next_attempt_at ya paso. */
  async findReadyForDispatch(estado: FollowupEstado, upToIso: string): Promise<Followup[]> {
    return this.query<FollowupItem>({
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK <= :now',
      ExpressionAttributeValues: { ':pk': `ESTADO#${estado}`, ':now': upToIso },
    });
  }

  /** GSI2: followups recientes hacia el mismo destinatario (para el guardrail de cooldown). */
  async findRecentByDestinatario(destinatarioPhone: string, sinceIso: string): Promise<Followup[]> {
    return this.query<FollowupItem>({
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK >= :since',
      ExpressionAttributeValues: { ':pk': `DEST#${destinatarioPhone}`, ':since': sinceIso },
    });
  }

  /**
   * El webhook post-call de ElevenLabs solo trae `conversation_id`, no nuestro followupId
   * interno (prompt §5.4 no lo modela explicitamente, pero es indispensable para poder
   * correlacionar el webhook con el FOLLOWUP correcto). Se guarda este mapeo en el momento
   * en que el dispatcher dispara la llamada con exito (item CONVERSATION#<id> META).
   */
  async linkConversation(conversationId: string, followupId: string): Promise<void> {
    const item: ConversationLinkItem = {
      PK: conversationPk(conversationId),
      SK: 'META',
      followupId,
    };
    await this.putItemConditional(item, 'attribute_not_exists(PK)');
  }

  async findFollowupIdByConversation(conversationId: string): Promise<string | null> {
    const item = await this.getItem<ConversationLinkItem>({
      PK: conversationPk(conversationId),
      SK: 'META',
    });
    return item?.followupId ?? null;
  }
}
