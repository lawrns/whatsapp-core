/**
 * Shared contract test suite for {@link OptOutStore} implementations. Run
 * against InMemoryOptOutStore and PostgresOptOutStore so both honor the exact
 * same behavior. Each `it` uses a distinct phone number so this can be
 * invoked more than once against the same underlying store/table without
 * cross-test interference.
 */
import { it, expect } from 'vitest';
import type { OptOutStore } from '../../src/optout.js';

export function optOutStoreContract(getStore: () => OptOutStore, ns: string): void {
  it('reports a fresh phone as not opted out', async () => {
    const store = getStore();
    expect(await store.isOptedOut(`+1${ns}0001`)).toBe(false);
  });

  it('opts a phone out and reports it as opted out', async () => {
    const store = getStore();
    const phone = `+1${ns}0002`;
    await store.optOut(phone, 'STOP');
    expect(await store.isOptedOut(phone)).toBe(true);
  });

  it('opts a phone back in', async () => {
    const store = getStore();
    const phone = `+1${ns}0003`;
    await store.optOut(phone, 'STOP');
    await store.optIn(phone);
    expect(await store.isOptedOut(phone)).toBe(false);
  });

  it('tracks opt-out state independently per phone', async () => {
    const store = getStore();
    const a = `+1${ns}0004`;
    const b = `+1${ns}0005`;
    await store.optOut(a, 'BAJA');
    expect(await store.isOptedOut(a)).toBe(true);
    expect(await store.isOptedOut(b)).toBe(false);
  });

  it('optOut is idempotent across repeated keywords for the same phone', async () => {
    const store = getStore();
    const phone = `+1${ns}0006`;
    await store.optOut(phone, 'STOP');
    await store.optOut(phone, 'BAJA');
    expect(await store.isOptedOut(phone)).toBe(true);
  });

  it('optIn on a phone that was never opted out is a no-op', async () => {
    const store = getStore();
    const phone = `+1${ns}0007`;
    await store.optIn(phone);
    expect(await store.isOptedOut(phone)).toBe(false);
  });
}
