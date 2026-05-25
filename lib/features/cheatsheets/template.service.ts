/**
 * Cheat-sheet templates — Phase G operator review queue.
 *
 * Pure operator-side concept: templates are global reference, not
 * tenant-scoped. The functions here use withBreakglass (admin role)
 * because they cross the org boundary by design.
 *
 * Lifecycle:
 *   scanForCandidates()  — scheduled cron / on-demand discovery.
 *                          Finds (payer, state) combos with >= N
 *                          covered rules and no existing template;
 *                          inserts a pending_review row.
 *   listTemplates()      — operator view (pending + published).
 *   publishTemplate()    — Hamda clicks "Publish".
 *   withdrawTemplate()   — Hamda pulls a previously published combo.
 *   listPublishedForOrg()— org-side: only published rows.
 */
import { withBreakglass } from "@/lib/db";

export type CheatsheetTemplateStatus =
  | "pending_review"
  | "published"
  | "withdrawn";

export interface CheatsheetTemplateView {
  id: string;
  payerId: string;
  payerName: string;
  state: string;
  status: CheatsheetTemplateStatus;
  ruleCountAtCreation: number;
  ruleCountNow: number;
  notes: string | null;
  createdAt: string;
  publishedAt: string | null;
}

/**
 * Scan for new candidate combos. Default threshold: 5 covered rules
 * for the (payer, state) pair — meaningful enough to justify a sheet.
 *
 * Idempotent — UNIQUE (payer_id, state) prevents duplicates.
 */
export async function scanForCandidates(opts: {
  minRules?: number;
} = {}): Promise<{ created: number; scanned: number }> {
  const minRules = opts.minRules ?? 5;
  return withBreakglass(async (client) => {
    const candidates = await client.$queryRaw<
      { payer_id: string; state: string; n: bigint }[]
    >`
      SELECT payer_id, state, COUNT(*)::bigint AS n
        FROM payer_rule
       WHERE attribute = 'covered'
         AND coverage_status IN ('covered', 'varies')
         AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
         AND superseded_by IS NULL
       GROUP BY payer_id, state
       HAVING COUNT(*) >= ${minRules}
    `;
    let created = 0;
    for (const c of candidates) {
      const res = await client.$executeRaw`
        INSERT INTO cheat_sheet_template (payer_id, state, rule_count_at_creation)
        VALUES (${c.payer_id}::uuid, ${c.state}, ${Number(c.n)})
        ON CONFLICT (payer_id, state) DO NOTHING
      `;
      if (res > 0) created += 1;
    }
    return { created, scanned: candidates.length };
  }, "Phase G cheatsheet-template candidate scan");
}

interface TemplateRow {
  id: string;
  payer_id: string;
  payer_name: string;
  state: string;
  status: CheatsheetTemplateStatus;
  rule_count_at_creation: number;
  rule_count_now: bigint;
  notes: string | null;
  created_at: Date;
  published_at: Date | null;
}

export async function listTemplates(args: {
  status?: CheatsheetTemplateStatus;
}): Promise<CheatsheetTemplateView[]> {
  return withBreakglass(async (client) => {
    const rows = await client.$queryRaw<TemplateRow[]>`
      SELECT
        t.id, t.payer_id, p.name AS payer_name, t.state, t.status,
        t.rule_count_at_creation, t.notes, t.created_at, t.published_at,
        (
          SELECT COUNT(*) FROM payer_rule pr
           WHERE pr.payer_id = t.payer_id
             AND pr.state = t.state
             AND pr.attribute = 'covered'
             AND pr.coverage_status IN ('covered','varies')
             AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
             AND pr.superseded_by IS NULL
        ) AS rule_count_now
      FROM cheat_sheet_template t
      JOIN payer p ON p.id = t.payer_id
      WHERE (${args.status ?? null}::text IS NULL OR t.status = ${args.status ?? null})
      ORDER BY
        CASE t.status WHEN 'pending_review' THEN 0 WHEN 'published' THEN 1 ELSE 2 END,
        t.created_at DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      payerId: r.payer_id,
      payerName: r.payer_name,
      state: r.state,
      status: r.status,
      ruleCountAtCreation: r.rule_count_at_creation,
      ruleCountNow: Number(r.rule_count_now),
      notes: r.notes,
      createdAt: r.created_at.toISOString(),
      publishedAt: r.published_at?.toISOString() ?? null,
    }));
  }, "operator list cheatsheet templates");
}

export async function publishTemplate(args: {
  id: string;
  userId: string;
  notes?: string;
}): Promise<{ published: boolean }> {
  return withBreakglass(async (client) => {
    const updated = await client.$executeRaw`
      UPDATE cheat_sheet_template
         SET status = 'published',
             published_at = NOW(),
             published_by_user_id = ${args.userId}::uuid,
             notes = COALESCE(${args.notes ?? null}, notes)
       WHERE id = ${args.id}::uuid
         AND status IN ('pending_review','withdrawn')
    `;
    return { published: updated > 0 };
  }, `publish cheatsheet template ${args.id}`);
}

export async function withdrawTemplate(args: {
  id: string;
  userId: string;
  notes?: string;
}): Promise<{ withdrawn: boolean }> {
  return withBreakglass(async (client) => {
    const updated = await client.$executeRaw`
      UPDATE cheat_sheet_template
         SET status = 'withdrawn',
             withdrawn_at = NOW(),
             withdrawn_by_user_id = ${args.userId}::uuid,
             notes = COALESCE(${args.notes ?? null}, notes)
       WHERE id = ${args.id}::uuid
         AND status = 'published'
    `;
    return { withdrawn: updated > 0 };
  }, `withdraw cheatsheet template ${args.id}`);
}

/**
 * Org-side: only published templates. No RLS needed because templates
 * are global reference, but we hide pending/withdrawn from non-operators.
 */
export async function listPublishedForOrg(): Promise<CheatsheetTemplateView[]> {
  return listTemplates({ status: "published" });
}
