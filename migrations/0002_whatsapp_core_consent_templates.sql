-- @portfolio/whatsapp-core — consent ledger + approved templates + escalations
-- (FYV-585 spine hardening). Slice 2.
--
-- Backs ConsentLedger / TemplateRegistry / EscalationStore. Keep in sync with
-- whatsAppCoreSchemaSql() in src/store/postgres.ts — schema name below is the
-- library default (`whatsapp_core`); rename both together if you use a
-- non-default schema.

create schema if not exists whatsapp_core;

create table if not exists whatsapp_core.consent_events (
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
  on whatsapp_core.consent_events (tenant, phone, at desc);

create table if not exists whatsapp_core.approved_templates (
  tenant text not null,
  template_name text not null,
  category text,
  approved_by text,
  approved_at timestamptz not null default now(),
  primary key (tenant, template_name)
);

create table if not exists whatsapp_core.escalations (
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
  on whatsapp_core.escalations (status, created_at);
