/**
 * DB-backed reference implementation of the core's store contracts
 * ({@link OptOutStore}, {@link SessionStore}, {@link MediaStore}), targeting
 * Postgres — the consumers' common stack (Supabase/Postgres).
 *
 * This module intentionally does NOT import the `pg` package: every store
 * takes a {@link SqlExecutor}, a minimal structural interface that `pg`'s
 * `Pool`/`PoolClient`/`Client` already satisfy (as does any other Postgres
 * client exposing `query(text, params) => Promise<{ rows }>`). That keeps the
 * core's runtime dependency count at zero even with a DB-backed store —
 * consumers bring their own Postgres client.
 *
 * Schema: see {@link whatsAppCoreSchemaSql} / `migrations/0001_whatsapp_core_stores.sql`
 * (keep the two in sync).
 */

import type { OptOutStore } from '../optout.js';
import type { SessionState, SessionStore } from '../session.js';
import { createSession } from '../session.js';
import type { FetchedAsset, MediaStore, StoredMedia } from '../media.js';
import type { ConsentEvent, ConsentLedger, ConsentStatus } from '../consent.js';
import type { Escalation, EscalationStore, NewEscalation } from '../escalation.js';
import type { TemplateApproval, TemplateRegistry } from '../templates.js';

/**
 * Minimal Postgres client shape the stores depend on. Satisfied structurally
 * by `pg`'s `Pool`, `PoolClient`, and `Client` — no import of `pg` required.
 */
export interface SqlExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Row[] }>;
}

/** Options shared by every Postgres-backed store. */
export interface PostgresStoreOptions {
  /** Postgres schema the tables live in. Defaults to `whatsapp_core`. */
  schema?: string;
}

/** Options for {@link PostgresMediaStore}. */
export interface PostgresMediaStoreOptions extends PostgresStoreOptions {
  /** URL prefix durable media URLs are built from, e.g. an API route that streams by id. */
  baseUrl?: string;
}

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertIdentifier(value: string, what: string): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The reference schema DDL for a given Postgres schema name (default
 * `whatsapp_core`). Idempotent (`create ... if not exists`), safe to run on
 * every boot. Mirrored in `migrations/0001_whatsapp_core_stores.sql` for
 * consumers that prefer their own migration tooling.
 */
export function whatsAppCoreSchemaSql(schema = 'whatsapp_core'): string {
  const s = assertIdentifier(schema, 'schema name');
  return `
create schema if not exists ${s};

create table if not exists ${s}.opt_outs (
  phone text primary key,
  keyword text not null,
  opted_out_at timestamptz not null default now()
);

create table if not exists ${s}.sessions (
  phone text primary key,
  last_inbound_at bigint not null
);

create table if not exists ${s}.media (
  id uuid primary key default gen_random_uuid(),
  mime_type text not null,
  filename text,
  size integer not null,
  data bytea not null,
  created_at timestamptz not null default now()
);

create table if not exists ${s}.consent_events (
  id bigint generated always as identity primary key,
  tenant text not null,
  phone text not null,
  kind text not null check (kind in ('opt_in', 'opt_out', 'manual')),
  keyword text,
  channel text,
  actor text,
  note text,
  at timestamptz not null default now()
);
create index if not exists consent_events_tenant_phone_at
  on ${s}.consent_events (tenant, phone, at desc);

create table if not exists ${s}.approved_templates (
  tenant text not null,
  template_name text not null,
  category text,
  approved_by text,
  approved_at timestamptz not null default now(),
  primary key (tenant, template_name)
);

create table if not exists ${s}.escalations (
  id uuid primary key default gen_random_uuid(),
  tenant text not null,
  phone text not null,
  reason text not null,
  context text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text
);
create index if not exists escalations_open
  on ${s}.escalations (status, created_at);
`;
}

/** Runs {@link whatsAppCoreSchemaSql} against `executor`. Safe to call on every boot. */
export async function ensureWhatsAppCoreSchema(
  executor: SqlExecutor,
  options?: PostgresStoreOptions
): Promise<void> {
  await executor.query(whatsAppCoreSchemaSql(options?.schema ?? 'whatsapp_core'));
}

