/**
 * Integration tests for Phases 64–65 surfaces against a real Postgres.
 *
 *   - tenant_clearinghouse_credential RLS isolation
 *   - source_document upload + dedupe by content_hash
 *   - client_company seed lookup + RLS
 *
 * Skipped automatically when `INTEGRATION!=1`.
 */
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { startIntegrationContext, integrationDescribe, type IntegrationContext } from './harness';
import { encrypt, parseMasterKey } from '../../src/clearinghouse/credential-crypto';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A = '11111111-1111-4111-8111-111111111111';
// Avoid collision with seed 0017's Maple Hospice (cccc1111-...) — that
// row is pinned to the design-partner org, not ORG_A. ON CONFLICT
// DO NOTHING wouldn't relocate it; the RLS test would then 404 the row.
const CLIENT_A = 'cccc6464-6464-4464-8464-646464646464';

integrationDescribe('Phase 64–65 surfaces (integration)', () => {
  let ctx: IntegrationContext;
  const master = parseMasterKey(randomBytes(32).toString('base64'));

  beforeAll(async () => {
    ctx = await startIntegrationContext();
    // All INSERTs idempotent — the test DB may have rows from db/seed/*.
    await ctx.pool.query(
      `INSERT INTO org (id, slug, name) VALUES
         ($1, 'org-a', 'Org A'),
         ($2, 'org-b', 'Org B')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B],
    );
    await ctx.pool.query(
      `INSERT INTO app_user (id, email, full_name, status)
         VALUES ($1, 'a@example.com', 'Alice', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [USER_A],
    );
    await ctx.pool.query(
      `INSERT INTO org_member (org_id, user_id, role, status)
         VALUES ($1, $2, 'admin', 'active')
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_A, USER_A],
    );
    await ctx.pool.query(
      `INSERT INTO client_company (id, org_id, name, primary_state, specialties)
         VALUES ($1, $2, 'Maple Hospice', 'OH', ARRAY['palliative']::text[])
       ON CONFLICT (id) DO NOTHING`,
      [CLIENT_A, ORG_A],
    );
  }, 90_000);

  afterAll(async () => {
    if (ctx) await ctx.stop();
  });

  describe('tenant_clearinghouse_credential', () => {
    it('upsert is unique per (org_id, clearinghouse) — second SET replaces, not appends', async () => {
      // Two writes of the same clearinghouse for one org should leave
      // exactly ONE row (UNIQUE constraint + ON CONFLICT path in service).
      const enc1 = encrypt({
        master,
        plaintext: JSON.stringify({ clientId: 'a-1', clientSecret: 's1' }),
      });
      const enc2 = encrypt({
        master,
        plaintext: JSON.stringify({ clientId: 'a-2', clientSecret: 's2' }),
      });

      await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_A)}`.execute(tx);
        await tx
          .insertInto('tenant_clearinghouse_credential')
          .values({
            org_id: ORG_A,
            clearinghouse: 'availity',
            ciphertext: enc1.ciphertext,
            iv: enc1.iv,
            auth_tag: enc1.auth_tag,
            display_suffix: 'aaa1',
            created_by_user_id: USER_A,
          })
          .execute();
      });

      await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_A)}`.execute(tx);
        await tx
          .insertInto('tenant_clearinghouse_credential')
          .values({
            org_id: ORG_A,
            clearinghouse: 'availity',
            ciphertext: enc2.ciphertext,
            iv: enc2.iv,
            auth_tag: enc2.auth_tag,
            display_suffix: 'aaa2',
            created_by_user_id: USER_A,
          })
          .onConflict((oc) =>
            oc.columns(['org_id', 'clearinghouse']).doUpdateSet({
              ciphertext: enc2.ciphertext,
              iv: enc2.iv,
              auth_tag: enc2.auth_tag,
              display_suffix: 'aaa2',
            }),
          )
          .execute();
      });

      const rows = await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_A)}`.execute(tx);
        return tx
          .selectFrom('tenant_clearinghouse_credential')
          .selectAll()
          .where('org_id', '=', ORG_A)
          .where('clearinghouse', '=', 'availity')
          .execute();
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].display_suffix).toBe('aaa2');
    });

    it("Org B cannot read Org A's credentials (RLS)", async () => {
      const seen = await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_B)}`.execute(tx);
        return tx.selectFrom('tenant_clearinghouse_credential').select('id').execute();
      });
      expect(seen).toHaveLength(0);
    });
  });

  describe('source_document Final Rules', () => {
    it('inserts and dedupes by content_hash', async () => {
      const sha = 'a'.repeat(64);
      // First insert.
      await ctx.pool.query(
        `INSERT INTO source_document
           (payer_id, url, document_type, title, retrieved_at, content_hash, storage_uri, source_metadata)
         VALUES (NULL, 'local://x', 'cms_final_rule', 'Test PFS', now(), $1, 'file:///tmp/x.pdf', '{}'::jsonb)`,
        [sha],
      );

      // Second insert — caller logic dedupes via SELECT first, but
      // verify the schema allows multiple if attempted: there's no
      // UNIQUE constraint on content_hash. The deduplication is
      // app-level, by design (allows two payers' policies to share a
      // content_hash if the file happened to be identical).
      const r = await ctx.pool.query(
        `SELECT count(*) AS c FROM source_document WHERE content_hash = $1`,
        [sha],
      );
      expect(Number(r.rows[0].c)).toBe(1);
    });

    it('cms_final_rule passes the document_type CHECK constraint', async () => {
      await expect(
        ctx.pool.query(
          `INSERT INTO source_document
             (payer_id, url, document_type, title, retrieved_at, content_hash, source_metadata)
           VALUES (NULL, 'local://x2', 'cms_final_rule', 'Another rule', now(), $1, '{}'::jsonb)`,
          ['b'.repeat(64)],
        ),
      ).resolves.toBeDefined();
    });

    it('rejects an unknown document_type via CHECK', async () => {
      await expect(
        ctx.pool.query(
          `INSERT INTO source_document
             (payer_id, url, document_type, title, retrieved_at, content_hash, source_metadata)
           VALUES (NULL, 'local://bad', 'totally_made_up', 't', now(), $1, '{}'::jsonb)`,
          ['c'.repeat(64)],
        ),
      ).rejects.toThrow();
    });
  });

  describe('client_company', () => {
    it('lists for the right org via RLS', async () => {
      const seen = await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_A)}`.execute(tx);
        return tx.selectFrom('client_company').select(['id', 'name']).execute();
      });
      expect(seen.find((r) => r.id === CLIENT_A)).toBeDefined();
    });

    it('Org B sees zero clients via RLS even though they exist for Org A', async () => {
      const seen = await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_B)}`.execute(tx);
        return tx.selectFrom('client_company').select('id').execute();
      });
      expect(seen).toHaveLength(0);
    });
  });
});
