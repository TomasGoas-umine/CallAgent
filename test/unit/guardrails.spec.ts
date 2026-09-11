import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function freshGuardrails() {
  vi.resetModules();
  return import('../../src/services/guardrails.js');
}

describe('guardrails', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.TIMEZONE = 'America/Santiago';
    process.env.BUSINESS_HOURS_START = '09:00';
    process.env.BUSINESS_HOURS_END = '19:00';
    process.env.DAILY_QUOTA = '5';
    process.env.ALLOWLIST_NUMBERS = '+56900000001,+56900000002';
    // La whitelist dura de la etapa de pruebas se abre explicitamente para los numeros
    // sinteticos de esta suite; su default (solo el numero real de pruebas) se prueba aparte.
    process.env.TEST_PHONE_WHITELIST = '+56900000001,+56900000002';
    process.env.KILL_SWITCH = 'false';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
  });

  it('isWithinBusinessHours: true un martes a las 12:00 hora de Santiago', async () => {
    const { isWithinBusinessHours } = await freshGuardrails();
    // 2026-08-11 es martes. 12:00 Santiago (UTC-4 en agosto, sin horario de verano en Chile
    // continental desde 2019) = 16:00 UTC.
    const tuesdayNoonSantiago = new Date('2026-08-11T16:00:00.000Z');
    expect(isWithinBusinessHours(tuesdayNoonSantiago)).toBe(true);
  });

  it('isWithinBusinessHours: false un sabado', async () => {
    const { isWithinBusinessHours } = await freshGuardrails();
    const saturdayNoonSantiago = new Date('2026-08-15T16:00:00.000Z');
    expect(isWithinBusinessHours(saturdayNoonSantiago)).toBe(false);
  });

  it('isWithinBusinessHours: false antes de las 09:00 o despues de las 19:00', async () => {
    const { isWithinBusinessHours } = await freshGuardrails();
    const earlyMorning = new Date('2026-08-11T11:00:00.000Z'); // 07:00 Santiago
    const lateNight = new Date('2026-08-11T23:30:00.000Z'); // 19:30 Santiago
    expect(isWithinBusinessHours(earlyMorning)).toBe(false);
    expect(isWithinBusinessHours(lateNight)).toBe(false);
  });

  it('isNumberAllowed: false si la allowlist esta vacia (nunca por omision)', async () => {
    process.env.ALLOWLIST_NUMBERS = '';
    const { isNumberAllowed } = await freshGuardrails();
    expect(isNumberAllowed('+56900000001')).toBe(false);
  });

  it('isNumberAllowed: true solo para numeros explicitamente en la allowlist', async () => {
    const { isNumberAllowed } = await freshGuardrails();
    expect(isNumberAllowed('+56900000001')).toBe(true);
    expect(isNumberAllowed('+56999999999')).toBe(false);
  });

  it('isDailyQuotaExceeded respeta DAILY_QUOTA', async () => {
    const { isDailyQuotaExceeded } = await freshGuardrails();
    expect(isDailyQuotaExceeded(4)).toBe(false);
    expect(isDailyQuotaExceeded(5)).toBe(true);
  });

  it('isKillSwitchActive refleja KILL_SWITCH', async () => {
    process.env.KILL_SWITCH = 'true';
    const { isKillSwitchActive } = await freshGuardrails();
    expect(isKillSwitchActive()).toBe(true);
  });

  it('runGuardrails: kill switch bloquea todo el flujo antes que cualquier otra regla', async () => {
    process.env.KILL_SWITCH = 'true';
    const { runGuardrails } = await freshGuardrails();
    const result = runGuardrails('+56900000001', { now: new Date('2026-08-11T16:00:00.000Z') });
    expect(result).toEqual({ allowed: false, motivo: 'kill_switch' });
  });

  it('runGuardrails: numero fuera de la allowlist se bloquea', async () => {
    const { runGuardrails } = await freshGuardrails();
    const result = runGuardrails('+56999999999', { now: new Date('2026-08-11T16:00:00.000Z') });
    expect(result).toEqual({ allowed: false, motivo: 'no_en_allowlist' });
  });

  it('runGuardrails: cuota diaria alcanzada bloquea', async () => {
    const { runGuardrails } = await freshGuardrails();
    const result = runGuardrails('+56900000001', {
      now: new Date('2026-08-11T16:00:00.000Z'),
      dailyCountSoFar: 5,
    });
    expect(result).toEqual({ allowed: false, motivo: 'cuota_diaria_alcanzada' });
  });

  it('runGuardrails: todo en regla -> allowed true', async () => {
    const { runGuardrails } = await freshGuardrails();
    const result = runGuardrails('+56900000001', {
      now: new Date('2026-08-11T16:00:00.000Z'),
      dailyCountSoFar: 0,
    });
    expect(result).toEqual({ allowed: true });
  });
});

describe('whitelist dura de la etapa de pruebas', () => {
  it('por defecto (sin env) solo autoriza los numeros de pruebas de la etapa', async () => {
    // Sin TEST_PHONE_WHITELIST seteada: es lo que corre en un entorno real.
    delete process.env.TEST_PHONE_WHITELIST;
    const { isPhoneInTestWhitelist, MOCK_TEST_PHONE, MOCK_TEST_PHONES, esTelefonoDelMock } =
      await freshGuardrails();
    // La lista es cerrada y esta fijada aca a proposito: ampliarla es una decision explicita
    // (CLAUDE.md regla 0-bis), no algo que se cuele en un refactor.
    expect(MOCK_TEST_PHONES).toEqual(['+56956194817', '+56955326503']);
    expect(MOCK_TEST_PHONE).toBe('+56956194817');
    for (const phone of MOCK_TEST_PHONES) {
      expect(isPhoneInTestWhitelist(phone)).toBe(true);
      expect(esTelefonoDelMock(phone)).toBe(true);
    }
    expect(isPhoneInTestWhitelist('+56911112222')).toBe(false);
    expect(esTelefonoDelMock('+56911112222')).toBe(false);
  });

  it('rechaza un numero que SI esta en la allowlist pero no en la whitelist', async () => {
    delete process.env.TEST_PHONE_WHITELIST;
    process.env.ALLOWLIST_NUMBERS = '+56911112222';
    const { runGuardrails } = await freshGuardrails();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-11T16:00:00.000Z')); // martes 12:00 Santiago

    expect(runGuardrails('+56911112222')).toEqual({
      allowed: false,
      motivo: 'fuera_de_whitelist_pruebas',
    });
  });

  it('un numero fuera de la allowlist sigue reportando no_en_allowlist, no la whitelist', async () => {
    // El orden importa para no cambiar el motivo de rechazo que ya existia.
    delete process.env.TEST_PHONE_WHITELIST;
    process.env.ALLOWLIST_NUMBERS = '+56956194817';
    const { runGuardrails } = await freshGuardrails();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-11T16:00:00.000Z'));

    expect(runGuardrails('+56900000009')).toEqual({ allowed: false, motivo: 'no_en_allowlist' });
  });
});
