/**
 * QuotaRepository — contador de cuota diaria de llamadas originadas.
 *
 *   QUOTA#<YYYY-MM-DD>  COUNTER  -> { usados }
 *
 * Por que existe: `guardrails.isDailyQuotaExceeded(countSoFar)` recibia el contador por
 * parametro y nadie lo calculaba desde la base — el evaluador contaba en memoria
 * (`createdToday`), asi que reiniciar el proceso reiniciaba la cuota. Con un plan Starter de
 * muy pocos minutos eso no sirve: la cuota tiene que sobrevivir reinicios y ser compartida por
 * todos los caminos que originan una llamada.
 *
 * `tryConsume` es la UNICA fuente de verdad: un `ADD` condicional (atomico) que falla si el
 * contador ya llego al limite. `peek` es solo informativo (para /api/health y para el
 * pre-chequeo de guardrails que devuelve un motivo legible antes de escribir nada).
 *
 * Se cuenta la llamada ORIGINADA, no los minutos consumidos: los minutos reales solo se
 * conocen cuando llega el webhook post-call, y hasta entonces ya se gastaron. Contar
 * originaciones es la aproximacion conservadora — una llamada que el proveedor rechaza tambien
 * consume cuota.
 */

import { BaseRepository, ConditionalCheckFailedError } from './base-repository.js';
import { businessDateKey } from '../utils/scheduling.js';

interface QuotaItem {
  PK: string;
  SK: 'COUNTER';
  usados: number;
  dateKey: string;
  updatedAt: string;
}

function quotaPk(dateKey: string): string {
  return `QUOTA#${dateKey}`;
}

export interface QuotaSnapshot {
  dateKey: string;
  usados: number;
  limite: number;
  restantes: number;
}

export interface ConsumeResult {
  ok: boolean;
  usados: number;
}

export class QuotaRepository extends BaseRepository {
  /** Lectura informativa. NO es un gate: entre el peek y el consume puede entrar otra llamada. */
  async peek(limite: number, now: Date = new Date()): Promise<QuotaSnapshot> {
    const dateKey = businessDateKey(now);
    const item = await this.getItem<QuotaItem>({ PK: quotaPk(dateKey), SK: 'COUNTER' });
    const usados = item?.usados ?? 0;
    return { dateKey, usados, limite, restantes: Math.max(0, limite - usados) };
  }

  /**
   * Consume un slot de cuota de forma atomica. Devuelve `ok: false` si ya se alcanzo el
   * limite — el llamador NO debe originar la llamada en ese caso.
   */
  async tryConsume(limite: number, now: Date = new Date()): Promise<ConsumeResult> {
    const dateKey = businessDateKey(now);
    try {
      const attributes = await this.updateItemConditionalReturning(
        { PK: quotaPk(dateKey), SK: 'COUNTER' },
        'SET dateKey = :dateKey, updatedAt = :now ADD usados :one',
        'attribute_not_exists(usados) OR usados < :limite',
        { ':one': 1, ':limite': limite, ':dateKey': dateKey, ':now': now.toISOString() },
      );
      return { ok: true, usados: Number(attributes?.usados ?? 1) };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedError) {
        const snapshot = await this.peek(limite, now);
        return { ok: false, usados: snapshot.usados };
      }
      throw err;
    }
  }

  /** Solo para tests/demo: deja el contador del dia en un valor concreto. */
  async setUsadosForTesting(usados: number, now: Date = new Date()): Promise<void> {
    const dateKey = businessDateKey(now);
    const item: QuotaItem = {
      PK: quotaPk(dateKey),
      SK: 'COUNTER',
      usados,
      dateKey,
      updatedAt: now.toISOString(),
    };
    await this.putItem(item);
  }
}
