/**
 * Referencia de "ahora" usada para disenar las fechas de los grupos SINTETICOS de
 * tablero_search_sample.json (ver test/fixtures/README.md). Los tests que verifican
 * clasificacion de urgencia contra el fixture deben pinear el reloj a este valor con
 * vi.setSystemTime para ser deterministas sin importar cuando se corran en el futuro.
 */
export const FIXTURE_REFERENCE_NOW = '2026-08-13T16:00:00.000Z';
