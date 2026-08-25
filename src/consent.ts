/**
 * Per-tenant consent ledger (FYV-585 spine hardening).
 *
 * WhatsApp consent discipline: every opt-in / opt-out / manual consent event
 * is recorded as an append-only, tenant-scoped ledger entry. Downstream policy
 * (see {@link ../policy.js}) derives current consent *state* from the latest
 * event, but the ledger keeps the full audit trail Meta Tech Provider reviews
 * expect — who changed consent, when, via which channel, and what keyword or
 * actor triggered it.
 *
 * The {@link OptOutStore} from `optout.js` remains the fast-path state store;
 * this ledger is the durable audit trail that backs it. `applyInboundCompliance`
 * updates both in one call so apps cannot record one without the other.
 */

import type { OptOutStore } from './optout.js';
import { InMemoryOptOutStore, applyComplianceKeywords } from './optout.js';

/** Direction of the consent change relative to the business. */
export type ConsentKind = 'opt_in' | 'opt_out' | 'manual';

/** One immutable consent ledger entry. */
export interface ConsentEvent {
  /** Tenant / app namespace the conversation belongs to. */
  tenant: string;
  /** Customer phone (same normalized form as OptOutStore: digits, no prefix). */
  phone: string;
  /** What changed. `manual` = recorded by an agent/admin, not a keyword. */
  kind: ConsentKind;
  /** The keyword that triggered the change (opt_in/opt_out only). */
  keyword?: string;
  /** Provider channel: 'meta' | 'twilio' (when known). */
  channel?: string;
  /** Who recorded the event (agent id, admin email, 'customer', ...). */
  actor?: string;
  /** Free-form note (manual events). */
  note?: string;
  /** When the event happened. */
  at: Date;
}

/** Current derived consent state for a customer. */
export interface ConsentStatus {
  /** True when the LATEST event is an opt-out (or a manual opt-out). */
  optedOut: boolean;
  /** The latest recorded event, when one exists. */
  lastEvent?: ConsentEvent;
}

/**
 * Persistence seam for the consent ledger. Apps back this with their own
 * table (see `migrations/0002_whatsapp_core_consent_templates.sql` and
 * {@link PostgresConsentLedger}). Keyed by `(tenant, phone)` so one phone can
 * hold separate consent per app.
 */
export interface ConsentLedger {
  /** Append an event. The caller is responsible for ordering semantics. */
  record(event: ConsentEvent): Promise<void>;
  /** All events for a (tenant, phone), newest first. */
  history(tenant: string, phone: string): Promise<ConsentEvent[]>;
  /** Derived current state: latest event wins. */
  status(tenant: string, phone: string): Promise<ConsentStatus>;
}

/** In-memory {@link ConsentLedger} for tests and local dev. */
export class InMemoryConsentLedger implements ConsentLedger {
  private readonly events: Array<{ seq: number; event: ConsentEvent }> = [];
  private nextSeq = 1;

  async record(event: ConsentEvent): Promise<void> {
    this.events.push({ seq: this.nextSeq++, event });
  }

  async history(tenant: string, phone: string): Promise<ConsentEvent[]> {
    return this.events
      .filter((e) => e.event.tenant === tenant && e.event.phone === phone)
      .sort((a, b) => {
        // Newest first; insertion order breaks same-millisecond ties so the
        // "latest event wins" rule is deterministic (matches the Postgres
        // store's `order by at desc, id desc`).
        const byAt = b.event.at.getTime() - a.event.at.getTime();
        return byAt !== 0 ? byAt : b.seq - a.seq;
      })
      .map((e) => e.event);
  }

  async status(tenant: string, phone: string): Promise<ConsentStatus> {
    const [last] = await this.history(tenant, phone);
    if (!last) return { optedOut: false };
    return { optedOut: last.kind === 'opt_out', lastEvent: last };
  }
}

/** Options for {@link applyInboundCompliance}. */
export interface ApplyInboundComplianceOptions {
  /** Where opt-in/opt-out fast-path state is persisted. */
  optOutStore?: OptOutStore;
  /** Where the durable audit events are appended. */
  ledger: ConsentLedger;
  /** Tenant / app namespace. */
  tenant: string;
  /** Provider channel the inbound message arrived on. */
  channel?: string;
  /** Opt-out keyword set override (defaults to {@link DEFAULT_OPT_OUT_KEYWORDS}). */
  optOutKeywords?: readonly string[];
  /** Opt-in keyword set override (defaults to {@link DEFAULT_OPT_IN_KEYWORDS}). */
  optInKeywords?: readonly string[];
}

/**
 * Apply an inbound message's content to consent state AND the audit ledger in
 * one call: updates {@link OptOutStore} (when provided) and appends the
 * matching {@link ConsentEvent}. Returns the action taken so the webhook
 * handler can decide on acknowledgements or escalation.
 */
export async function applyInboundCompliance(
  phone: string,
  content: string,
  options: ApplyInboundComplianceOptions
): Promise<{ action: 'opt_out' | 'opt_in' | 'none'; keyword?: string }> {
  const result = await applyComplianceKeywords(
    // No-op store when the caller only wants the ledger.
    options.optOutStore ?? new InMemoryOptOutStore(),
    phone,
    content,
    {
      ...(options.optOutKeywords !== undefined ? { optOutKeywords: options.optOutKeywords } : {}),
      ...(options.optInKeywords !== undefined ? { optInKeywords: options.optInKeywords } : {}),
    }
  );

  if (result.action !== 'none') {
    await options.ledger.record({
      tenant: options.tenant,
      phone,
      kind: result.action,
      ...(result.keyword !== undefined ? { keyword: result.keyword } : {}),
      ...(options.channel !== undefined ? { channel: options.channel } : {}),
      actor: 'customer',
      at: new Date(),
    });
  }

  return result;
}
