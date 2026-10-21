/**
 * Addenda to a signed visit note (audit R15).
 *
 * Signing locks the note. Four messages told the clinician to "record any
 * change as a new addendum", and nothing could accept one, so corrections to
 * an attested note happened outside the record. An addendum is the in-record
 * correction: signed by its author, stamped with the credential they held,
 * printed after the note, and append-only (the table refuses UPDATE and
 * DELETE).
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { LOCKED_AFTER_SIGNING } from "./visit.service";
import type { VisitStatus } from "./visit.types";

export const ADDENDUM_MAX = 20_000;

export interface VisitAddendumView {
  id: string;
  body: string;
  authorUserId: string;
  authorName: string | null;
  /** The credential the author held when they signed it; null if none recorded. */
  authorCredential: string | null;
  signedAt: string;
}

interface AddendumRow {
  id: string;
  body: string;
  author_user_id: string;
  author_name: string | null;
  author_credential: string | null;
  signed_at: Date;
}

const toView = (r: AddendumRow): VisitAddendumView => ({
  id: r.id,
  body: r.body,
  authorUserId: r.author_user_id,
  authorName: r.author_name,
  authorCredential: r.author_credential,
  signedAt: r.signed_at.toISOString(),
});

export async function addVisitAddendum(args: {
  orgId: string;
  visitId: string;
  userId: string;
  body: string;
}): Promise<VisitAddendumView> {
  const text = args.body.trim();
  if (!text) throw new ValidationError("An addendum needs some text.");
  if (text.length > ADDENDUM_MAX) {
    throw new ValidationError(
      `An addendum can be at most ${ADDENDUM_MAX.toLocaleString("en-US")} characters.`,
    );
  }

  return withOrgContext(args.orgId, async (tx) => {
    const visit = await tx.$queryRaw<{ status: VisitStatus }[]>`
      SELECT status FROM visit WHERE id = ${args.visitId}::uuid LIMIT 1 FOR UPDATE
    `;
    if (!visit[0]) throw new NotFoundError("Visit not found.");
    if (!LOCKED_AFTER_SIGNING.includes(visit[0].status)) {
      throw new ValidationError(
        "This visit has not been signed — edit the note itself. An addendum is only for an attested note.",
      );
    }

    // The author's credential is a snapshot, like the signer's on the visit:
    // the addendum records what they held when they signed it.
    const rows = await tx.$queryRaw<AddendumRow[]>`
      WITH ins AS (
        INSERT INTO visit_addendum (org_id, visit_id, body, author_user_id, author_credential)
        VALUES (
          ${args.orgId}::uuid, ${args.visitId}::uuid, ${text}, ${args.userId}::uuid,
          (SELECT credential FROM clinician_profile
            WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid)
        )
        RETURNING id, body, author_user_id, author_credential, signed_at
      )
      SELECT ins.id, ins.body, ins.author_user_id, ins.author_credential, ins.signed_at,
             u.full_name AS author_name
        FROM ins LEFT JOIN app_user u ON u.id = ins.author_user_id
    `;
    const row = rows[0]!;

    // Ids and a length — never the text, which is clinical content.
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "visit_addendum",
      targetType: "visit",
      targetId: args.visitId,
      payload: { addendumId: row.id, length: text.length },
    });

    return toView(row);
  });
}

export async function listVisitAddenda(args: {
  orgId: string;
  visitId: string;
}): Promise<VisitAddendumView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<AddendumRow[]>`
      SELECT a.id, a.body, a.author_user_id, u.full_name AS author_name,
             a.author_credential, a.signed_at
        FROM visit_addendum a
        LEFT JOIN app_user u ON u.id = a.author_user_id
       WHERE a.visit_id = ${args.visitId}::uuid
       ORDER BY a.signed_at, a.id
    `;
    return rows.map(toView);
  });
}
