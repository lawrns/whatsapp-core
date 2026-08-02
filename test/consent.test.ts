import { describe, it, expect } from 'vitest';
import {
  InMemoryConsentLedger,
  applyInboundCompliance,
} from '../src/consent.js';
import { InMemoryOptOutStore } from '../src/optout.js';

const TENANT = 'bien';

describe('applyInboundCompliance', () => {
  it('records an opt-out event in the ledger and the fast-path store', async () => {
    const ledger = new InMemoryConsentLedger();
    const optOutStore = new InMemoryOptOutStore();
    const phone = '+5215500000001';

    const result = await applyInboundCompliance(phone, 'STOP', {
      ledger,
      optOutStore,
      tenant: TENANT,
      channel: 'meta',
    });

    expect(result).toEqual({ action: 'opt_out', keyword: 'STOP' });
    expect(await optOutStore.isOptedOut(phone)).toBe(true);
    const history = await ledger.history(TENANT, phone);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      tenant: TENANT,
      phone,
      kind: 'opt_out',
      keyword: 'STOP',
      channel: 'meta',
      actor: 'customer',
    });
  });

  it('records an opt-in event that flips the ledger status', async () => {
    const ledger = new InMemoryConsentLedger();
    const phone = '+5215500000002';

    await applyInboundCompliance(phone, 'BAJA', { ledger, tenant: TENANT });
    expect((await ledger.status(TENANT, phone)).optedOut).toBe(true);

    const result = await applyInboundCompliance(phone, 'START', {
      ledger,
      tenant: TENANT,
    });
    expect(result).toEqual({ action: 'opt_in', keyword: 'START' });
    expect((await ledger.status(TENANT, phone)).optedOut).toBe(false);
  });

  it('is a no-op for ordinary content and writes nothing', async () => {
    const ledger = new InMemoryConsentLedger();
    const result = await applyInboundCompliance('+5215500000003', 'Hola, ¿precio?', {
      ledger,
      tenant: TENANT,
    });
    expect(result).toEqual({ action: 'none' });
    expect(await ledger.history(TENANT, '+5215500000003')).toHaveLength(0);
  });

  it('writes to the ledger even when no OptOutStore is provided', async () => {
    const ledger = new InMemoryConsentLedger();
    const result = await applyInboundCompliance('+5215500000004', 'PARAR', {
      ledger,
      tenant: TENANT,
    });
    expect(result.action).toBe('opt_out');
    expect((await ledger.status(TENANT, '+5215500000004')).optedOut).toBe(true);
  });
});

describe('InMemoryConsentLedger', () => {
  it('supports manual events recorded by an admin', async () => {
    const ledger = new InMemoryConsentLedger();
    await ledger.record({
      tenant: TENANT,
      phone: '+5215500000005',
      kind: 'manual',
      actor: 'admin@fyves.com',
      note: 'verified via call',
      at: new Date('2026-06-01T00:00:00.000Z'),
    });
    const history = await ledger.history(TENANT, '+5215500000005');
    expect(history[0]?.kind).toBe('manual');
    expect(history[0]?.note).toBe('verified via call');
  });
});
