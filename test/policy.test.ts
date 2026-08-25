import { describe, it, expect } from 'vitest';
import { createSession, recordInbound } from '../src/session.js';
import { InMemoryConsentLedger } from '../src/consent.js';
import { InMemoryTemplateRegistry } from '../src/templates.js';
import { evaluateSendPolicy } from '../src/policy.js';

const TENANT = 'bien';

function freeform(to = '+5215500000001') {
  return { to, isTemplate: false };
}
function template(to = '+5215500000001', templateName = 'order_update') {
  return { to, isTemplate: true, templateName };
}

async function optedOutLedger(phone: string): Promise<InMemoryConsentLedger> {
  const ledger = new InMemoryConsentLedger();
  await ledger.record({
    tenant: TENANT,
    phone,
    kind: 'opt_out',
    keyword: 'STOP',
    actor: 'customer',
    at: new Date('2026-06-01T00:00:00.000Z'),
  });
  return ledger;
}

describe('evaluateSendPolicy — consent gate', () => {
  it('denies every send to an opted-out customer, even an approved template', async () => {
    const phone = '+5215500000001';
    const ledger = await optedOutLedger(phone);
    const registry = new InMemoryTemplateRegistry();
    await registry.approve({
      tenant: TENANT,
      templateName: 'order_update',
      approvedAt: new Date(),
    });

    const res = await evaluateSendPolicy(createSession(), template(phone), TENANT, {
      consentLedger: ledger,
      templateRegistry: registry,
    });
    expect(res).toEqual({
      allowed: false,
      templateRequired: false,
      reasons: ['opted_out'],
    });
  });

  it('denies freeform to an opted-out customer inside the session window', async () => {
    const phone = '+5215500000002';
    const ledger = await optedOutLedger(phone);
    const session = recordInbound(createSession(), Date.now());
    const res = await evaluateSendPolicy(session, freeform(phone), TENANT, {
      consentLedger: ledger,
    });
    expect(res.allowed).toBe(false);
    expect(res.reasons).toEqual(['opted_out']);
  });
});

describe('evaluateSendPolicy — template approval gate', () => {
  it('allows an approved template any time, even with no session', async () => {
    const registry = new InMemoryTemplateRegistry();
    await registry.approve({
      tenant: TENANT,
      templateName: 'order_update',
      approvedAt: new Date(),
    });
    const res = await evaluateSendPolicy(createSession(), template('+5215500000003'), TENANT, {
      templateRegistry: registry,
    });
    expect(res).toEqual({ allowed: true, templateRequired: false, reasons: [] });
  });

  it('denies an unapproved template outside the window', async () => {
    const registry = new InMemoryTemplateRegistry();
    const res = await evaluateSendPolicy(createSession(), template('+5215500000004'), TENANT, {
      templateRegistry: registry,
    });
    expect(res).toEqual({
      allowed: false,
      templateRequired: false,
      reasons: ['template_not_approved'],
    });
  });
});

describe('evaluateSendPolicy — 24h session window (freeform)', () => {
  it('allows freeform inside the window', async () => {
    const session = recordInbound(createSession(), Date.now());
    const res = await evaluateSendPolicy(session, freeform('+5215500000005'), TENANT, {});
    expect(res).toEqual({ allowed: true, templateRequired: false, reasons: [] });
  });

  it('denies freeform with no session and points at templates', async () => {
    const res = await evaluateSendPolicy(createSession(), freeform('+5215500000006'), TENANT, {});
    expect(res).toEqual({
      allowed: false,
      templateRequired: true,
      reasons: ['no_session'],
    });
  });

  it('denies freeform after the window lapses', async () => {
    const at = Date.parse('2026-06-01T00:00:00.000Z');
    const session = recordInbound(createSession(), at);
    const res = await evaluateSendPolicy(
      session,
      freeform('+5215500000007'),
      TENANT,
      {},
      at + 24 * 60 * 60 * 1000 + 1
    );
    expect(res).toEqual({
      allowed: false,
      templateRequired: true,
      reasons: ['session_expired'],
    });
  });

  it('preserves legacy behavior when no ledger/registry is provided', async () => {
    // Templates were always allowed before FYV-585; that must not regress.
    const res = await evaluateSendPolicy(createSession(), template('+5215500000008'), TENANT, {});
    expect(res.allowed).toBe(true);
  });
});
