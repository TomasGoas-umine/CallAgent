/**
 * Harness compartido para tests de integracion: levanta dynalite en memoria y crea la tabla
 * single-table + GSI1/GSI2 (mismo esquema que scripts/create-local-tables.ts). Evita repetir
 * el boilerplate de CreateTableCommand en cada archivo de test.
 *
 * `startDynamoTestHarness` levanta el SERVIDOR una sola vez (costoso); `createTestTable`
 * crea una tabla nueva y unica dentro de ese mismo servidor (barato), para que cada test
 * pueda pedir una tabla propia y no arrastrar estado de otros tests que corren en el mismo
 * archivo (evita falsos positivos/negativos por contaminacion entre tests).
 */
import dynalite from 'dynalite';
import type { Server } from 'node:http';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface DynamoServerHarness {
  server: Server;
  client: DynamoDBClient;
  doc: DynamoDBDocumentClient;
  stop: () => Promise<void>;
}

export interface DynamoTestHarness extends DynamoServerHarness {
  tableName: string;
}

export async function startDynamoServerHarness(): Promise<DynamoServerHarness> {
  const server = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const client = new DynamoDBClient({
    region: 'us-east-1',
    endpoint: `http://localhost:${port}`,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const doc = DynamoDBDocumentClient.from(client);

  return {
    server,
    client,
    doc,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function createTestTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
        { AttributeName: 'GSI2PK', AttributeType: 'S' },
        { AttributeName: 'GSI2SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
}

/** Conveniencia: levanta servidor + una tabla, todo en un solo llamado (usado por archivos
 *  de test que no necesitan aislar tablas por-test, ej. repositories.spec.ts). */
export async function startDynamoTestHarness(tableName: string): Promise<DynamoTestHarness> {
  const serverHarness = await startDynamoServerHarness();
  await createTestTable(serverHarness.client, tableName);
  return { ...serverHarness, tableName };
}
