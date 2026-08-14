/**
 * Crea la tabla single-table + GSI1/GSI2 en el DynamoDB local (dynalite en este sandbox,
 * dynamodb-local via Docker en un entorno con Docker disponible — mismo protocolo, ver
 * docker-compose.local.yml).
 */
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import { env } from '../src/utils/env.js';

async function main() {
  const client = new DynamoDBClient({
    region: env.awsRegion,
    endpoint: env.dynamodbEndpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });

  try {
    await client.send(
      new CreateTableCommand({
        TableName: env.tableName,
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
    console.log(`Tabla ${env.tableName} creada (con GSI1 y GSI2) en ${env.dynamodbEndpoint}.`);
  } catch (err) {
    if (err instanceof ResourceInUseException) {
      console.log(`Tabla ${env.tableName} ya existia — nada que hacer.`);
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error('Error creando tablas locales:', err);
  process.exit(1);
});
