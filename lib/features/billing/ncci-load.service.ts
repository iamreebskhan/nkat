/**
 * The practice's own NCCI edits (0122; the migration says why). CMS's files
 * are read in the browser (ncci-files.ts), and what is kept comes here in
 * batches under one load:
 *
 *   start   a staging load: what kind, which files, and for MUE values the date
 *           of service they apply from. One left half-sent is dropped.
 *   rows    a batch of PTP pairs or MUE values onto the staging load.
 *   commit  the load is used from now on: for PTP pairs in place of the last
 *           load, for MUE values in place of the last one with the same date.
 *           The review checks (claim-checks.service.ts) read only these.
 *   remove  a staging load is dropped; a load in use stops being used.
 *
 * The rows are CMS's (and their CPT text the AMA's), kept in this practice's
 * account only: never read across practices, never in an audit payload.
 */
import { z } from "zod";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { isCalendarDay, orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";

import type { NcciKind } from "./ncci-files";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

/** Rows in one request. */
export const NCCI_BATCH_MAX = 5_000;
/** Far above what a practice keeps (a few thousand pairs; some 15,000 MUE codes). */
export const NCCI_ROWS_MAX: Record<NcciKind, number> = { ptp: 300_000, mue: 60_000 };

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine(isCalendarDay, "Not a calendar day.");
const Code = z.string().regex(/^[A-Z0-9]{5}$/, "A CPT or HCPCS code is five characters");
const Note = z.string().max(300).nullable();

export const StartNcciLoadSchema = z
  .object({
    kind: z.enum(["ptp", "mue"]),
    files: z.array(z.string().trim().min(1).max(300)).min(1).max(40),
    inForceFrom: Day.optional(),
    licenceAccepted: z.boolean(),
  })
  .strict()
  // On the object, so each sentence reaches the person as written.
  .superRefine((b, ctx) => {
    if (!b.licenceAccepted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Confirm the files were downloaded from CMS by your practice, under its own acceptance of CMS's licence.",
      });
    }
    if (b.kind === "mue" && !b.inForceFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "From which date of service do these MUE values apply?" });
    }
    if (b.kind === "ptp" && b.inForceFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PTP pairs carry their own dates; no in-force date is taken." });
    }
  });
export type StartNcciLoad = z.infer<typeof StartNcciLoadSchema>;

const PtpRowSchema = z
  .object({
    column1: Code,
    column2: Code,
    modifierIndicator: z.union([z.literal(0), z.literal(1)]),
    effective: Day,
    deletion: Day.nullable(),
    rationale: Note,
  })
  .strict()
  .refine((r) => r.deletion === null || r.deletion > r.effective, "A pair's deletion date is after its effective date.");

const MueRowSchema = z
  .object({
    code: Code,
    unitsMax: z.number().int().min(0).max(100_000),
    adjudication: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
    rationale: Note,
  })
  .strict();

export const NcciRowsSchema = z
  .object({
    ptp: z.array(PtpRowSchema).max(NCCI_BATCH_MAX).optional(),
    mue: z.array(MueRowSchema).max(NCCI_BATCH_MAX).optional(),
  })
  .strict();
export type NcciRows = z.infer<typeof NcciRowsSchema>;

export const CommitNcciLoadSchema = z.object({ rowsRead: z.number().int().min(0).max(100_000_000) }).strict();

export interface NcciLoadView {
  id: string;
  kind: NcciKind;
  status: "staging" | "current" | "replaced";
  inForceFrom: string | null;
  files: string[];
  rowsRead: number;
  rowsKept: number;
  /** PTP: how many codes its pairs were kept for. */
  codesCovered: number | null;
  loadedByName: string | null;
  /** When it was put in use (or started, while staging). */
  loadedAt: string;
}

export interface NcciStatus {
  today: string;
  /** The PTP pairs in use. */
  ptp: NcciLoadView | null;
  /** MUE values in use, the latest in-force date first: each applies until the next. */
  mue: NcciLoadView[];
  /** The codes Pallio knows now: a PTP load keeps the pairs of these. */
  codes: string[];
  /** Codes Pallio knows now that the PTP pairs in use were not kept for. */
  uncovered: string[];
}