/** Postgres-backed {@link OptOutStore}. Survives process restarts. */
export class PostgresOptOutStore implements OptOutStore {
  private readonly schema: string;

  constructor(
    private readonly executor: SqlExecutor,
    options?: PostgresStoreOptions
  ) {
    this.schema = assertIdentifier(options?.schema ?? 'whatsapp_core', 'schema name');
  }

  async optOut(phone: string, keyword: string): Promise<void> {
    await this.executor.query(
      `insert into ${this.schema}.opt_outs (phone, keyword, opted_out_at)
       values ($1, $2, now())
       on conflict (phone) do update set keyword = $2, opted_out_at = now()`,
      [phone, keyword]
    );
  }

  async optIn(phone: string): Promise<void> {
    await this.executor.query(`delete from ${this.schema}.opt_outs where phone = $1`, [phone]);
  }

  async isOptedOut(phone: string): Promise<boolean> {
    const { rows } = await this.executor.query(
      `select 1 from ${this.schema}.opt_outs where phone = $1 limit 1`,
      [phone]
    );
    return rows.length > 0;
  }
}

function coerceEpochMs(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  if (value instanceof Date) return value.getTime();
  throw new Error(`Cannot coerce session timestamp: ${String(value)}`);
}

/** Postgres-backed {@link SessionStore}. Survives process restarts. */
export class PostgresSessionStore implements SessionStore {
  private readonly schema: string;

  constructor(
    private readonly executor: SqlExecutor,
    options?: PostgresStoreOptions
  ) {
    this.schema = assertIdentifier(options?.schema ?? 'whatsapp_core', 'schema name');
  }

  async get(phone: string): Promise<SessionState> {
    const { rows } = await this.executor.query<{ last_inbound_at: unknown }>(
      `select last_inbound_at from ${this.schema}.sessions where phone = $1`,
      [phone]
    );
    const row = rows[0];
    if (!row) return createSession();
    return { lastInboundAt: coerceEpochMs(row.last_inbound_at) };
  }

  async recordInbound(phone: string, inboundAt: Date | number): Promise<SessionState> {
    const ms = inboundAt instanceof Date ? inboundAt.getTime() : inboundAt;
    await this.executor.query(
      `insert into ${this.schema}.sessions (phone, last_inbound_at)
       values ($1, $2)
       on conflict (phone) do update set last_inbound_at = $2`,
      [phone, ms]
    );
    return { lastInboundAt: ms };
  }
}

/** Postgres-backed {@link MediaStore}. Stores asset bytes as `bytea`. */
export class PostgresMediaStore implements MediaStore {
  private readonly schema: string;
  private readonly baseUrl: string;

  constructor(
    private readonly executor: SqlExecutor,
    options?: PostgresMediaStoreOptions
  ) {
    this.schema = assertIdentifier(options?.schema ?? 'whatsapp_core', 'schema name');
    this.baseUrl = options?.baseUrl ?? 'pg://whatsapp-core-media';
  }

  async put(asset: FetchedAsset): Promise<StoredMedia> {
    const { rows } = await this.executor.query<{ id: string }>(
      `insert into ${this.schema}.media (mime_type, filename, size, data)
       values ($1, $2, $3, $4)
       returning id`,
      [asset.mimeType, asset.filename ?? null, asset.data.byteLength, Buffer.from(asset.data)]
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('PostgresMediaStore: insert did not return an id');
    return {
      url: `${this.baseUrl}/${id}`,
      key: id,
      mimeType: asset.mimeType,
      size: asset.data.byteLength,
    };
  }

  /** Test/inspection helper: retrieve a stored asset by its key (row id). */
  async get(key: string): Promise<FetchedAsset | undefined> {
    const { rows } = await this.executor.query<{
      mime_type: string;
      filename: string | null;
      data: Buffer;
    }>(`select mime_type, filename, data from ${this.schema}.media where id = $1`, [key]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      data: new Uint8Array(row.data),
      mimeType: row.mime_type,
      ...(row.filename !== null ? { filename: row.filename } : {}),
    };
  }
}

/** Postgres-backed {@link ConsentLedger}. Append-only audit trail. */
export class PostgresConsentLedger implements ConsentLedger {
  private readonly schema: string;

