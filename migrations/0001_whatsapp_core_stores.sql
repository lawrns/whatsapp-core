-- @portfolio/whatsapp-core — persistent store schema (Slice 1, issue #2).
--
-- Backs OptOutStore / SessionStore / MediaStore for consumers that don't call
-- ensureWhatsAppCoreSchema() programmatically and prefer their own migration
-- tooling (e.g. Supabase CLI migrations). Keep this in sync with
-- whatsAppCoreSchemaSql() in src/store/postgres.ts — schema name below is the
-- library default (`whatsapp_core`); rename both together if you use a
-- non-default schema.

create schema if not exists whatsapp_core;

create table if not exists whatsapp_core.opt_outs (
  phone text primary key,
  keyword text not null,
  opted_out_at timestamptz not null default now()
);

create table if not exists whatsapp_core.sessions (
  phone text primary key,
  last_inbound_at bigint not null
);

create table if not exists whatsapp_core.media (
  id uuid primary key default gen_random_uuid(),
  mime_type text not null,
  filename text,
  size integer not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
