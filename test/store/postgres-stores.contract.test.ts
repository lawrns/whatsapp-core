/**
 * Contract tests for the Postgres-backed reference stores, run against a real
 * Postgres database. Requires WHATSAPP_CORE_TEST_DATABASE_URL to be set to a
 * connection string for a disposable/local Postgres — the suite creates and
 * drops its own isolated schema, so it never touches other data in that
 * database. When the env var is absent the suite is skipped (not failed) so
 * `npm test` stays green for developers without a local Postgres.
 */
import { describe, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  PostgresOptOutStore,
  PostgresSessionStore,
  PostgresMediaStore,
  PostgresConsentLedger,
  PostgresTemplateRegistry,
  PostgresEscalationStore,
  ensureWhatsAppCoreSchema,
} from '../../src/store/postgres.js';
import { optOutStoreContract } from '../contract/opt-out-store.contract.js';
import { sessionStoreContract } from '../contract/session-store.contract.js';
import { mediaStoreContract } from '../contract/media-store.contract.js';
import { consentLedgerContract } from '../contract/consent-ledger.contract.js';
import { templateRegistryContract } from '../contract/template-registry.contract.js';
import { escalationStoreContract } from '../contract/escalation-store.contract.js';

const { Pool } = pg;

const DATABASE_URL = process.env.WHATSAPP_CORE_TEST_DATABASE_URL;
const SCHEMA = 'whatsapp_core_test_contract';

describe.skipIf(!DATABASE_URL)('Postgres-backed stores — contract', () => {
  let pool: InstanceType<typeof Pool>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await ensureWhatsAppCoreSchema(pool, { schema: SCHEMA });
  });

  afterAll(async () => {
    await pool.query(`drop schema if exists ${SCHEMA} cascade`);
    await pool.end();
  });

  describe('PostgresOptOutStore', () => {
    optOutStoreContract(() => new PostgresOptOutStore(pool, { schema: SCHEMA }), 'pgopt');
  });

  describe('PostgresSessionStore', () => {
    sessionStoreContract(() => new PostgresSessionStore(pool, { schema: SCHEMA }), 'pgses');
  });

  describe('PostgresMediaStore', () => {
    mediaStoreContract(() => new PostgresMediaStore(pool, { schema: SCHEMA }));
  });

  describe('PostgresConsentLedger', () => {
    consentLedgerContract(() => new PostgresConsentLedger(pool, { schema: SCHEMA }), 'pgc');
  });

  describe('PostgresTemplateRegistry', () => {
    templateRegistryContract(() => new PostgresTemplateRegistry(pool, { schema: SCHEMA }), 'pgt');
  });

  describe('PostgresEscalationStore', () => {
    escalationStoreContract(() => new PostgresEscalationStore(pool, { schema: SCHEMA }), 'pge');
  });
});