/**
 * Every code this practice can bill: the code catalog, the payer rules, its
 * fees and chosen code set, and every code on its visits and bills.
 */
export async function knownCodes(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ code: string }[]>`
    SELECT k.c AS code FROM (
      SELECT code AS c FROM code
      UNION SELECT code FROM payer_rule
      UNION SELECT code FROM practice_fee WHERE org_id = ${orgId}::uuid
      UNION SELECT cpt_code FROM org_cpt_code_set WHERE org_id = ${orgId}::uuid
      UNION SELECT unnest(cpt_codes) FROM superbill WHERE org_id = ${orgId}::uuid
      UNION SELECT unnest(cpt_codes_assigned) FROM visit WHERE org_id = ${orgId}::uuid
    ) k
    WHERE k.c ~ '^[A-Z0-9]{5}$'
    ORDER BY 1
  `;
  return rows.map((r) => r.code);
}

type LoadRow = {
  id: string; kind: NcciKind; status: NcciLoadView["status"]; in_force_from: string | null; files: string[];
  rows_read: number; rows_kept: number; codes_covered: string[] | null; loaded_by_name: string | null; loaded_at: string;
};

const toView = (r: LoadRow): NcciLoadView => ({
  id: r.id, kind: r.kind, status: r.status, inForceFrom: r.in_force_from, files: r.files ?? [],
  rowsRead: Number(r.rows_read), rowsKept: Number(r.rows_kept), codesCovered: r.codes_covered ? r.codes_covered.length : null,
  loadedByName: r.loaded_by_name, loadedAt: r.loaded_at,
});

async function loadsIn(tx: Tx, orgId: string, status: NcciLoadView["status"]): Promise<LoadRow[]> {
  return tx.$queryRaw<LoadRow[]>`
    SELECT l.id, l.kind, l.status, to_char(l.in_force_from, 'YYYY-MM-DD') AS in_force_from, l.files,
           l.rows_read, l.rows_kept, l.codes_covered, COALESCE(u.full_name, u.email) AS loaded_by_name,
           to_char(COALESCE(l.committed_at, l.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS loaded_at
      FROM org_ncci_load l
      LEFT JOIN app_user u ON u.id = l.loaded_by_user_id
     WHERE l.org_id = ${orgId}::uuid AND l.status = ${status}
     ORDER BY l.kind, l.in_force_from DESC NULLS LAST, COALESCE(l.committed_at, l.created_at) DESC
  `;
}

export async function getNcciStatus(args: { orgId: string }): Promise<NcciStatus> {
  return withOrgContext(args.orgId, async (tx) => {
    const today = orgToday(await readOrgTimeZone(tx, args.orgId));
    const current = await loadsIn(tx, args.orgId, "current");
    const codes = await knownCodes(tx, args.orgId);
    const ptp = current.find((l) => l.kind === "ptp") ?? null;
    const covered = new Set(ptp?.codes_covered ?? []);
    return {
      today,
      ptp: ptp ? toView(ptp) : null,
      mue: current.filter((l) => l.kind === "mue").map(toView),
      codes,
      uncovered: ptp ? codes.filter((c) => !covered.has(c)) : [],
    };
  });
}

/**
 * Whether the claim review has NCCI data to check against: a bill says when it
 * does not, because no warning is otherwise the same as a clean claim.
 */
export async function ncciInUse(args: { orgId: string }): Promise<{ pairs: boolean; mue: boolean }> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ kind: NcciKind }[]>`
      SELECT DISTINCT kind FROM org_ncci_load WHERE org_id = ${args.orgId}::uuid AND status = 'current'
    `;
    return { pairs: rows.some((r) => r.kind === "ptp"), mue: rows.some((r) => r.kind === "mue") };
  });
}

