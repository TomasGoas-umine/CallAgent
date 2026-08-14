/**
 * "Carga test/fixtures/tablero_search_sample.json como si fuera la fuente del Semaforo"
 * (prompt §10, punto 3).
 *
 * FixtureTableroApiClient ya lee ese JSON directamente en cada `search()` (no hace falta
 * copiarlo a Dynamo — el Semaforo real tampoco vive en nuestra base, tablero-api es una
 * fuente externa de solo lectura, ver docs/context/PROJECT_CONTEXT.md). Lo que este script
 * si necesita sembrar en Dynamo es el estado de CONTACT que el guardrail do_not_call/cooldown
 * espera encontrar YA existente para el grupo `SINT-CRITICO-DO-NOT-CALL` del fixture — ese
 * campo no existe en tablero-api real, asi que su fuente de verdad es siempre CONTACT, nunca
 * el propio dato del Semaforo (ver test/fixtures/README.md).
 */
import { ContactRepository } from '../src/repositories/contact-repository.js';
import { logger } from '../src/utils/logger.js';

// Telefono del primer alumno con telefono del grupo SINT-CRITICO-DO-NOT-CALL (representante
// que candidate-evaluator elegiria para ese grupo).
const DO_NOT_CALL_TEST_PHONE = '+56900100137';

async function main() {
  const contactRepository = new ContactRepository();
  await contactRepository.markDoNotCall(DO_NOT_CALL_TEST_PHONE);
  logger.info('seed_local_done', { doNotCallPhone: DO_NOT_CALL_TEST_PHONE });
  console.log(
    `Seed local completo: ${DO_NOT_CALL_TEST_PHONE} marcado do_not_call=true en CONTACT ` +
      '(fixture tablero_search_sample.json se lee directo por FixtureTableroApiClient, sin copiarlo a Dynamo).',
  );
}

main().catch((err) => {
  console.error('Error en seed local:', err);
  process.exit(1);
});
