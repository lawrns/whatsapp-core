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
