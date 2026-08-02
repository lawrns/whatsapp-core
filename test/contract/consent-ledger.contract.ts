/**
 * Shared contract test suite for {@link ConsentLedger} implementations. Run
 * against InMemoryConsentLedger and PostgresConsentLedger. Each `it` uses a
 * distinct (tenant, phone) pair so this can be invoked more than once against
 * the same underlying store without cross-test interference.
 */
import { it, expect } from 'vitest';
import type { ConsentLedger } from '../../src/consent.js';

export function consentLedgerContract(getStore: () => ConsentLedger, ns: string): void {
  const tenant = `tenant-${ns}`;

  it('a fresh (tenant, phone) has no consent state', async () => {
    const store = getStore();
    const status = await store.status(tenant, `+1${ns}0001`);
    expect(status.optedOut).toBe(false);
    expect(status.lastEvent).toBeUndefined();
  });

  it('an opt-out event flips status to optedOut', async () => {
    const store = getStore();
    const phone = `+1${ns}0002`;
    await store.record({
      tenant,
      phone,
      kind: 'opt_out',
      keyword: 'STOP',
      actor: 'customer',
      at: new Date('2026-06-01T00:00:00.000Z'),
    });
    const status = await store.status(tenant, phone);
    expect(status.optedOut).toBe(true);
    expect(status.lastEvent?.kind).toBe('opt_out');
    expect(status.lastEvent?.keyword).toBe('STOP');
  });

  it('a later opt-in overrides an earlier opt-out (latest wins)', async () => {
    const store = getStore();
    const phone = `+1${ns}0003`;
    await store.record({
      tenant,
      phone,
      kind: 'opt_out',
      keyword: 'STOP',
      at: new Date('2026-06-01T00:00:00.000Z'),
    });
    await store.record({
      tenant,
      phone,
      kind: 'opt_in',
      keyword: 'START',
      at: new Date('2026-06-02T00:00:00.000Z'),
    });
    expect((await store.status(tenant, phone)).optedOut).toBe(false);
  });

  it('history returns events newest first', async () => {
    const store = getStore();
    const phone = `+1${ns}0004`;
    await store.record({
      tenant,
      phone,
      kind: 'opt_in',
      at: new Date('2026-06-01T00:00:00.000Z'),
    });
    await store.record({
      tenant,
      phone,
      kind: 'opt_out',
      keyword: 'BAJA',
      at: new Date('2026-06-03T00:00:00.000Z'),
    });
    const history = await store.history(tenant, phone);
    expect(history.map((e) => e.kind)).toEqual(['opt_out', 'opt_in']);
  });

  it('tracks consent independently per tenant for the same phone', async () => {
    const store = getStore();
    const phone = `+1${ns}0005`;
    const otherTenant = `other-${ns}`;
    await store.record({ tenant, phone, kind: 'opt_out', at: new Date() });
    expect((await store.status(tenant, phone)).optedOut).toBe(true);
    expect((await store.status(otherTenant, phone)).optedOut).toBe(false);
  });

  it('records manual events (agent/admin recorded consent)', async () => {
    const store = getStore();
    const phone = `+1${ns}0006`;
    await store.record({
      tenant,
      phone,
      kind: 'manual',
      actor: 'admin@bien.mx',
      note: 'verified phone ownership over a call',
      at: new Date('2026-06-01T00:00:00.000Z'),
    });
    const history = await store.history(tenant, phone);
    expect(history[0]?.kind).toBe('manual');
    expect(history[0]?.actor).toBe('admin@bien.mx');
  });
}