  constructor(
    private readonly executor: SqlExecutor,
    options?: PostgresStoreOptions
  ) {
    this.schema = assertIdentifier(options?.schema ?? 'whatsapp_core', 'schema name');
  }

  async record(event: ConsentEvent): Promise<void> {
    await this.executor.query(
      `insert into ${this.schema}.consent_events
         (tenant, phone, kind, keyword, channel, actor, note, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.tenant,
        event.phone,
        event.kind,
        event.keyword ?? null,
        event.channel ?? null,
        event.actor ?? null,
        event.note ?? null,
        event.at,
      ]
    );
  }

  async history(tenant: string, phone: string): Promise<ConsentEvent[]> {
    const { rows } = await this.executor.query<{
      kind: string;
      keyword: string | null;
      channel: string | null;
      actor: string | null;
      note: string | null;
      at: Date | string;
    }>(
      `select kind, keyword, channel, actor, note, at
         from ${this.schema}.consent_events
        where tenant = $1 and phone = $2
        order by at desc, id desc`,
      [tenant, phone]
    );
    return rows.map((row) => ({
      tenant,
      phone,
      kind: row.kind as ConsentEvent['kind'],
      ...(row.keyword !== null ? { keyword: row.keyword } : {}),
      ...(row.channel !== null ? { channel: row.channel } : {}),
      ...(row.actor !== null ? { actor: row.actor } : {}),
      ...(row.note !== null ? { note: row.note } : {}),
      at: row.at instanceof Date ? row.at : new Date(row.at),
    }));
  }

  async status(tenant: string, phone: string): Promise<ConsentStatus> {
    const { rows } = await this.executor.query<{ kind: string }>(
      `select kind
         from ${this.schema}.consent_events
        where tenant = $1 and phone = $2
        order by at desc, id desc
        limit 1`,
      [tenant, phone]
    );
    const kind = rows[0]?.kind;
    if (!kind) return { optedOut: false };
    const [lastEvent] = await this.history(tenant, phone);
    return lastEvent === undefined
      ? { optedOut: kind === 'opt_out' }
      : { optedOut: kind === 'opt_out', lastEvent };
  }
}

/** Postgres-backed {@link TemplateRegistry}. Per-tenant approved templates. */
export class PostgresTemplateRegistry implements TemplateRegistry {
  private readonly schema: string;

  constructor(
    private readonly executor: SqlExecutor,
    options?: PostgresStoreOptions
  ) {
    this.schema = assertIdentifier(options?.schema ?? 'whatsapp_core', 'schema name');
  }

  async approve(input: TemplateApproval): Promise<void> {
    await this.executor.query(
      `insert into ${this.schema}.approved_templates
         (tenant, template_name, category, approved_by, approved_at)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant, template_name) do update set
         category = excluded.category,
         approved_by = excluded.approved_by,
         approved_at = excluded.approved_at`,
      [
        input.tenant,
        input.templateName,
        input.category ?? null,
        input.approvedBy ?? null,
        input.approvedAt,
      ]
    );
  }

  async revoke(tenant: string, templateName: string): Promise<void> {
    await this.executor.query(
      `delete from ${this.schema}.approved_templates
        where tenant = $1 and template_name = $2`,
      [tenant, templateName]
    );
  }

  async isApproved(tenant: string, templateName: string): Promise<boolean> {
    const { rows } = await this.executor.query(
      `select 1 from ${this.schema}.approved_templates
        where tenant = $1 and template_name = $2 limit 1`,
      [tenant, templateName]
    );
    return rows.length > 0;
  }

  async list(tenant: string): Promise<TemplateApproval[]> {
    const { rows } = await this.executor.query<{
      template_name: string;
      category: string | null;
      approved_by: string | null;
      approved_at: Date | string;
    }>(
      `select template_name, category, approved_by, approved_at
         from ${this.schema}.approved_templates
        where tenant = $1
        order by approved_at desc`,
      [tenant]
    );
    return rows.map((row) => ({
      tenant,
      templateName: row.template_name,
      ...(row.category !== null ? { category: row.category } : {}),
      ...(row.approved_by !== null ? { approvedBy: row.approved_by } : {}),
      approvedAt: row.approved_at instanceof Date ? row.approved_at : new Date(row.approved_at),
    }));
  }
}

/** Postgres-backed {@link EscalationStore}. Human-review queue. */
export class PostgresEscalationStore implements EscalationStore {
  private readonly schema: string;

  constructor(
    private readonly executor: SqlExecutor,
    options?: PostgresStoreOptions
  ) {
    this.schema = assertIdentifier(options?.schema ?? 'whatsapp_core', 'schema name');
  }

  async escalate(input: NewEscalation): Promise<Escalation> {
    const { rows } = await this.executor.query<{ id: string; created_at: Date | string }>(
      `insert into ${this.schema}.escalations (tenant, phone, reason, context)
       values ($1, $2, $3, $4)
       returning id, created_at`,
      [input.tenant, input.phone, input.reason, input.context ?? null]
    );
    const row = rows[0];
    if (!row) throw new Error('PostgresEscalationStore: insert did not return a row');
    return {
      ...input,
      id: row.id,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      status: 'open',
    };
  }

  async listOpen(tenant?: string): Promise<Escalation[]> {
    const { rows } = await this.executor.query<{
      id: string;
      tenant: string;
      phone: string;
      reason: string;
      context: string | null;
      created_at: Date | string;
      status: string;
      resolved_at: Date | string | null;
      resolution: string | null;
    }>(
      `select id, tenant, phone, reason, context, created_at, status, resolved_at, resolution
         from ${this.schema}.escalations
        where status = 'open' and ($1::text is null or tenant = $1)
        order by created_at desc`,
      [tenant ?? null]
    );
    return rows.map((row) => ({
      id: row.id,
      tenant: row.tenant,
      phone: row.phone,
      reason: row.reason as Escalation['reason'],
      ...(row.context !== null ? { context: row.context } : {}),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      status: row.status as Escalation['status'],
      ...(row.resolved_at !== null
        ? { resolvedAt: row.resolved_at instanceof Date ? row.resolved_at : new Date(row.resolved_at) }
        : {}),
      ...(row.resolution !== null ? { resolution: row.resolution } : {}),
    }));
  }

  async resolve(id: string, resolution: string): Promise<Escalation | undefined> {
    // The table key is a uuid; a non-uuid id is simply "not found", matching
    // the in-memory store's semantics instead of throwing a PG error.
    if (!UUID_RE.test(id)) return undefined;
    const { rows } = await this.executor.query<{
      tenant: string;
      phone: string;
      reason: string;
      context: string | null;
      created_at: Date | string;
      status: string;
      resolved_at: Date | string | null;
      resolution: string | null;
    }>(
      `update ${this.schema}.escalations
          set status = 'resolved', resolved_at = now(), resolution = $2
        where id = $1 and status = 'open'
        returning tenant, phone, reason, context, created_at, status, resolved_at, resolution`,
      [id, resolution]
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      id,
      tenant: row.tenant,
      phone: row.phone,
      reason: row.reason as Escalation['reason'],
      ...(row.context !== null ? { context: row.context } : {}),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      status: row.status as Escalation['status'],
      ...(row.resolved_at !== null
        ? { resolvedAt: row.resolved_at instanceof Date ? row.resolved_at : new Date(row.resolved_at) }
        : {}),
      ...(row.resolution !== null ? { resolution: row.resolution } : {}),
    };
  }
}
