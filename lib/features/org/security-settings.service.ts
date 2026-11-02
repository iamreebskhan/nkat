/**
 * The practice's session rules (0121): how long a session lasts without
 * activity, and who must sign in with a second factor. Settings → Security.
 *
 * Both reach sessions in use at their next refresh, which the browser makes
 * within a minute of any activity (POST /api/auth/activity).
 */
import { z } from "zod";

import { NotFoundError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { changedFieldNames, writeAudit } from "@/lib/features/audit/audit-write";
import { IDLE_MINUTES, MFA_POLICIES, type MfaPolicy } from "@/lib/features/auth/session-policy";

const IDLE_RANGE = `Sign-out after inactivity is ${IDLE_MINUTES.min} to ${IDLE_MINUTES.max} whole minutes.`;

// The range is checked on the OBJECT so the admin reads the sentence as
// written: an issue on the field would arrive prefixed "idleTimeoutMinutes: "
// (formatZodError), as team.types.ts explains for the permission sets.
export const SecuritySettingsSchema = z
  .object({
    idleTimeoutMinutes: z.coerce.number(),
    mfaPolicy: z.enum(MFA_POLICIES),
  })
  .superRefine((b, ctx) => {
    const m = b.idleTimeoutMinutes;
    if (!Number.isInteger(m) || m < IDLE_MINUTES.min || m > IDLE_MINUTES.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: IDLE_RANGE });
    }
  });
export type SecuritySettingsInput = z.infer<typeof SecuritySettingsSchema>;

export interface SecuritySettingsView {
  idleTimeoutMinutes: number;
  mfaPolicy: MfaPolicy;
}

export async function getSecuritySettings(orgId: string): Promise<SecuritySettingsView> {
  return withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ idle_timeout_minutes: number; mfa_policy: MfaPolicy }[]>`
      SELECT idle_timeout_minutes, mfa_policy FROM org WHERE id = ${orgId}::uuid LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundError("Organization not found.");
    return { idleTimeoutMinutes: Number(rows[0].idle_timeout_minutes), mfaPolicy: rows[0].mfa_policy };
  });
}

export async function updateSecuritySettings(args: {
  orgId: string;
  payload: SecuritySettingsInput;
  actorUserId?: string | null;
}): Promise<SecuritySettingsView> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const before = await tx.$queryRaw<{ idle_timeout_minutes: number; mfa_policy: string }[]>`
      SELECT idle_timeout_minutes, mfa_policy FROM org WHERE id = ${args.orgId}::uuid LIMIT 1 FOR UPDATE
    `;
    if (!before[0]) throw new NotFoundError("Organization not found.");
    const rows = await tx.$queryRaw<{ idle_timeout_minutes: number; mfa_policy: MfaPolicy }[]>`
      UPDATE org
         SET idle_timeout_minutes = ${p.idleTimeoutMinutes},
             mfa_policy = ${p.mfaPolicy},
             updated_at = now()
       WHERE id = ${args.orgId}::uuid
      RETURNING idle_timeout_minutes, mfa_policy
    `;
    // Who loosened or tightened sign-in rules, and when, must be answerable.
    // Field names only, as for the practice settings.
    const fields = changedFieldNames({
      idleTimeoutMinutes:
        Number(before[0].idle_timeout_minutes) === p.idleTimeoutMinutes ? undefined : p.idleTimeoutMinutes,
      mfaPolicy: before[0].mfa_policy === p.mfaPolicy ? undefined : p.mfaPolicy,
    });
    if (fields.length > 0) {
      await writeAudit(tx, {
        orgId: args.orgId,
        userId: args.actorUserId ?? null,
        action: "settings_update",
        targetType: "security",
        targetId: null,
        payload: { change: "edit", fields },
      });
    }
    return { idleTimeoutMinutes: Number(rows[0]!.idle_timeout_minutes), mfaPolicy: rows[0]!.mfa_policy };
  });
}
