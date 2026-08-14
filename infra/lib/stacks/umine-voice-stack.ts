/**
 * Stack CDK v2 de Umine Voice — esqueleto listo para la fase de despliegue (NO desplegado ni
 * sintetizado contra una cuenta AWS real en esta sesion, regla no negociable del prompt §1.6).
 *
 * Sigue el patron del boilerplate de Umine: tabla -> Lambda factory -> rutas API GW -> IAM.
 * No se copio codigo literal de `umine-core-ms-dhl` (no disponible en este filesystem) — se
 * aplica el patron ya auditado en una sesion anterior (ver docs/architecture/DECISIONS.md ADR-002).
 */

import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';

export class UmineVoiceStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- Tabla single-table (ver prompt §8 + docs/architecture/ARCHITECTURE.md) ---
    const table = new dynamodb.Table(this, 'UmineVoiceTable', {
      tableName: 'umine-voice',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN, // nunca DESTROY en un stack con datos de seguimiento reales
      timeToLiveAttribute: 'ttl',
    });

    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // --- Cola FIFO (reemplaza la cola en memoria del MVP local, ver ADR-005) ---
    const followupQueue = new sqs.Queue(this, 'FollowupQueue', {
      queueName: 'umine-voice-followups.fifo',
      fifo: true,
      contentBasedDeduplication: false, // se dedupe por idempotency_key, no por contenido
      visibilityTimeout: Duration.minutes(5),
    });

    // --- Lambda factory (patron del boilerplate: mismos defaults para las 4 funciones) ---
    const lambdaDefaults: Partial<lambda.FunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X, // TODO: subir a NODEJS_LATEST/ARM64 cuando el runtime Node 24 este disponible en Lambda
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
        NODE_ENV: 'production',
        MOCK_PROVIDERS: 'false', // en AWS real, nunca mock — pero requiere allowlist no vacia igual
      },
    };

    function makeFunction(scope: Construct, id: string, handlerPath: string): lambda.Function {
      return new lambda.Function(scope, id, {
        ...lambdaDefaults,
        functionName: `umine-voice-${id.toLowerCase()}`,
        code: lambda.Code.fromAsset('dist'), // placeholder — el build real empaqueta cada handler
        handler: handlerPath,
      } as lambda.FunctionProps);
    }

    const candidateEvaluatorFn = makeFunction(
      this,
      'CandidateEvaluator',
      'handlers/candidate-evaluator/handler.handler',
    );
    const callDispatcherFn = makeFunction(
      this,
      'CallDispatcher',
      'handlers/call-dispatcher/handler.handler',
    );
    const elevenLabsWebhookFn = makeFunction(
      this,
      'ElevenLabsPostCallWebhook',
      'handlers/webhooks/elevenlabs-post-call/handler.handler',
    );
    const twilioStatusWebhookFn = makeFunction(
      this,
      'TwilioStatusWebhook',
      'handlers/webhooks/twilio-status/handler.handler',
    );

    // --- IAM: cada Lambda solo lo que necesita (patron least-privilege del boilerplate) ---
    table.grantReadWriteData(candidateEvaluatorFn);
    table.grantReadData(candidateEvaluatorFn); // lectura explicita adicional para claridad de intent
    table.grantReadWriteData(callDispatcherFn);
    table.grantReadWriteData(elevenLabsWebhookFn);
    table.grantReadData(twilioStatusWebhookFn);
    followupQueue.grantSendMessages(candidateEvaluatorFn);
    followupQueue.grantConsumeMessages(callDispatcherFn);

    // --- Cron (EventBridge) — dias habiles 09:00 y 15:00 America/Santiago (ver flujo-1) ---
    new events.Rule(this, 'EvaluatorSchedule', {
      schedule: events.Schedule.expression('cron(0 13,19 ? * MON-FRI *)'), // 09:00/15:00 CLT en UTC (aprox., sin horario de verano)
      targets: [new eventsTargets.LambdaFunction(candidateEvaluatorFn)],
    });

    // --- API Gateway HTTP v2: solo expone los webhooks publicos ---
    const httpApi = new apigwv2.HttpApi(this, 'UmineVoiceHttpApi', {
      apiName: 'umine-voice',
    });

    httpApi.addRoutes({
      path: '/webhooks/elevenlabs/post-call',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        'ElevenLabsWebhookIntegration',
        elevenLabsWebhookFn,
      ),
    });

    httpApi.addRoutes({
      path: '/webhooks/twilio/status',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        'TwilioStatusWebhookIntegration',
        twilioStatusWebhookFn,
      ),
    });
  }
}
