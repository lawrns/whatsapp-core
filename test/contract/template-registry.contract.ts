/**
 * Shared contract test suite for {@link TemplateRegistry} implementations. Run
 * against InMemoryTemplateRegistry and PostgresTemplateRegistry.
 */
import { it, expect } from 'vitest';
import type { TemplateRegistry } from '../../src/templates.js';

export function templateRegistryContract(getStore: () => TemplateRegistry, ns: string): void {
  const tenant = `tenant-${ns}`;

  it('a template is not approved until explicitly approved', async () => {
    const store = getStore();
    expect(await store.isApproved(tenant, 'order_update')).toBe(false);
  });

  it('approve makes the template sendable and listable', async () => {
    const store = getStore();
    const at = new Date('2026-06-01T00:00:00.000Z');
    await store.approve({
      tenant,
      templateName: 'order_update',
      category: 'utility',
      approvedBy: 'admin@bien.mx',
      approvedAt: at,
    });
    expect(await store.isApproved(tenant, 'order_update')).toBe(true);
    const list = await store.list(tenant);
    expect(list.map((a) => a.templateName)).toContain('order_update');
    expect(list.find((a) => a.templateName === 'order_update')?.category).toBe('utility');
  });

  it('revoke removes the template from the registry', async () => {
    const store = getStore();
    await store.approve({
      tenant,
      templateName: 'promo_marketing',
      approvedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    await store.revoke(tenant, 'promo_marketing');
    expect(await store.isApproved(tenant, 'promo_marketing')).toBe(false);
  });

  it('approval is scoped per tenant', async () => {
    const store = getStore();
    const otherTenant = `other-${ns}`;
    await store.approve({
      tenant,
      templateName: 'shared_welcome',
      approvedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(await store.isApproved(tenant, 'shared_welcome')).toBe(true);
    expect(await store.isApproved(otherTenant, 'shared_welcome')).toBe(false);
  });
}
