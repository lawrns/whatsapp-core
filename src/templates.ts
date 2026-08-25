/**
 * Approved-template registry (FYV-585 spine hardening).
 *
 * Meta only allows template messages outside the 24h customer session window,
 * and only templates the WABA has approved. The policy layer
 * (see {@link ../policy.js}) refuses to send ANY template that is not in this
 * registry for the tenant, so a typo'd template name or a not-yet-approved
 * template fails locally instead of silently hitting the Graph API (or worse,
 * sending an unapproved template to a paying customer).
 *
 * The registry is the app-side source of truth for "which templates may be
 * sent"; the WABA approval itself is Meta-side and out of scope here.
 */

/** A template approved for one tenant. */
export interface TemplateApproval {
  /** Tenant / app namespace. */
  tenant: string;
  /** Template name as registered with the provider (e.g. `order_update`). */
  templateName: string;
  /** Optional category, e.g. 'utility' | 'marketing' | 'authentication'. */
  category?: string;
  /** Who approved it (admin email, agent id). */
  approvedBy?: string;
  /** When it was approved. */
  approvedAt: Date;
}

/**
 * Persistence seam for approved templates. Apps back this with their own
 * table (see `migrations/0002_whatsapp_core_consent_templates.sql` and
 * {@link PostgresTemplateRegistry}).
 */
export interface TemplateRegistry {
  /** Approve a template for a tenant (idempotent). */
  approve(input: TemplateApproval): Promise<void>;
  /** Remove a template from the tenant's registry. */
  revoke(tenant: string, templateName: string): Promise<void>;
  /** Whether the tenant may currently send this template. */
  isApproved(tenant: string, templateName: string): Promise<boolean>;
  /** All approved templates for a tenant. */
  list(tenant: string): Promise<TemplateApproval[]>;
}

/** In-memory {@link TemplateRegistry} for tests and local dev. */
export class InMemoryTemplateRegistry implements TemplateRegistry {
  private readonly approvals = new Map<string, TemplateApproval>();

  private key(tenant: string, templateName: string): string {
    return `${tenant}\u0000${templateName}`;
  }

  async approve(input: TemplateApproval): Promise<void> {
    this.approvals.set(this.key(input.tenant, input.templateName), input);
  }

  async revoke(tenant: string, templateName: string): Promise<void> {
    this.approvals.delete(this.key(tenant, templateName));
  }

  async isApproved(tenant: string, templateName: string): Promise<boolean> {
    return this.approvals.has(this.key(tenant, templateName));
  }

  async list(tenant: string): Promise<TemplateApproval[]> {
    return [...this.approvals.values()].filter((a) => a.tenant === tenant);
  }
}
