/**
 * Code lookup with AMA-license gating.
 *
 * The AMA's CPT license covers commercial use of the CPT code system.
 * HCPCS Level II is CMS public domain (G/J/A codes etc.) — no license
 * needed. So the gate is on `code_system === 'CPT'` only.
 *
 * Behavior:
 *   - If `AMA_LICENSE_TOKEN` is set in env, descriptors flow through
 *     unchanged.
 *   - If unset, every CPT row returned has its `short_descriptor`
 *     replaced with the placeholder `[AMA license required]`. The
 *     code itself + metadata still flows so downstream rule-lookup
 *     keeps working; we just don't display the textual descriptor.
 *
 * The substitution is done in a pure helper (`gateAmaDescriptors`)
 * so it's trivially unit-testable.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import type { CodeRow } from '../database/schema.types';

export const AMA_PLACEHOLDER = '[AMA license required]';

export interface CodeView {
  code: string;
  code_system: 'CPT' | 'HCPCS2';
  short_descriptor: string;
  category: string | null;
  effective_date: string;
  expiration_date: string | null;
  /**
   * True iff `short_descriptor` was suppressed due to the missing
   * AMA license. Lets the FE render an inline upgrade-call-to-action.
   */
  ama_descriptor_redacted: boolean;
}

interface CodeRowFromDb {
  code: string;
  code_system: CodeRow['code_system'];
  short_descriptor: string;
  category: string | null;
  effective_date: Date;
  expiration_date: Date | null;
}

/**
 * Pure helper: apply the AMA license gate to a row set.
 */
export function gateAmaDescriptors(rows: CodeRowFromDb[], hasLicense: boolean): CodeView[] {
  return rows.map((r) => {
    const isCpt = r.code_system === 'CPT';
    const redact = isCpt && !hasLicense;
    return {
      code: r.code,
      code_system: r.code_system,
      short_descriptor: redact ? AMA_PLACEHOLDER : r.short_descriptor,
      category: r.category,
      effective_date: r.effective_date.toISOString().slice(0, 10),
      expiration_date: r.expiration_date ? r.expiration_date.toISOString().slice(0, 10) : null,
      ama_descriptor_redacted: redact,
    };
  });
}

@Injectable()
export class CodeService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  /** Has the operator wired the AMA license token? */
  hasAmaLicense(): boolean {
    return Boolean(this.env.AMA_LICENSE_TOKEN && this.env.AMA_LICENSE_TOKEN.trim().length > 0);
  }

  async lookup(code: string): Promise<CodeView> {
    const upper = code.toUpperCase();
    const r = await this.db
      .selectFrom('code')
      .select([
        'code',
        'code_system',
        'short_descriptor',
        'category',
        'effective_date',
        'expiration_date',
      ])
      .where('code', '=', upper)
      .executeTakeFirst();
    if (!r) throw new NotFoundException({ code: 'CODE_NOT_FOUND' });
    const [view] = gateAmaDescriptors([r], this.hasAmaLicense());
    return view;
  }

  async search(args: {
    prefix?: string;
    system?: 'CPT' | 'HCPCS2';
    limit?: number;
  }): Promise<CodeView[]> {
    const limit = Math.min(50, Math.max(1, args.limit ?? 20));
    let q = this.db
      .selectFrom('code')
      .select([
        'code',
        'code_system',
        'short_descriptor',
        'category',
        'effective_date',
        'expiration_date',
      ])
      .where('expiration_date', 'is', null)
      .orderBy('code', 'asc')
      .limit(limit);
    if (args.prefix) q = q.where('code', 'like', `${args.prefix.toUpperCase()}%`);
    if (args.system) q = q.where('code_system', '=', args.system);
    const rows = await q.execute();
    return gateAmaDescriptors(rows, this.hasAmaLicense());
  }
}
