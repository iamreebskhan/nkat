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
    "billing.denials.view", "billing.denials.log", "billing.denials.refile", "billing.denials.writeoff",
    "cheatsheets.view", "cheatsheets.generate", "cheatsheets.download",
    "knowledge.view", "knowledge.upload", "knowledge.attest", "knowledge.edit",
    "reports.view", "reports.export",
    "team.view", "team.invite", "team.permissions", "team.deactivate",
    "settings.view", "settings.org", "settings.payers", "settings.integrations",
    "audit.view",
  ],
  clinician: [
    "patients.list", "patients.view", "patients.edit",
    "visits.view.own", "visits.create", "visits.edit",
    "careplans.view", "careplans.edit",
    "schedule.view", "schedule.create",
  ],
  billing_agent: [
    "patients.list", "patients.view",
    "visits.view.all",
    "billing.lookup.view", "billing.lookup.export",
    "billing.superbills.view", "billing.superbills.create", "billing.superbills.edit", "billing.superbills.export",
    "billing.denials.view", "billing.denials.log", "billing.denials.refile", "billing.denials.writeoff",
    "cheatsheets.view", "cheatsheets.download",
  ],
  consultant: [],
  analyst: [
    "knowledge.view", "knowledge.upload", "knowledge.attest", "knowledge.edit",
    "billing.lookup.view",
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
