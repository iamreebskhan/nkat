/**
 * Tenant clearinghouse credential service.
 *
 *   set    — encrypt + upsert (one credential per (org, clearinghouse))
 *   get    — fetch + decrypt (in-memory only; never logs the plaintext)
 *   list   — return display-only metadata; no plaintext
 *   remove — delete the row
 *   recordVerification — stamp last_verified_at after a test-connection call
 *
 * Master key comes from `CREDENTIAL_ENCRYPTION_KEY` env (base64, 32 bytes).
 * In dev the operator generates one with `node -e "...randomBytes(32)..."`.
 * In prod it's a Secrets Manager entry mounted onto the ECS task.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';
import type { Clearinghouse } from '../database/schema.types';
import {
  decrypt,
  displaySuffix,
  encrypt,
  parseMasterKey,
  type EncryptedPayload,
} from './credential-crypto';

export interface SetInput {
  orgId: string;
  userId: string | null;
  clearinghouse: Clearinghouse;
  /**
   * Plaintext credential payload — shape depends on the clearinghouse:
   *   availity:          { clientId, clientSecret }
   *   change_healthcare: { username, password, traderId }
   *   waystar:           { apiKey, accountId }
   * The service doesn't validate the shape — that's the client adapter's job.
   */
  payload: Record<string, unknown>;
  label?: string | null;
}

export interface ListItem {
  id: string;
  clearinghouse: Clearinghouse;
  display_suffix: string;
  label: string | null;
  last_verified_at: Date | null;
  last_verification_status: 'ok' | 'failed' | null;
  last_verification_error: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class ClearinghouseCredentialService implements OnModuleInit {
  private readonly log = new Logger(ClearinghouseCredentialService.name);
  private master: Buffer | null = null;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.CREDENTIAL_ENCRYPTION_KEY) {
      try {
        this.master = parseMasterKey(this.env.CREDENTIAL_ENCRYPTION_KEY);
        this.log.log('clearinghouse credential service ready');
      } catch (e) {
        // Don't crash the app — surface the error at first use instead.
        this.log.warn(
          `CREDENTIAL_ENCRYPTION_KEY invalid (${(e as Error).message}); ` +
            `clearinghouse credentials are unavailable until fixed.`,
        );
      }
    } else {
      this.log.warn(
        'CREDENTIAL_ENCRYPTION_KEY not set; clearinghouse credentials are disabled. ' +
          "Generate a key with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    }
  }

  /** Throws a typed error if the service is not initialized. */
  private requireMaster(): Buffer {
    if (!this.master) {
      throw new Error(
        'CREDENTIAL_ENCRYPTION_KEY is not configured; cannot encrypt/decrypt credentials.',
      );
    }
    return this.master;
  }

  isReady(): boolean {
    return this.master !== null;
  }

  async set(input: SetInput): Promise<{ id: string; display_suffix: string }> {
    const master = this.requireMaster();
    const plaintext = JSON.stringify(input.payload);
    const enc = encrypt({ master, plaintext });
    const suffix = displaySuffix(input.payload);

    return runWithTenant(this.db, input.orgId, async (tx) => {
      const r = await tx
        .insertInto('tenant_clearinghouse_credential')
        .values({
          org_id: input.orgId,
          clearinghouse: input.clearinghouse,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          auth_tag: enc.auth_tag,
          display_suffix: suffix,
          label: input.label ?? null,
          created_by_user_id: input.userId,
        })
        .onConflict((oc) =>
          oc.columns(['org_id', 'clearinghouse']).doUpdateSet({
            ciphertext: enc.ciphertext,
            iv: enc.iv,
            auth_tag: enc.auth_tag,
            display_suffix: suffix,
            label: input.label ?? null,
            created_by_user_id: input.userId,
            last_verified_at: null,
            last_verification_status: null,
            last_verification_error: null,
            updated_at: sql`now()`,
          }),
        )
        .returning(['id', 'display_suffix'])
        .executeTakeFirstOrThrow();

      // Audit-log the credential change. NEVER log the plaintext.
      await tx
        .insertInto('audit_log')
        .values({
          org_id: input.orgId,
          user_id: input.userId,
          action: 'clearinghouse_credential.set',
          target_type: 'tenant_clearinghouse_credential',
          target_id: r.id,
          payload: { clearinghouse: input.clearinghouse, display_suffix: suffix },
          ip_address: null,
          user_agent: null,
        })
        .execute();
      return r;
    });
  }

  /**
   * Fetch + decrypt for an outbound API call. Returned object is held
   * in memory only; callers MUST NOT persist or log it.
   */
  async get(orgId: string, clearinghouse: Clearinghouse): Promise<Record<string, unknown> | null> {
    const master = this.requireMaster();
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const row = await tx
        .selectFrom('tenant_clearinghouse_credential')
        .select(['ciphertext', 'iv', 'auth_tag'])
        .where('org_id', '=', orgId)
        .where('clearinghouse', '=', clearinghouse)
        .executeTakeFirst();
      if (!row) return null;
      const payload: EncryptedPayload = {
        ciphertext: row.ciphertext,
        iv: row.iv,
        auth_tag: row.auth_tag,
      };
      const plain = decrypt({ master, payload });
      try {
        return JSON.parse(plain) as Record<string, unknown>;
      } catch {
        // Corrupt JSON — surface as not-found rather than crashing.
        this.log.warn(`org=${orgId} ${clearinghouse} credential JSON is corrupt`);
        return null;
      }
    });
  }

  async list(orgId: string): Promise<ListItem[]> {
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const rows = await tx
        .selectFrom('tenant_clearinghouse_credential')
        .select([
          'id',
          'clearinghouse',
          'display_suffix',
          'label',
          'last_verified_at',
          'last_verification_status',
          'last_verification_error',
          'created_at',
          'updated_at',
        ])
        .where('org_id', '=', orgId)
        .orderBy('clearinghouse', 'asc')
        .execute();
      return rows;
    });
  }

  async remove(orgId: string, id: string, userId: string | null): Promise<boolean> {
    return runWithTenant(this.db, orgId, async (tx) => {
      const r = await tx
        .deleteFrom('tenant_clearinghouse_credential')
        .where('id', '=', id)
        .where('org_id', '=', orgId)
        .returning(['id', 'clearinghouse'])
        .executeTakeFirst();
      if (!r) return false;
      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'clearinghouse_credential.delete',
          target_type: 'tenant_clearinghouse_credential',
          target_id: id,
          payload: { clearinghouse: r.clearinghouse },
          ip_address: null,
          user_agent: null,
        })
        .execute();
      return true;
    });
  }

  async recordVerification(args: {
    orgId: string;
    id: string;
    status: 'ok' | 'failed';
    error: string | null;
  }): Promise<void> {
    await runWithTenant(this.db, args.orgId, async (tx) => {
      await tx
        .updateTable('tenant_clearinghouse_credential')
        .set({
          last_verified_at: sql`now()`,
          last_verification_status: args.status,
          last_verification_error: args.error,
        })
        .where('id', '=', args.id)
        .where('org_id', '=', args.orgId)
        .execute();
    });
  }
}