/** A staging load for these files; any other staging load of the practice is dropped. */
export async function startNcciLoad(args: { orgId: string; userId: string; payload: StartNcciLoad }): Promise<{ id: string; codes: string[] }> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    // One load at a time: one left half-sent (a tab closed mid-way) goes.
    await tx.$executeRaw`DELETE FROM org_ncci_load WHERE org_id = ${args.orgId}::uuid AND status = 'staging'`;
    const codes = p.kind === "ptp" ? await knownCodes(tx, args.orgId) : null;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO org_ncci_load (org_id, kind, in_force_from, files, codes_covered, loaded_by_user_id)
      VALUES (${args.orgId}::uuid, ${p.kind}, ${p.inForceFrom ?? null}::date, ${p.files}::text[],
              ${codes}::text[], ${args.userId}::uuid)
      RETURNING id
    `;
    return { id: rows[0]!.id, codes: codes ?? [] };
  });
}

async function stagingLoad(tx: Tx, orgId: string, loadId: string): Promise<{ kind: NcciKind; rows_kept: number }> {
  const rows = await tx.$queryRaw<{ kind: NcciKind; status: string; rows_kept: number }[]>`
    SELECT kind, status, rows_kept FROM org_ncci_load
     WHERE id = ${loadId}::uuid AND org_id = ${orgId}::uuid
     FOR UPDATE
  `;
  const l = rows[0];
  if (!l) throw new NotFoundError("This load is no longer there: another was started since. Choose the files again.");
  if (l.status !== "staging") throw new ValidationError("This load is already finished. Choose the files again to load them anew.");
  return { kind: l.kind, rows_kept: Number(l.rows_kept) };
}

/** A batch of rows onto a staging load. Answers how many were new. */
export async function addNcciRows(args: { orgId: string; loadId: string; payload: NcciRows }): Promise<{ added: number; total: number }> {
  const ptp = args.payload.ptp ?? [];
  const mue = args.payload.mue ?? [];
  return withOrgContext(args.orgId, async (tx) => {
    const load = await stagingLoad(tx, args.orgId, args.loadId);
    if ((load.kind === "ptp" && mue.length > 0) || (load.kind === "mue" && ptp.length > 0)) {
      throw new ValidationError(`This is a load of ${load.kind === "ptp" ? "PTP pairs" : "MUE values"}; the batch holds the other kind.`);
    }
    const n = load.kind === "ptp" ? ptp.length : mue.length;
    if (load.rows_kept + n > NCCI_ROWS_MAX[load.kind]) {
      throw new ValidationError(
        `More than ${NCCI_ROWS_MAX[load.kind].toLocaleString("en-US")} ${load.kind === "ptp" ? "pairs" : "MUE values"} in one load: these are not the files Pallio expects.`,
      );
    }
    let added = 0;
    if (load.kind === "ptp" && ptp.length > 0) {
      added = await tx.$executeRaw`
        INSERT INTO org_ncci_ptp (load_id, org_id, column1_code, column2_code, modifier_indicator, effective_date, deletion_date, rationale)
        SELECT ${args.loadId}::uuid, ${args.orgId}::uuid, t.c1, t.c2, t.mi::smallint, t.ef::date, t.de::date, t.ra
          FROM unnest(${ptp.map((r) => r.column1)}::text[], ${ptp.map((r) => r.column2)}::text[],
                      ${ptp.map((r) => r.modifierIndicator)}::int[], ${ptp.map((r) => r.effective)}::text[],
                      ${ptp.map((r) => r.deletion)}::text[], ${ptp.map((r) => r.rationale)}::text[])
               AS t(c1, c2, mi, ef, de, ra)
        ON CONFLICT DO NOTHING
      `;
    } else if (load.kind === "mue" && mue.length > 0) {
      added = await tx.$executeRaw`
        INSERT INTO org_ncci_mue (load_id, org_id, code, units_max, adjudication_indicator, rationale)
        SELECT ${args.loadId}::uuid, ${args.orgId}::uuid, t.code, t.units, t.mai::smallint, t.ra
          FROM unnest(${mue.map((r) => r.code)}::text[], ${mue.map((r) => r.unitsMax)}::int[],
                      ${mue.map((r) => r.adjudication)}::int[], ${mue.map((r) => r.rationale)}::text[])
               AS t(code, units, mai, ra)
        ON CONFLICT DO NOTHING
      `;
    }
    await tx.$executeRaw`
      UPDATE org_ncci_load SET rows_kept = rows_kept + ${added} WHERE id = ${args.loadId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    return { added, total: load.rows_kept + added };
  });
}

