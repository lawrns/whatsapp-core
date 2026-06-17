import { describe, it, expect } from 'vitest';
import {
  SESSION_WINDOW_MS,
  createSession,
  recordInbound,
  sessionExpiresAt,
  isWithinSession,
  canSend,
} from '../src/session.js';

const T0 = new Date('2026-06-17T12:00:00.000Z').getTime();

describe('session window — basics', () => {
  it('a fresh session has no open window', () => {
    const s = createSession();
    expect(s.lastInboundAt).toBeNull();
    expect(isWithinSession(s, T0)).toBe(false);
    expect(sessionExpiresAt(s)).toBeNull();
  });

  it('recordInbound opens a 24h window anchored to the inbound time', () => {
    const s = recordInbound(createSession(), T0);
    expect(s.lastInboundAt).toBe(T0);
    expect(sessionExpiresAt(s)?.getTime()).toBe(T0 + SESSION_WINDOW_MS);
  });

  it('accepts Date or epoch-ms for inbound time', () => {
    const a = recordInbound(createSession(), new Date(T0));
    const b = recordInbound(createSession(), T0);
    expect(a.lastInboundAt).toBe(b.lastInboundAt);
  });
});

describe('session window — expiry', () => {
  it('is open immediately after an inbound message', () => {
    const s = recordInbound(createSession(), T0);
    expect(isWithinSession(s, T0)).toBe(true);
  });

  it('is open just before the 24h boundary', () => {
    const s = recordInbound(createSession(), T0);
    expect(isWithinSession(s, T0 + SESSION_WINDOW_MS - 1)).toBe(true);
  });

  it('is expired exactly at the 24h boundary (half-open window)', () => {
    const s = recordInbound(createSession(), T0);
    expect(isWithinSession(s, T0 + SESSION_WINDOW_MS)).toBe(false);
  });

  it('is expired well after the window', () => {
    const s = recordInbound(createSession(), T0);
    expect(isWithinSession(s, T0 + SESSION_WINDOW_MS + 60_000)).toBe(false);
  });

  it('treats a "now" before the inbound time as not-within (clock skew guard)', () => {
    const s = recordInbound(createSession(), T0);
    expect(isWithinSession(s, T0 - 1000)).toBe(false);
  });
});

describe('session window — reset on inbound only', () => {
  it('a new inbound message resets the clock (extends the window)', () => {
    let s = recordInbound(createSession(), T0);
    // 23h later the customer messages again.
    const later = T0 + 23 * 60 * 60 * 1000;
    s = recordInbound(s, later);
    // 23h after the FIRST message the original window would be closing soon,
    // but the new anchor pushes expiry to later + 24h.
    expect(sessionExpiresAt(s)?.getTime()).toBe(later + SESSION_WINDOW_MS);
    // Still open 24h after the original message because of the reset.
    expect(isWithinSession(s, T0 + SESSION_WINDOW_MS + 1000)).toBe(true);
  });

  it('does NOT reset on agent replies — there is no agent-reply mutator', () => {
    // The module exposes only recordInbound as a window mutator. Agent replies
    // simply never call it, so an existing window decays untouched.
    const s = recordInbound(createSession(), T0);
    const afterWindow = T0 + SESSION_WINDOW_MS + 1;
    // No agent-reply API exists to extend it; the window has lapsed.
    expect(isWithinSession(s, afterWindow)).toBe(false);
  });
});

describe('canSend — template required gating', () => {
  it('allows freeform inside the window', () => {
    const s = recordInbound(createSession(), T0);
    const d = canSend(s, { isTemplate: false }, T0 + 1000);
    expect(d).toEqual({ allowed: true, templateRequired: false });
  });

  it('blocks freeform with templateRequired when window expired', () => {
    const s = recordInbound(createSession(), T0);
    const d = canSend(s, { isTemplate: false }, T0 + SESSION_WINDOW_MS);
    expect(d.allowed).toBe(false);
    expect(d.templateRequired).toBe(true);
    expect(d.reason).toBe('session_expired');
  });

  it('blocks freeform with templateRequired when no session ever opened', () => {
    const d = canSend(createSession(), { isTemplate: false }, T0);
    expect(d.allowed).toBe(false);
    expect(d.templateRequired).toBe(true);
    expect(d.reason).toBe('no_session');
  });

  it('always allows templates — even with no session', () => {
    expect(canSend(createSession(), { isTemplate: true }, T0)).toEqual({
      allowed: true,
      templateRequired: false,
    });
  });

  it('always allows templates — even after the window expired', () => {
    const s = recordInbound(createSession(), T0);
    expect(canSend(s, { isTemplate: true }, T0 + SESSION_WINDOW_MS + 999_999)).toEqual({
      allowed: true,
      templateRequired: false,
    });
  });
});
