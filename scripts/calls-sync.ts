/**
 * calls:sync — trae el resultado de las llamadas desde la API de ElevenLabs a la base local.
 *
 *   npm run calls:sync                                  # todas las del agente configurado
 *   npm run calls:sync -- --since=2026-09-01            # solo desde esa fecha
 *   npm run calls:sync -- --max=20                      # tope de conversaciones a revisar
 *   npm run calls:sync -- --conversation-id=conv_x --followup-id=<uuid>   # atribucion manual
 *
 * Solo hace GET contra ElevenLabs: NO origina ninguna llamada, no gasta minutos y se puede
 * re-correr las veces que haga falta (es idempotente por conversation_id).
 *
 * Necesita unicamente ELEVENLABS_API_KEY — ni URL publica, ni tunel, ni webhook registrado.
 */

import {
  syncConversations,
  syncConversacionForzada,
  type SyncItemResult,
} from '../src/services/conversation-sync.js';
import { buildConversationsClient } from '../src/services/elevenlabs-conversations-client.js';
import { env } from '../src/utils/env.js';

const verde = (s: string) => `\x1b[32m${s}\x1b[0m`;
const rojo = (s: string) => `\x1b[31m${s}\x1b[0m`;
const amarillo = (s: string) => `\x1b[33m${s}\x1b[0m`;
const gris = (s: string) => `\x1b[2m${s}\x1b[0m`;

const COLOR_POR_ESTADO: Record<SyncItemResult['estado'], (s: string) => string> = {
  registrada: verde,
  ya_registrada: gris,
  no_final: gris,
  no_atribuible: amarillo,
  error: rojo,
};

function flag(nombre: string): string | null {
  const encontrado = process.argv.slice(2).find((a) => a.startsWith(`--${nombre}=`));
  return encontrado ? encontrado.slice(nombre.length + 3) : null;
}

function parseSince(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const fecha = new Date(raw);
  if (Number.isNaN(fecha.getTime())) {
    console.error(`--since="${raw}" no es una fecha valida (usa YYYY-MM-DD).`);
    process.exit(1);
  }
  return Math.floor(fecha.getTime() / 1000);
}

function imprimirItem(item: SyncItemResult): void {
  const color = COLOR_POR_ESTADO[item.estado];
  const cuando = item.startedAt
    ? item.startedAt.slice(0, 16).replace('T', ' ')
    : '                ';
  const dur =
    item.durationSeconds === null || item.durationSeconds === undefined
      ? '    '
      : `${String(item.durationSeconds).padStart(3)}s`;
  const detalle = [
    item.outcome ? `outcome=${item.outcome}` : null,
    item.followupId ? `followup=${item.followupId.slice(0, 8)}` : null,
    item.via ? `via=${item.via}` : null,
    item.motivo,
  ]
    .filter(Boolean)
    .join('  ');
  console.log(
    `  ${color(item.estado.padEnd(14))} ${item.conversationId.slice(0, 30).padEnd(30)} ` +
      `${cuando} ${dur}  ${detalle}`,
  );
}

async function main(): Promise<void> {
  console.log('== Umine Voice — sincronizacion de resultados de llamada ==');
  console.log('Solo lecturas contra ElevenLabs. No origina ninguna llamada.\n');

  if (!env.elevenlabsApiKey) {
    console.error('ELEVENLABS_API_KEY vacia: es lo unico que necesita este comando.');
    process.exit(1);
  }
  const conversationsClient = buildConversationsClient(env.elevenlabsApiKey);

  const conversationId = flag('conversation-id');
  const followupId = flag('followup-id');

  if (conversationId || followupId) {
    if (!conversationId || !followupId) {
      console.error('La atribucion manual necesita --conversation-id Y --followup-id.');
      process.exit(1);
    }
    console.log(`Atribucion manual: ${conversationId} -> followup ${followupId}\n`);
    const item = await syncConversacionForzada(conversationId, followupId, {
      conversationsClient,
    });
    imprimirItem(item);
    process.exitCode = item.estado === 'error' ? 1 : 0;
    return;
  }

  if (!env.elevenlabsAgentId) {
    console.log(
      amarillo(
        '  AVISO: ELEVENLABS_AGENT_ID vacia — se van a revisar las conversaciones de TODOS los ' +
          'agentes de la cuenta.\n',
      ),
    );
  }

  const summary = await syncConversations(
    {
      agentId: env.elevenlabsAgentId || undefined,
      sinceUnixSecs: parseSince(flag('since')),
      maxConversaciones: flag('max') ? Number(flag('max')) : undefined,
    },
    { conversationsClient },
  );

  for (const item of summary.items) imprimirItem(item);

  console.log('\n== Resumen ==');
  console.log(`  revisadas:      ${summary.total}`);
  console.log(
    `  ${verde('registradas')}:    ${summary.registradas}   (resultados nuevos en la base)`,
  );
  console.log(`  ya registradas: ${summary.yaRegistradas}`);
  console.log(`  aun en curso:   ${summary.noFinales}`);
  console.log(`  no atribuibles: ${summary.noAtribuibles}`);
  console.log(`  errores:        ${summary.errores}`);

  if (summary.noAtribuibles > 0) {
    console.log(
      gris(
        '\n  Las no atribuibles son conversaciones que este proyecto no origino (pruebas desde\n' +
          '  el panel de ElevenLabs) o que se hicieron antes de que el dispatcher empezara a\n' +
          '  mandar el followup_id. No se tocan a proposito. Si sabes a que seguimiento\n' +
          '  pertenece una, atribuila a mano:\n' +
          '    npm run calls:sync -- --conversation-id=<conv> --followup-id=<uuid>',
      ),
    );
  }
  if (summary.errores > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nLa sincronizacion fallo de forma inesperada:', err);
  process.exit(1);
});