/** Put a staging load in use, in place of the one it replaces. */
export async function commitNcciLoad(args: { orgId: string; userId: string; loadId: string; rowsRead: number }): Promise<NcciLoadView> {
  return withOrgContext(args.orgId, async (tx) => {
    const load = await stagingLoad(tx, args.orgId, args.loadId);
    if (load.rows_kept === 0) {
      throw new ValidationError(
        load.kind === "ptp"
          ? "None of the pairs in these files are between codes Pallio knows, so there is nothing to use. Check they are CMS's practitioner PTP files."
          : "No MUE values came with this load. Check the file is CMS's Practitioner Services MUE table.",
      );
    }
    const meta = await tx.$queryRaw<{ in_force_from: string | null; files: string[] }[]>`
      SELECT to_char(in_force_from, 'YYYY-MM-DD') AS in_force_from, files FROM org_ncci_load WHERE id = ${args.loadId}::uuid
    `;
    const inForceFrom = meta[0]?.in_force_from ?? null;
    // What this load takes over from: the PTP pairs in use, or the MUE values
    // in use from the same date. Their rows go; the load rows stay as the
    // record of what was used when.
    const replaced =
      load.kind === "ptp"
        ? await tx.$queryRaw<{ id: string }[]>`
            UPDATE org_ncci_load SET status = 'replaced'
             WHERE org_id = ${args.orgId}::uuid AND kind = 'ptp' AND status = 'current'
            RETURNING id
          `
        : await tx.$queryRaw<{ id: string }[]>`
            UPDATE org_ncci_load SET status = 'replaced'
             WHERE org_id = ${args.orgId}::uuid AND kind = 'mue' AND status = 'current'
               AND in_force_from = ${inForceFrom}::date
            RETURNING id
          `;
    const gone = replaced.map((r) => r.id);
    if (gone.length > 0) {
      if (load.kind === "ptp") await tx.$executeRaw`DELETE FROM org_ncci_ptp WHERE load_id = ANY(${gone}::uuid[]) AND org_id = ${args.orgId}::uuid`;
      else await tx.$executeRaw`DELETE FROM org_ncci_mue WHERE load_id = ANY(${gone}::uuid[]) AND org_id = ${args.orgId}::uuid`;
    }
    await tx.$executeRaw`
      UPDATE org_ncci_load
         SET status = 'current', rows_read = ${args.rowsRead}, committed_at = now()
       WHERE id = ${args.loadId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    // Counts and dates only: the rows are CMS's and stay out of the log.
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "ncci_load",
      targetType: "ncci_load",
      targetId: args.loadId,
      payload: {
        kind: load.kind, change: "loaded", rowsRead: args.rowsRead, rowsKept: load.rows_kept,
        files: (meta[0]?.files ?? []).length, inForceFrom, replaced: gone.length,
      },
    });
    const view = (await loadsIn(tx, args.orgId, "current")).find((l) => l.id === args.loadId);
    return toView(view!);
  });
}

/** Drop a staging load, or stop using one in use (its rows go; the record stays). */
export async function removeNcciLoad(args: { orgId: string; userId: string; loadId: string }): Promise<void> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ kind: NcciKind; status: string; rows_kept: number; in_force_from: string | null }[]>`
      SELECT kind, status, rows_kept, to_char(in_force_from, 'YYYY-MM-DD') AS in_force_from FROM org_ncci_load
       WHERE id = ${args.loadId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    const l = rows[0];
    if (!l || l.status === "replaced") throw new NotFoundError("That load is not in use.");
    if (l.status === "staging") {
      await tx.$executeRaw`DELETE FROM org_ncci_load WHERE id = ${args.loadId}::uuid AND org_id = ${args.orgId}::uuid`;
      return;
    }
    if (l.kind === "ptp") await tx.$executeRaw`DELETE FROM org_ncci_ptp WHERE load_id = ${args.loadId}::uuid AND org_id = ${args.orgId}::uuid`;
    else await tx.$executeRaw`DELETE FROM org_ncci_mue WHERE load_id = ${args.loadId}::uuid AND org_id = ${args.orgId}::uuid`;
    await tx.$executeRaw`
      UPDATE org_ncci_load SET status = 'replaced' WHERE id = ${args.loadId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "ncci_load",
      targetType: "ncci_load",
      targetId: args.loadId,
      payload: { kind: l.kind, change: "removed", rowsKept: Number(l.rows_kept), inForceFrom: l.in_force_from },
    });
  });
}
