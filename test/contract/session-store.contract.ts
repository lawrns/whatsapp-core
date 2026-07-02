/**
 * Shared contract test suite for {@link SessionStore} implementations. Run
 * against InMemorySessionStore and PostgresSessionStore. Each `it` uses a
 * distinct phone number so this can be invoked more than once against the
 * same underlying store/table without cross-test interference.
 */
import { it, expect } from 'vitest';
import type { SessionStore } from '../../src/session.js';
import { canSend } from '../../src/session.js';

export function sessionStoreContract(getStore: () => SessionStore, ns: string): void {
  it('a fresh phone has no open session', async () => {
    const store = getStore();
    const s = await store.get(`+1${ns}0001`);
    expect(s.lastInboundAt).toBeNull();
  });

  it('recordInbound opens and persists a session', async () => {
    const store = getStore();
    const phone = `+1${ns}0002`;
    const at = Date.parse('2026-06-01T00:00:00.000Z');
    const s = await store.recordInbound(phone, at);
    expect(s.lastInboundAt).toBe(at);
    const reread = await store.get(phone);
    expect(reread.lastInboundAt).toBe(at);
  });

  it('a later recordInbound overwrites the previous anchor', async () => {
    const store = getStore();
    const phone = `+1${ns}0003`;
    await store.recordInbound(phone, Date.parse('2026-06-01T00:00:00.000Z'));
    const later = Date.parse('2026-06-02T00:00:00.000Z');
    const s = await store.recordInbound(phone, later);
    expect(s.lastInboundAt).toBe(later);
    expect((await store.get(phone)).lastInboundAt).toBe(later);
  });

  it('accepts Date or epoch-ms for inbound time', async () => {
    const store = getStore();
    const phoneA = `+1${ns}0004a`;
    const phoneB = `+1${ns}0004b`;
    const at = Date.parse('2026-06-01T00:00:00.000Z');
    const a = await store.recordInbound(phoneA, new Date(at));
    const b = await store.recordInbound(phoneB, at);
    expect(a.lastInboundAt).toBe(b.lastInboundAt);
  });

  it('canSend integrates with a persisted session', async () => {
    const store = getStore();
    const phone = `+1${ns}0005`;
    const at = Date.now();
    const s = await store.recordInbound(phone, at);
    expect(canSend(s, { isTemplate: false }, at + 1000).allowed).toBe(true);
  });

  it('tracks session state independently per phone', async () => {
    const store = getStore();
    const a = `+1${ns}0006`;
    const b = `+1${ns}0007`;
    await store.recordInbound(a, Date.now());
    expect((await store.get(a)).lastInboundAt).not.toBeNull();
    expect((await store.get(b)).lastInboundAt).toBeNull();
  });
}
