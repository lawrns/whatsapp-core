/**
 * Restart-survival tests (issue #2 acceptance criteria): opt-out and
 * session-window state must survive a process restart. We simulate a
 * restart by dropping the first store instance/pool entirely and creating a
 * brand-new one against the same database, then asserting the compliance
 * decision is unchanged.
 *
 * Requires WHATSAPP_CORE_TEST_DATABASE_URL; skipped otherwise (see
 * postgres-stores.contract.test.ts for rationale).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  PostgresOptOutStore,
  PostgresSessionStore,
  ensureWhatsAppCoreSchema,
} from '../../src/store/postgres.js';
import { canSend } from '../../src/session.js';

const { Pool } = pg;

const DATABASE_URL = process.env.WHATSAPP_CORE_TEST_DATABASE_URL;
const SCHEMA = 'whatsapp_core_test_restart';

describe.skipIf(!DATABASE_URL)('Postgres-backed stores — restart survival', () => {
  let setupPool: InstanceType<typeof Pool>;

  beforeAll(async () => {
    setupPool = new Pool({ connectionString: DATABASE_URL });
    await ensureWhatsAppCoreSchema(setupPool, { schema: SCHEMA });
  });

  afterAll(async () => {
    await setupPool.query(`drop schema if exists ${SCHEMA} cascade`);
    await setupPool.end();
  });

  it('opt-out recorded -> new store instance over same DB -> send to that contact still blocked', async () => {
    const phone = '+15559990001';

    const poolA = new Pool({ connectionString: DATABASE_URL });
    const storeA = new PostgresOptOutStore(poolA, { schema: SCHEMA });
    await storeA.optOut(phone, 'STOP');
    await poolA.end(); // simulate the process (and its pool) going away

    // Brand-new pool + store instance, as a restarted process would create.
    const poolB = new Pool({ connectionString: DATABASE_URL });
    const storeB = new PostgresOptOutStore(poolB, { schema: SCHEMA });
    expect(await storeB.isOptedOut(phone)).toBe(true);
    await poolB.end();
  });

  it('session window survives restart — out-of-window non-template send stays blocked', async () => {
    const phone = '+15559990002';
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

    const poolA = new Pool({ connectionString: DATABASE_URL });
    const storeA = new PostgresSessionStore(poolA, { schema: SCHEMA });
    await storeA.recordInbound(phone, twoDaysAgo);
    await poolA.end();

    const poolB = new Pool({ connectionString: DATABASE_URL });
    const storeB = new PostgresSessionStore(poolB, { schema: SCHEMA });
    const session = await storeB.get(phone);

    const freeform = canSend(session, { isTemplate: false });
    expect(freeform.allowed).toBe(false);
    expect(freeform.templateRequired).toBe(true);
    expect(freeform.reason).toBe('session_expired');

    // Templates remain the sanctioned out-of-window send.
    expect(canSend(session, { isTemplate: true }).allowed).toBe(true);
    await poolB.end();
  });
});
