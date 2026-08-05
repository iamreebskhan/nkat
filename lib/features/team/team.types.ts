/**
 * Team role templates + default permission sets.
 *
 * Source: pallio_complete_vision_v3 §13.4. Pure constants — safe to
 * import from client components.
 */
import { z } from "zod";

export const ROLE_TEMPLATES = [
  "org_admin",
  "clinician",
  "billing_agent",
  "consultant",
  "analyst",
  "read_only",
] as const;
export type RoleTemplate = (typeof ROLE_TEMPLATES)[number];

export const ROLE_DEFAULT_PERMISSIONS: Record<RoleTemplate, string[]> = {
  org_admin: [
    "patients.list", "patients.view", "patients.create", "patients.edit", "patients.archive",
    "visits.view.own", "visits.view.all", "visits.create", "visits.edit", "visits.submit",
    "careplans.view", "careplans.edit",
    "schedule.view", "schedule.create", "schedule.edit",
    "billing.lookup.view", "billing.lookup.export",
    "billing.superbills.view", "billing.superbills.create", "billing.superbills.edit", "billing.superbills.export",
    "superbill.predict",
    "billing.denials.view", "billing.denials.log", "billing.denials.refile", "billing.denials.writeoff",
    "cheatsheets.view", "cheatsheets.generate", "cheatsheets.download",
    "knowledge.view", "knowledge.upload", "knowledge.attest", "knowledge.edit",
    "reports.view", "reports.export",
    "team.view", "team.invite", "team.permissions", "team.deactivate",
    "settings.view", "settings.org", "settings.payers", "settings.integrations",
    "audit.view",
    "messaging.read", "messaging.send",
    "patient.acuity.edit",
    "patients.careteam.edit",
  ],
  clinician: [
    "patients.list", "patients.view", "patients.edit",
    // "visits.submit" is what "Sign + submit for billing" needs — the primary
    // button on the clinician's primary screen. Without it every invited
    // clinician got a 403 on sign-off. Signing your own documentation is the
    // clinician's job by definition; billing.* deliberately stays out.
    "visits.view.own", "visits.create", "visits.edit", "visits.submit",
    "careplans.view", "careplans.edit",
    // schedule.edit so they can move their own visits on the week grid; without
    // it drag-to-reschedule fails after the drop.
    "schedule.view", "schedule.create", "schedule.edit",
    "messaging.read", "messaging.send",
    "patient.acuity.edit",
  ],
  billing_agent: [
    "patients.list", "patients.view",
    "visits.view.all",
    "billing.lookup.view", "billing.lookup.export",
    "billing.superbills.view", "billing.superbills.create", "billing.superbills.edit", "billing.superbills.export",
    "superbill.predict",
    "billing.denials.view", "billing.denials.log", "billing.denials.refile", "billing.denials.writeoff",
    "cheatsheets.view", "cheatsheets.download",
    "knowledge.view",
    "messaging.read",
  ],
  consultant: [],
  analyst: [
    "knowledge.view", "knowledge.upload", "knowledge.attest", "knowledge.edit",
    "billing.lookup.view", "superbill.predict",
  ],
  read_only: [
    "patients.list", "patients.view",
    "visits.view.all",
    "reports.view",
  ],
};

export const InviteSchema = z.object({
  email: z.string().email().toLowerCase(),
  roleTemplate: z.enum(ROLE_TEMPLATES),
  permissions: z.array(z.string().max(64)).max(80),
});
export type InviteInput = z.infer<typeof InviteSchema>;

export interface InviteRecord {
  id: string;
  email: string;
  roleTemplate: RoleTemplate;
  invitedByUserId: string;
  expiresAt: string;
  createdAt: string;
  redeemedAt: string | null;
  permissions: string[];
}

export interface MemberRecord {
  userId: string;
  email: string;
  fullName: string | null;
  permissions: string[];
}
