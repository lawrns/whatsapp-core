import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OPT_OUT_KEYWORDS,
  detectOptOut,
  isOptOut,
  detectOptIn,
  applyComplianceKeywords,
  InMemoryOptOutStore,
} from '../src/optout.js';

describe('detectOptOut — keyword detection', () => {
  it('detects each default keyword case-insensitively', () => {
    for (const kw of DEFAULT_OPT_OUT_KEYWORDS) {
      expect(isOptOut(kw)).toBe(true);
      expect(isOptOut(kw.toLowerCase())).toBe(true);
    }
  });

  it('detects STOP / BAJA / CANCELAR explicitly', () => {
    expect(detectOptOut('STOP')).toBe('STOP');
    expect(detectOptOut('baja')).toBe('BAJA');
    expect(detectOptOut('Cancelar')).toBe('CANCELAR');
  });

  it('trims surrounding whitespace', () => {
    expect(isOptOut('  STOP  ')).toBe(true);
    expect(isOptOut('\tBAJA\n')).toBe(true);
  });

  it('collapses internal whitespace for multi-word keywords', () => {
    expect(detectOptOut('no   mas')).toBe('NO MAS');
    expect(detectOptOut('NO MAS')).toBe('NO MAS');
  });

  it('does NOT match substrings or phrases containing a keyword', () => {
    expect(isOptOut('BAJA POR FAVOR')).toBe(false);
    expect(isOptOut('quiero parar de comprar')).toBe(false);
    expect(isOptOut('me gusta el precio bajo')).toBe(false);
    expect(isOptOut('STOPP')).toBe(false);
  });

  it('does NOT match regular messages or empty input', () => {
    expect(isOptOut('Hola')).toBe(false);
    expect(isOptOut('¿Cuándo llega mi pedido?')).toBe(false);
    expect(isOptOut('')).toBe(false);
  });

  it('supports a custom keyword list', () => {
    expect(detectOptOut('QUITAR', ['QUITAR'])).toBe('QUITAR');
    expect(detectOptOut('STOP', ['QUITAR'])).toBeNull();
  });
});

describe('detectOptIn', () => {
  it('detects opt-in keywords', () => {
    expect(detectOptIn('START')).toBe('START');
    expect(detectOptIn('alta')).toBe('ALTA');
  });

  it('returns null for non opt-in', () => {
    expect(detectOptIn('STOP')).toBeNull();
  });
});

describe('applyComplianceKeywords + InMemoryOptOutStore', () => {
  it('opts a customer out on a STOP keyword', async () => {
    const store = new InMemoryOptOutStore();
    const res = await applyComplianceKeywords(store, '+5215512345678', 'STOP');
    expect(res).toEqual({ action: 'opt_out', keyword: 'STOP' });
    expect(await store.isOptedOut('+5215512345678')).toBe(true);
  });

  it('opts a customer back in on a START keyword', async () => {
    const store = new InMemoryOptOutStore();
    await store.optOut('+5215512345678', 'STOP');
    const res = await applyComplianceKeywords(store, '+5215512345678', 'START');
    expect(res).toEqual({ action: 'opt_in', keyword: 'START' });
    expect(await store.isOptedOut('+5215512345678')).toBe(false);
  });

  it('is a no-op for a regular message', async () => {
    const store = new InMemoryOptOutStore();
    const res = await applyComplianceKeywords(store, '+5215512345678', 'Hola, ¿precio?');
    expect(res).toEqual({ action: 'none' });
    expect(await store.isOptedOut('+5215512345678')).toBe(false);
  });

  it('tracks opt-out state independently per phone number', async () => {
    const store = new InMemoryOptOutStore();
    await applyComplianceKeywords(store, '+111', 'STOP');
    expect(await store.isOptedOut('+111')).toBe(true);
    expect(await store.isOptedOut('+222')).toBe(false);
  });
});
