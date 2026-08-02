/**
 * Send policy — the spine gate (FYV-585).
 *
 * Composes the three WhatsApp Business Messaging rules into a single
 * decision for an outbound message:
 *
 *  1. **Consent**: an opted-out customer must not be messaged at all.
 *  2. **Template approval**: templates may be sent any time, but only if the
 *     tenant has approved that exact template name in its registry.
 *  3. **24h session window**: freeform messages only inside the window
 *     anchored to the customer's last inbound message (reuses {@link canSend}).
 *
 * This is a pure function over state — callers fetch the session/consent
 * state from their stores and pass it in. It deliberately does NOT do I/O so
 * it is trivially testable and can run in webhook hot paths.
 */

import type { SessionState } from './session.js';
import { canSend } from './session.js';
import type { ConsentLedger } from './consent.js';
import type { TemplateRegistry } from './templates.js';

/** Why a send was blocked. */
export type SendPolicyReason =
  /** Customer is opted out (latest consent event). Unblockable by sending. */
  | 'opted_out'
  /** Template is not in the tenant's approved registry. */
  | 'template_not_approved'
  /** No inbound message ever recorded — freeform not allowed. */
  | 'no_session'
  /** 24h window lapsed — re-engage via an approved template. */
  | 'session_expired';

/** Result of {@link evaluateSendPolicy}. */
export interface SendPolicyResult {
  allowed: boolean;
  /** True when the only path to message the customer is an approved template. */
  templateRequired: boolean;
  /** Blocking reason(s); empty when allowed. */
  reasons: SendPolicyReason[];
}

/** Inputs describing the proposed outbound message. */
export interface SendPolicyMessage {
  /** Recipient phone (same normalized form used everywhere in the core). */
  to: string;
  /** True for template messages; false for freeform (text/media/interactive). */
  isTemplate: boolean;
  /** Template name, required and used only when `isTemplate` is true. */
  templateName?: string;
}

/** Optional policy dependencies. When omitted, that rule is skipped. */
export interface SendPolicyOptions {
  /** When provided, opted-out customers are refused entirely. */
  consentLedger?: ConsentLedger;
  /** When provided, out-of-window templates must be pre-approved. */
  templateRegistry?: TemplateRegistry;
}

/**
 * Evaluate whether an outbound message may be sent right now.
 *
 * @param session Current session state for the recipient (from a SessionStore).
 * @param message The proposed outbound message.
 * @param tenant  Tenant / app namespace (used for consent + template lookups).
 * @param options Policy dependencies (ledger / registry).
 * @param now     Evaluation time, defaults to now.
 */
export async function evaluateSendPolicy(
  session: SessionState,
  message: SendPolicyMessage,
  tenant: string,
  options: SendPolicyOptions = {},
  now: Date | number = Date.now()
): Promise<SendPolicyResult> {
  const reasons: SendPolicyReason[] = [];

  // 1. Consent gate — hard stop, no exceptions.
  if (options.consentLedger) {
    const status = await options.consentLedger.status(tenant, message.to);
    if (status.optedOut) {
      return { allowed: false, templateRequired: false, reasons: ['opted_out'] };
    }
  }

  // 2. Template approval gate.
  if (message.isTemplate) {
    if (options.templateRegistry) {
      const approved = await options.templateRegistry.isApproved(
        tenant,
        message.templateName ?? ''
      );
      if (!approved) {
        return {
          allowed: false,
          templateRequired: false,
          reasons: ['template_not_approved'],
        };
      }
    }
    return { allowed: true, templateRequired: false, reasons: [] };
  }

  // 3. Session window gate for freeform messages.
  const decision = canSend(session, { isTemplate: false }, now);
  if (!decision.allowed) {
    reasons.push(decision.reason === 'no_session' ? 'no_session' : 'session_expired');
    return {
      allowed: false,
      templateRequired: decision.templateRequired,
      reasons,
    };
  }

  return { allowed: true, templateRequired: false, reasons: [] };
}
