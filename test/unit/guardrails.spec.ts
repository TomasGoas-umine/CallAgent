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
