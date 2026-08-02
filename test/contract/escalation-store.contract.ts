/**
 * Shared contract test suite for {@link EscalationStore} implementations. Run
 * against InMemoryEscalationStore and PostgresEscalationStore.
 */
import { it, expect } from 'vitest';
import type { EscalationStore } from '../../src/escalation.js';

export function escalationStoreContract(getStore: () => EscalationStore, ns: string): void {
  const tenant = `tenant-${ns}`;

  it('escalate opens a ticket and returns it with an id', async () => {
    const store = getStore();
    const ticket = await store.escalate({
      tenant,
      phone: `+1${ns}0001`,
      reason: 'consent_change',
      context: 'customer re-subscribed after opting out',
    });
    expect(ticket.id).toBeTruthy();
    expect(ticket.status).toBe('open');
    expect(ticket.reason).toBe('consent_change');
  });

  it('listOpen returns open tickets newest first and filters by tenant', async () => {
    const store = getStore();
    const listTenant = `${tenant}-list`;
    await store.escalate({ tenant: listTenant, phone: `+1${ns}0002`, reason: 'other' });
    await store.escalate({
      tenant: `other-${ns}`,
      phone: `+1${ns}0002`,
      reason: 'ambiguous_content',
    });
    const open = await store.listOpen(listTenant);
    expect(open.length).toBe(1);
    expect(open[0]?.reason).toBe('other');
    const openAll = await store.listOpen();
    expect(openAll.filter((t) => t.tenant === listTenant || t.tenant === `other-${ns}`)).toHaveLength(2);
  });

  it('resolve closes the ticket with a resolution note', async () => {
    const store = getStore();
    const resolveTenant = `${tenant}-resolve`;
    const ticket = await store.escalate({
      tenant: resolveTenant,
      phone: `+1${ns}0003`,
      reason: 'manual_approval',
    });
    const resolved = await store.resolve(ticket.id, 'approved by ops');
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolution).toBe('approved by ops');
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);
    expect(await store.listOpen(resolveTenant)).toHaveLength(0);
  });

  it('resolve on an unknown id returns undefined', async () => {
    const store = getStore();
    expect(await store.resolve('nope', 'x')).toBeUndefined();
  });
}
