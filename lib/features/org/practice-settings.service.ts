/**
 * The practice's own clock and pace: its time zone (0107) and how many visits
 * one clinician may be booked for in a day (0051).
 *
 * Both decide things a practice sees every day — the time zone is what a
 * visit's date of service is, on every bill and every report; the cap is what
 * the scheduler refuses past — and neither had a screen. Every org ran on the
 * column defaults, America/New_York and 8, and only someone with database
 * access could change them.
 */
import { z } from "zod";

import { NotFoundError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { changedFieldNames, writeAudit } from "@/lib/features/audit/audit-write";
import { PRACTICE_TIME_ZONES, type PracticeTimeZone } from "@/lib/features/org/org-date";

/** Visits per clinician per day. Above this a typo is likelier than a practice. */
export const MAX_DAILY_VISIT_CAPACITY = 30;

export const PracticeSettingsSchema = z.object({
  timezone: z.enum(PRACTICE_TIME_ZONES),
  dailyVisitCapacity: z.coerce.number().int().min(1).max(MAX_DAILY_VISIT_CAPACITY),
});
export type PracticeSettingsInput = z.infer<typeof PracticeSettingsSchema>;

export interface PracticeSettingsView {
  timezone: PracticeTimeZone;
  dailyVisitCapacity: number;
}

export async function getPracticeSettings(orgId: string): Promise<PracticeSettingsView> {
  return withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ timezone: PracticeTimeZone; daily_visit_capacity: number }[]>`
      SELECT timezone, daily_visit_capacity FROM org WHERE id = ${orgId}::uuid LIMIT 1
    `;
    if (!rows[0]) throw new NotFoundError("Organization not found.");
    return { timezone: rows[0].timezone, dailyVisitCapacity: Number(rows[0].daily_visit_capacity) };
  });
}

export async function updatePracticeSettings(args: {
  orgId: string;
  payload: PracticeSettingsInput;
  /** Who did it — recorded on the audit trail. */
  actorUserId?: string | null;
}): Promise<PracticeSettingsView> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const before = await tx.$queryRaw<{ timezone: string; daily_visit_capacity: number }[]>`
      SELECT timezone, daily_visit_capacity FROM org WHERE id = ${args.orgId}::uuid LIMIT 1 FOR UPDATE
    `;
    if (!before[0]) throw new NotFoundError("Organization not found.");
    const rows = await tx.$queryRaw<{ timezone: PracticeTimeZone; daily_visit_capacity: number }[]>`
      UPDATE org
         SET timezone = ${p.timezone},
             daily_visit_capacity = ${p.dailyVisitCapacity},
             updated_at = now()
       WHERE id = ${args.orgId}::uuid
      RETURNING timezone, daily_visit_capacity
    `;
    // The time zone moves the date of service of every visit from here on
    // (bills already raised keep theirs), so who changed it, and when, has to
    // be answerable. Field names only, as for branding.
    const fields = changedFieldNames({
      timezone: before[0].timezone === p.timezone ? undefined : p.timezone,
      dailyVisitCapacity:
        Number(before[0].daily_visit_capacity) === p.dailyVisitCapacity ? undefined : p.dailyVisitCapacity,
    });
    if (fields.length > 0) {
      await writeAudit(tx, {
        orgId: args.orgId,
        userId: args.actorUserId ?? null,
        action: "settings_update",
        targetType: "practice",
        targetId: null,
        payload: { change: "edit", fields },
      });
    }
    return { timezone: rows[0]!.timezone, dailyVisitCapacity: Number(rows[0]!.daily_visit_capacity) };
  });
}
