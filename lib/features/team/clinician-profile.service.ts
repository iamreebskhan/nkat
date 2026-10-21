/**
 * Recording a clinician's NPI and credential (audit R40, R25).
 *
 * Before this, nothing anywhere recorded a person-level NPI, so every claim
 * named the organization as rendering provider, and pricing tier was a
 * per-visit dropdown nothing read. These two fields are what a claim needs to
 * say who treated the patient and at which rate.
 *
 * Validation happens here rather than only in the column CHECK, so a mistyped
 * NPI comes back as a sentence a person can act on instead of a constraint
 * name.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { CLINICIAN_CREDENTIALS, isValidNpi, type ClinicianCredential } from "./clinician";

export interface ClinicianProfile {
  userId: string;
  npi: string | null;
  credential: ClinicianCredential | null;
  /** How many of this clinician's open bills now carry the NPI. */
  openBillsUpdated: number;
}

export async function saveClinicianProfile(args: {
  orgId: string;
  userId: string;
  actorUserId?: string;
  npi: string | null;
  credential: ClinicianCredential | null;
}): Promise<ClinicianProfile> {
  const npi = args.npi && args.npi.trim() !== "" ? args.npi.trim() : null;
  if (npi && !/^\d{10}$/.test(npi)) {
    throw new ValidationError(`An NPI is exactly 10 digits; "${npi}" is not.`);
  }
  if (npi && !isValidNpi(npi)) {
    throw new ValidationError(
      `${npi} is not a valid NPI: its last digit does not match the NPI check digit. Check it against NPPES.`,
    );
  }
  if (args.credential !== null && !CLINICIAN_CREDENTIALS.includes(args.credential)) {
    throw new ValidationError(`Unknown credential "${args.credential}".`);
  }

  return withOrgContext(args.orgId, async (tx) => {
    const member = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM org_member
       WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid
         AND status = 'active'
       LIMIT 1
    `;
    if (!member[0]) {
      throw new NotFoundError("That person is not an active member of this organization.");
    }

    // The unique index would reject this too; checking first names the clash.
    if (npi) {
      const clash = await tx.$queryRaw<{ user_id: string }[]>`
        SELECT user_id FROM clinician_profile
         WHERE org_id = ${args.orgId}::uuid AND npi = ${npi}
           AND user_id <> ${args.userId}::uuid
         LIMIT 1
      `;
      if (clash[0]) {
        throw new ValidationError(
          `NPI ${npi} is already recorded for another member of this organization. An NPI identifies one person.`,
        );
      }
    }

    // What this person had before, so correcting a mistyped NPI corrects it on
    // their open bills too. FOR UPDATE serializes two admins saving at once.
    const prior = await tx.$queryRaw<{ npi: string | null }[]>`
      SELECT npi FROM clinician_profile
       WHERE org_id = ${args.orgId}::uuid AND user_id = ${args.userId}::uuid
       FOR UPDATE
    `;
    const priorNpi = prior[0]?.npi ?? null;

    await tx.$executeRaw`
      INSERT INTO clinician_profile (org_id, user_id, npi, credential, updated_at, updated_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.userId}::uuid, ${npi}, ${args.credential},
              now(), ${args.actorUserId ?? null}::uuid)
      ON CONFLICT (org_id, user_id) DO UPDATE
        SET npi = EXCLUDED.npi,
            credential = EXCLUDED.credential,
            updated_at = now(),
            updated_by_user_id = EXCLUDED.updated_by_user_id
    `;

    // A blank rendering NPI now blocks submission, so without this a bill
    // drafted before the NPI was recorded could never be submitted. Fill it
    // into this clinician's bills that are still being worked (draft, ready to
    // submit, denied) where the claim has no NPI, the organization's stand-in,
    // or the number being corrected. Never a claim already with a payer, and
    // never one naming some other NPI. Each bill's own history says so.
    // This org's bills only: a clinician can work for more than one practice,
    // and their NPI as recorded here is this practice's to fill in. Left to
    // RLS, a connection that bypasses it filled every practice's open bills
    // for them and wrote this org's history rows onto the others'.
    let openBillsUpdated = 0;
    if (npi) {
      const filled = await tx.$queryRaw<{ id: string }[]>`
        WITH updated AS (
          UPDATE superbill s
             SET provider_npi = ${npi}, updated_at = now()
            FROM visit v
            LEFT JOIN onboarding_status ob ON ob.org_id = v.org_id
           WHERE v.id = s.visit_id
             AND v.org_id = s.org_id
             AND s.org_id = ${args.orgId}::uuid
             AND v.clinician_user_id = ${args.userId}::uuid
             AND s.status IN ('draft', 'ready_to_submit', 'denied')
             AND s.provider_npi IS DISTINCT FROM ${npi}
             AND (COALESCE(s.provider_npi, '') = ''
                  OR s.provider_npi = COALESCE(s.billing_npi, ob.npi)
                  OR s.provider_npi = ${priorNpi})
          RETURNING s.id, s.status
        )
        INSERT INTO superbill_activity (
          org_id, superbill_id, actor_user_id, kind, from_status, to_status, summary, detail
        )
        SELECT ${args.orgId}::uuid, u.id, ${args.actorUserId ?? null}::uuid, 'edited',
               u.status, u.status,
               'Rendering NPI set to the clinician''s own, recorded on the Team page',
               '{"fields": ["provider_npi"]}'::jsonb
          FROM updated u
        RETURNING superbill_id AS id
      `;
      openBillsUpdated = filled.length;
    }

    // Field names and a count only — the audit log never copies values.
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.actorUserId ?? null,
      action: "clinician_profile_update",
      targetType: "user",
      targetId: args.userId,
      payload: { fields: ["npi", "credential"], openBillsUpdated },
    });

    return { userId: args.userId, npi, credential: args.credential, openBillsUpdated };
  });
}
