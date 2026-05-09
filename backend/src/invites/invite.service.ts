/**
 * InviteService — issue + redeem magic-link invites.
 *
 *   issue(orgId, userId, role, options) → { rawToken, expiresAt }
 *      The raw token is returned ONCE; the service stores only the
 *      hash + lookup prefix. Caller is responsible for transmitting
 *      the raw token (via email magic-link / handed to ops for manual
 *      delivery while SES BAA is pending).
 *
 *   redeem(rawToken, sourceIp) → { orgId, userId, role, email }
 *      Constant-time hash compare; idempotent — once consumed_at is
 *      set, redemption fails the same way an unknown token would, so
 *      a probing attacker can't distinguish between "already used"
 *      and "never existed".
 *
 * RLS: issue path is invoked from authenticated admin / signup
 * service; both supply orgId. Redeem is anonymous and bypasses RLS via
 * the admin connection — but only for reading the token row + the
 * minimum user/org context. Subsequent calls go through the normal
 * tenant-scoped path.
 */
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../database/schema.types';
import { runWithTenant } from '../database/rls-transaction';
import { EmailService } from '../email/email.service';
import { constantTimeEqual, expiryFromNow, generateToken, parseToken } from './invite-pure';

export interface IssueInput {
  orgId: string;
  userId: string;
  role: 'employee' | 'reviewer' | 'admin' | 'consultant';
  ttlMs?: number;
  issuedByUserId?: string | null;
}

export interface RedeemResult {
  org_id: string;
  user_id: string;
  email: string;
  role: 'employee' | 'reviewer' | 'admin' | 'consultant';
}

@Injectable()
export class InviteService {
  private readonly log = new Logger(InviteService.name);
  constructor(
    private readonly db: Kysely<Database>,
    private readonly email: EmailService,
    private readonly redeemBaseUrl: string,
  ) {}

  async issue(input: IssueInput): Promise<{ rawToken: string; expiresAt: Date; tokenId: string }> {
    const { raw, prefix, hash } = generateToken();
    const expiresAt = expiryFromNow(Date.now(), input.ttlMs);
    const tokenRow = await runWithTenant(this.db, input.orgId, (tx) =>
      tx
        .insertInto('invite_token')
        .values({
          org_id: input.orgId,
          user_id: input.userId,
          token_lookup_prefix: prefix,
          token_hash: hash,
          role: input.role,
          expires_at: expiresAt,
          issued_by: input.issuedByUserId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    this.log.log(
      `invite issued org=${input.orgId} user=${input.userId} role=${input.role} id=${tokenRow.id}`,
    );

    // Best-effort email send. Failure does NOT block issue — the caller
    // gets the raw token in the response and can hand-deliver if needed.
    try {
      const u = await runWithTenant(this.db, input.orgId, async (tx) => {
        const user = await tx
          .selectFrom('app_user')
          .select(['email', 'full_name'])
          .where('id', '=', input.userId)
          .executeTakeFirst();
        if (!user) return null;
        const org = await tx
          .selectFrom('org')
          .select(['name'])
          .where('id', '=', input.orgId)
          .executeTakeFirst();
        if (!org) return null;
        return { email: user.email, org_name: org.name };
      });
      if (u) {
        await this.email.send({
          orgId: input.orgId,
          to: u.email,
          template: 'invite',
          args: {
            org_name: u.org_name,
            redeem_url: `${this.redeemBaseUrl.replace(/\/$/, '')}/invite/${encodeURIComponent(raw)}`,
            expires_at: expiresAt.toISOString(),
            inviter_name: null,
          },
          idempotencyKey: `invite-${tokenRow.id}`,
        });
      }
    } catch (e) {
      // Email is observability noise here; never fail the issue path.
      this.log.warn(
        `invite email send failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return { rawToken: raw, expiresAt, tokenId: tokenRow.id };
  }

  /** Admin: list outstanding invites for the calling tenant. */
  async listForOrg(orgId: string): Promise<
    Array<{
      id: string;
      user_id: string;
      role: 'employee' | 'reviewer' | 'admin' | 'consultant';
      created_at: Date;
      expires_at: Date;
      consumed_at: Date | null;
    }>
  > {
    return runWithTenant(this.db, orgId, (tx) =>
      tx
        .selectFrom('invite_token')
        .select(['id', 'user_id', 'role', 'created_at', 'expires_at', 'consumed_at'])
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute(),
    );
  }

  /**
   * Admin: revoke an invite by id. Sets `consumed_at = now()` so the
   * unique-redemption guard kicks in on any racing redeemer. Returns
   * `true` if a row was updated; `false` if id was unknown or already
   * consumed (admin gets transparency on the action's effect — unlike
   * the redeem path, there's no probing risk here).
   */
  async revoke(orgId: string, inviteId: string): Promise<boolean> {
    return runWithTenant(this.db, orgId, async (tx) => {
      const r = await tx
        .updateTable('invite_token')
        .set({ consumed_at: sql`now()` })
        .where('id', '=', inviteId)
        .where('consumed_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return r != null;
    });
  }

  /**
   * Anonymous redemption. The same opaque error covers every failure
   * mode (unknown / expired / already consumed / mismatched hash) so a
   * probing caller learns nothing.
   */
  async redeem(rawToken: string, sourceIp: string | null): Promise<RedeemResult> {
    const parsed = parseToken(rawToken);
    if (!parsed) throw new UnauthorizedException({ code: 'INVITE_INVALID' });

    // Look up by prefix on the admin connection — the prefix is
    // non-secret on its own, and we still constant-time compare the
    // hash before granting anything.
    const candidates = await this.db
      .selectFrom('invite_token')
      .selectAll()
      .where('token_lookup_prefix', '=', parsed.prefix)
      .where('consumed_at', 'is', null)
      .execute();

    const now = Date.now();
    let match: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      const ok = constantTimeEqual(c.token_hash, parsed.hash);
      if (ok && c.expires_at.getTime() > now) {
        match = c;
        break;
      }
    }
    if (!match) throw new UnauthorizedException({ code: 'INVITE_INVALID' });

    // Mark consumed atomically with the user/email lookup. Use a single
    // transaction with the tenant context so RLS still applies.
    const result = await runWithTenant(this.db, match.org_id, async (tx) => {
      const updated = await tx
        .updateTable('invite_token')
        .set({ consumed_at: sql`now()`, consumed_ip: sourceIp })
        .where('id', '=', match!.id)
        .where('consumed_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!updated) {
        // Lost the race with another redeemer — same opaque error.
        return null;
      }
      // Activate the org_member if currently 'invited'.
      await tx
        .updateTable('org_member')
        .set({ status: 'active', joined_at: sql`now()` })
        .where('org_id', '=', match!.org_id)
        .where('user_id', '=', match!.user_id)
        .where('status', '=', 'invited')
        .execute();

      const u = await tx
        .selectFrom('app_user')
        .select(['email'])
        .where('id', '=', match!.user_id)
        .executeTakeFirst();
      if (!u) return null;
      return {
        org_id: match!.org_id,
        user_id: match!.user_id,
        email: u.email,
        role: match!.role,
      };
    });
    if (!result) throw new UnauthorizedException({ code: 'INVITE_INVALID' });
    this.log.log(`invite redeemed org=${result.org_id} user=${result.user_id}`);
    return result;
  }
}
