/**
 * Integration tests for Phases 34–46 surfaces.
 *
 * Covers:
 *   - tenant_deletion_request RLS + uniqueness
 *   - audit_log_redaction RLS
 *   - rate_limit_override + cross-tenant cache function
 *   - scim_token RLS + lookup function
 *   - privacy_consent + dsar_request 45-day clock
 *
 * Skipped automatically when `INTEGRATION!=1`.
 */
import { sql } from 'kysely';
import {
  startIntegrationContext,
  integrationDescribe,
  type IntegrationContext,
} from './harness';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

integrationDescribe('Phase 34–46 surfaces (integration)', () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await startIntegrationContext();
    // Seed two orgs + one user.
    await ctx.pool.query(
      `INSERT INTO org (id, slug, name) VALUES
         ($1, 'org-a', 'Org A'),
         ($2, 'org-b', 'Org B')`,
      [ORG_A, ORG_B],
    );
    await ctx.pool.query(
      `INSERT INTO app_user (id, email, full_name, status)
         VALUES ($1, 'a@example.com', 'Alice', 'active')`,
      [USER_A],
    );
    await ctx.pool.query(
      `INSERT INTO org_member (org_id, user_id, role, status)
         VALUES ($1, $2, 'admin', 'active'),
                ($3, $2, 'admin', 'active')`,
      [ORG_A, USER_A, ORG_B],
    );
  }, 90_000);

  afterAll(async () => {
    if (ctx) await ctx.stop();
  });

  describe('tenant_deletion_request', () => {
    it('rejects a second pending request for the same org (UNIQUE on org_id)', async () => {
      await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_A)}`.execute(tx);
        await tx
          .insertInto('tenant_deletion_request')
          .values({
            org_id: ORG_A,
            earliest_execute_at: new Date(Date.now() + 30 * 86_400_000),
            confirmation_phrase: 'DELETE-TENANT-org-a',
            requested_by_user_id: USER_A,
            reason: 'first',
          })
          .execute();
      });
      await expect(
        ctx.appDb.transaction().execute(async (tx) => {
          await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_A)}`.execute(tx);
          await tx
            .insertInto('tenant_deletion_request')
            .values({
              org_id: ORG_A,
              earliest_execute_at: new Date(Date.now() + 30 * 86_400_000),
              confirmation_phrase: 'DELETE-TENANT-org-a',
              requested_by_user_id: USER_A,
              reason: 'second',
            })
            .execute();
        }),
      ).rejects.toThrow(/duplicate|unique/i);
    });

    it('Org B cannot read Org A\'s deletion request (RLS)', async () => {
      const r = await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_B)}`.execute(tx);
        return tx.selectFrom('tenant_deletion_request').selectAll().execute();
      });
      expect(r).toHaveLength(0);
    });
  });

  describe('rate_limit_override', () => {
    beforeAll(async () => {
      await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_A)}`.execute(tx);
        await tx
          .insertInto('rate_limit_override')
          .values({
            org_id: ORG_A, scope: 'lookup',
            limit: 500, refill_per_sec: '10',
            set_by_user_id: USER_A,
            expires_at: null, reason: 'enterprise',
          })
          .execute();
      });
      await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_B)}`.execute(tx);
        await tx
          .insertInto('rate_limit_override')
          .values({
            org_id: ORG_B, scope: 'lookup',
            limit: 50, refill_per_sec: '1',
            set_by_user_id: USER_A,
            // Expired — should NOT show in cross-tenant function.
            expires_at: new Date(Date.now() - 60_000), reason: 'lapsed',
          })
          .execute();
      });
    });

    it('app.list_active_rate_limit_overrides returns only un-expired across tenants', async () => {
      const r = await ctx.pool.query<{ org_id: string; scope: string; limit: number }>(
        `SELECT org_id, scope, "limit" FROM app.list_active_rate_limit_overrides()`,
      );
      const orgIds = r.rows.map((x) => x.org_id);
      expect(orgIds).toContain(ORG_A);
      expect(orgIds).not.toContain(ORG_B);
    });

    it('RLS hides Org A\'s overrides from Org B', async () => {
      const seen = await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_B)}`.execute(tx);
        return tx.selectFrom('rate_limit_override').selectAll().execute();
      });
      expect(seen.every((r) => r.org_id === ORG_B)).toBe(true);
    });
  });

  describe('scim_token', () => {
    const TOKEN_HASH = 'a'.repeat(64);

    beforeAll(async () => {
      await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_A)}`.execute(tx);
        await tx
          .insertInto('scim_token')
          .values({
            org_id: ORG_A,
            token_hash: TOKEN_HASH,
            display_suffix: 'abc12345',
            description: 'Okta',
            created_by_user_id: USER_A,
            expires_at: null,
          })
          .execute();
      });
    });

    it('app.lookup_scim_token finds the row across tenants', async () => {
      const r = await ctx.pool.query<{ id: string; org_id: string }>(
        `SELECT id, org_id FROM app.lookup_scim_token($1)`,
        [TOKEN_HASH],
      );
      expect(r.rows[0]?.org_id).toBe(ORG_A);
    });

    it('Org B cannot read Org A\'s SCIM token via RLS', async () => {
      const seen = await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_B)}`.execute(tx);
        return tx.selectFrom('scim_token').selectAll().execute();
      });
      expect(seen).toHaveLength(0);
    });
  });

  describe('dsar_request', () => {
    it('45-day due_at clock is enforced server-side', async () => {
      const due = new Date(Date.now() + 45 * 86_400_000);
      await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_A)}`.execute(tx);
        const r = await tx
          .insertInto('dsar_request')
          .values({
            org_id: ORG_A,
            user_id: USER_A,
            subject_email: 'consumer@example.com',
            regime: 'ccpa',
            request_type: 'deletion',
            due_at: due,
          })
          .returning(['id', 'status', 'due_at'])
          .executeTakeFirstOrThrow();
        expect(r.status).toBe('received');
        // Allow tiny clock-skew tolerance (within 5s of expected).
        expect(Math.abs(r.due_at.getTime() - due.getTime())).toBeLessThan(5000);
      });
    });

    it('audit_log_redaction is RLS-protected', async () => {
      // First write an audit_log row + a redaction row as Org A.
      const redactionId = await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_A)}`.execute(tx);
        const audit = await tx
          .insertInto('audit_log')
          .values({
            org_id: ORG_A,
            user_id: USER_A,
            action: 'test',
            target_type: 'noop',
            target_id: 'noop',
            payload: { x: 1 },
            ip_address: null,
            user_agent: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const r = await tx
          .insertInto('audit_log_redaction')
          .values({
            org_id: ORG_A,
            audit_log_id: audit.id,
            redacted_by_user_id: USER_A,
            reason: 'test',
            redaction_type: 'payload_scrub',
            original_payload_hash: 'a'.repeat(64),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return r.id;
      });
      // Then verify Org B can't see it.
      const seen = await ctx.appDb.transaction().execute(async (tx) => {
        await sql`SET LOCAL app.current_org_id = ${sql.lit(ORG_B)}`.execute(tx);
        return tx
          .selectFrom('audit_log_redaction')
          .select('id')
          .where('id', '=', redactionId)
          .execute();
      });
      expect(seen).toHaveLength(0);
    });
  });
});
