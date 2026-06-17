/**
 * 24-hour customer session window.
 *
 * WhatsApp's Business Messaging policy lets a business send freeform messages
 * only within 24 hours of the customer's last *inbound* message. Outside that
 * window only pre-approved templates may be sent.
 *
 * Key rule modelled here: the window is anchored to the last INBOUND customer
 * message. Agent / business replies do NOT extend it — only a new customer
 * message resets the clock.
 *
 * @see https://developers.facebook.com/docs/whatsapp/pricing#conversations
 */

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Immutable view of a conversation's session state. */
export interface SessionState {
  /** Timestamp (ms epoch) of the last inbound customer message, or null. */
  lastInboundAt: number | null;
}

/** Reason a freeform send was blocked. */
export type SendGateReason = 'no_session' | 'session_expired';

/** Result of asking whether a message may be sent right now. */
export interface SendDecision {
  allowed: boolean;
  /** True when the only way to message the customer is via a template. */
  templateRequired: boolean;
  reason?: SendGateReason;
}

function toMs(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

/** A fresh, empty session (no customer message ever received). */
export function createSession(): SessionState {
  return { lastInboundAt: null };
}

/**
 * Reset the window because a customer just sent an inbound message.
 *
 * This is the ONLY operation that opens / extends the window. There is no
 * counterpart for agent replies by design.
 */
export function recordInbound(
  _state: SessionState,
  inboundAt: Date | number
): SessionState {
  return { lastInboundAt: toMs(inboundAt) };
}

/** When the current window expires, or null if there is no open window. */
export function sessionExpiresAt(state: SessionState): Date | null {
  if (state.lastInboundAt === null) return null;
  return new Date(state.lastInboundAt + SESSION_WINDOW_MS);
}

/**
 * Is the session still open at `now`?
 *
 * The window is `[lastInboundAt, lastInboundAt + 24h)` — half-open, so the exact
 * 24h boundary is treated as expired (matches Meta, which bills a new
 * conversation once the window lapses).
 */
export function isWithinSession(
  state: SessionState,
  now: Date | number = Date.now()
): boolean {
  if (state.lastInboundAt === null) return false;
  const elapsed = toMs(now) - state.lastInboundAt;
  return elapsed >= 0 && elapsed < SESSION_WINDOW_MS;
}

/**
 * Decide whether an outbound message is allowed right now.
 *
 * Templates are always allowed. Freeform (text / media) is allowed only inside
 * the window; when the window is closed the decision reports
 * `templateRequired: true` so callers can re-engage via a template.
 */
export function canSend(
  state: SessionState,
  outbound: { isTemplate: boolean },
  now: Date | number = Date.now()
): SendDecision {
  if (outbound.isTemplate) {
    return { allowed: true, templateRequired: false };
  }

  if (state.lastInboundAt === null) {
    return { allowed: false, templateRequired: true, reason: 'no_session' };
  }

  if (!isWithinSession(state, now)) {
    return { allowed: false, templateRequired: true, reason: 'session_expired' };
  }

  return { allowed: true, templateRequired: false };
}
