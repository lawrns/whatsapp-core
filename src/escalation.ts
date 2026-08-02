/**
 * Human escalation path (FYV-585 spine hardening).
 *
 * WhatsApp consent discipline requires a human-in-the-loop escape hatch:
 * when automation cannot decide — a customer explicitly re-subscribes after
 * opting out, an ambiguous opt-out, a sensitive request, an admin override —
 * the core provides a durable queue seam that apps hook to their review
 * surface (Linear, Slack, admin UI). The seam is intentionally generic; apps
 * decide WHEN to escalate, the core guarantees the event is recorded,
 * listable, and resolvable.
 */

/** Reason a conversation was escalated to a human. */
export type EscalationReason =
  /** Customer opted out (or in) and a human should acknowledge/handle it. */
  | 'consent_change'
  /** The inbound message is ambiguous / automation cannot classify it. */
  | 'ambiguous_content'
  /** The tenant requires a human to approve this specific send. */
  | 'manual_approval'
  /** App-defined reason. */
  | 'other';

/** One escalation ticket. */
export interface Escalation {
  /** Opaque id assigned by the store. */
  id: string;
  /** Tenant / app namespace. */
  tenant: string;
  /** Customer phone the escalation concerns. */
  phone: string;
  reason: EscalationReason;
  /** App-defined context (message id, transcript snippet, ...). */
  context?: string;
  /** When it was raised. */
  createdAt: Date;
  status: 'open' | 'resolved';
  /** When it was resolved (null while open). */
  resolvedAt?: Date;
  /** Human resolution note. */
  resolution?: string;
}

/** Input to {@link EscalationStore.escalate}. */
export type NewEscalation = Omit<
  Escalation,
  'id' | 'createdAt' | 'status' | 'resolvedAt' | 'resolution'
>;

/**
 * Persistence seam for escalations. Apps back this with their own table
 * (see `migrations/0002_whatsapp_core_consent_templates.sql` and
 * {@link PostgresEscalationStore}).
 */
export interface EscalationStore {
  /** Open a new escalation; returns the stored ticket. */
  escalate(input: NewEscalation): Promise<Escalation>;
  /** All open tickets, optionally filtered by tenant, newest first. */
  listOpen(tenant?: string): Promise<Escalation[]>;
  /** Mark a ticket resolved; returns the updated ticket. */
  resolve(id: string, resolution: string): Promise<Escalation | undefined>;
}

/** In-memory {@link EscalationStore} for tests and local dev. */
export class InMemoryEscalationStore implements EscalationStore {
  private readonly tickets = new Map<string, Escalation>();
  private nextId = 1;

  async escalate(input: NewEscalation): Promise<Escalation> {
    const id = `esc-${this.nextId++}`;
    const ticket: Escalation = {
      ...input,
      id,
      createdAt: new Date(),
      status: 'open',
    };
    this.tickets.set(id, ticket);
    return ticket;
  }

  async listOpen(tenant?: string): Promise<Escalation[]> {
    return [...this.tickets.values()]
      .filter((t) => t.status === 'open' && (tenant === undefined || t.tenant === tenant))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async resolve(id: string, resolution: string): Promise<Escalation | undefined> {
    const ticket = this.tickets.get(id);
    if (!ticket) return undefined;
    const updated: Escalation = {
      ...ticket,
      status: 'resolved',
      resolvedAt: new Date(),
      resolution,
    };
    this.tickets.set(id, updated);
    return updated;
  }
}
