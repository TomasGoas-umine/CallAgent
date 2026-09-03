/**
 * base-repository — patron generico sobre DynamoDBDocumentClient, adaptado del patron
 * estructural de `base-repository.ts` en umine-core-ms-dhl (ver docs/architecture/DECISIONS.md
 * ADR-002): single-table, PK/SK, escrituras condicionales explicitas, GSIs por query.
 *
 * No copia logica de dominio de DHL — solo la forma del wrapper (get/put condicional/query/update).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';

export interface DynamoKey {
  PK: string;
  SK: string;
}

export class ConditionalCheckFailedError extends Error {
  constructor(message = 'Condicion de escritura no se cumplio (concurrencia o duplicado)') {
    super(message);
    this.name = 'ConditionalCheckFailedError';
  }
}

let sharedClient: DynamoDBDocumentClient | undefined;

function buildDefaultClient(): DynamoDBDocumentClient {
  const isLocal = env.nodeEnv === 'local' || env.nodeEnv === 'test';
  const ddb = new DynamoDBClient({
    region: env.awsRegion,
    ...(isLocal
      ? {
          endpoint: env.dynamodbEndpoint,
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }
      : {}),
  });
  return DynamoDBDocumentClient.from(ddb, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export abstract class BaseRepository {
  protected readonly doc: DynamoDBDocumentClient;
  protected readonly tableName: string;

  constructor(tableName: string = env.tableName, client?: DynamoDBDocumentClient) {
    this.tableName = tableName;
    this.doc = client ?? (sharedClient ??= buildDefaultClient());
  }

  protected async getItem<T>(key: DynamoKey): Promise<T | null> {
    const result = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: key }));
    return (result.Item as T | undefined) ?? null;
  }

  /** Put simple, sin condicion — usar solo cuando sobrescribir es intencional (ej. upsert de CONTACT). */
  protected async putItem<T extends object>(item: T): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: item as Record<string, unknown> }),
    );
  }

  /**
   * Put condicional — la base de la idempotencia en todo el proyecto (prompt §1.5).
   * Lanza ConditionalCheckFailedError si la condicion no se cumple (ej. attribute_not_exists(PK)).
   */
  protected async putItemConditional<T extends object>(
    item: T,
    conditionExpression: string,
    expressionAttributeValues?: Record<string, unknown>,
    expressionAttributeNames?: Record<string, string>,
  ): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item as Record<string, unknown>,
          ConditionExpression: conditionExpression,
          ExpressionAttributeValues: expressionAttributeValues,
          ExpressionAttributeNames: expressionAttributeNames,
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw new ConditionalCheckFailedError();
      }
      logger.error('dynamo_put_conditional_failed', { error: String(err) });
      throw err;
    }
  }

  /** Update sin condicion — usar solo para transiciones que no requieren anti-concurrencia. */
  protected async updateItem(
    key: DynamoKey,
    updateExpression: string,
    expressionAttributeValues: Record<string, unknown>,
    expressionAttributeNames?: Record<string, string>,
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ExpressionAttributeNames: expressionAttributeNames,
      }),
    );
  }

  protected async updateItemConditional(
    key: DynamoKey,
    updateExpression: string,
    conditionExpression: string,
    expressionAttributeValues: Record<string, unknown>,
    expressionAttributeNames?: Record<string, string>,
  ): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: updateExpression,
          ConditionExpression: conditionExpression,
          ExpressionAttributeValues: expressionAttributeValues,
          ExpressionAttributeNames: expressionAttributeNames,
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw new ConditionalCheckFailedError();
      }
      throw err;
    }
  }

  /**
   * Igual que `updateItemConditional`, pero devuelve los atributos actualizados
   * (`ReturnValues: 'UPDATED_NEW'`). Necesario para contadores atomicos (`ADD`), donde el
   * valor resultante es justamente lo que el llamador necesita saber.
   */
  protected async updateItemConditionalReturning(
    key: DynamoKey,
    updateExpression: string,
    conditionExpression: string,
    expressionAttributeValues: Record<string, unknown>,
    expressionAttributeNames?: Record<string, string>,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const result = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: updateExpression,
          ConditionExpression: conditionExpression,
          ExpressionAttributeValues: expressionAttributeValues,
          ExpressionAttributeNames: expressionAttributeNames,
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return result.Attributes;
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw new ConditionalCheckFailedError();
      }
      throw err;
    }
  }

  protected async query<T>(params: Omit<QueryCommandInput, 'TableName'>): Promise<T[]> {
    const result = await this.doc.send(new QueryCommand({ TableName: this.tableName, ...params }));
    return (result.Items as T[] | undefined) ?? [];
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}
