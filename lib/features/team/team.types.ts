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

/**
 * The role a session renders its sidebar from (audit R38): the template the
 * member was invited with, else the legacy org_member.role mapping. Invitees
 * used to get 'employee' → clinician whatever template they were invited
 * with, so an invited billing agent saw only My inbox and Patients.
 */
export function sessionRoleFor(
  template: string | null | undefined,
  legacyRole: string,
): RoleTemplate {
  if (template && (ROLE_TEMPLATES as readonly string[]).includes(template)) {
    return template as RoleTemplate;
  }
  if (legacyRole === "admin") return "org_admin";
  if (legacyRole === "consultant") return "consultant";
  if (legacyRole === "reviewer") return "analyst";
  return "clinician";
}

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
    // They place the payer calls, so they can attest what a payer said (R38).
    "knowledge.attest",
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
    // A read-only reviewer's job is to look (audit R38).
    "audit.view",
  ],
};

/**
 * Every permission this product defines.
 *
 * The union of the templates above, because that IS the catalogue: /team's
 * editor builds its checkbox grid the same way (app/(platform)/team/page.tsx),
 * and no route asks for a permission outside it (checked against every
 * requireAuth list under app/, and against the 48 distinct values in
 * user_permission on the local database — the two sets are identical).
 *
 * Derived rather than retyped so a permission added to a template is grantable
 * the same day and this file cannot drift into a second, stale catalogue.
 */
export const ALL_PERMISSIONS: readonly string[] = Object.freeze(
  [...new Set(Object.values(ROLE_DEFAULT_PERMISSIONS).flat())].sort(),
);

const KNOWN_PERMISSION = new Set(ALL_PERMISSIONS);

/** Which of these names this product does not define, deduped and sorted. */
export function unknownPermissions(permissions: readonly string[]): string[] {
  return [...new Set(permissions.filter((p) => !KNOWN_PERMISSION.has(p)))].sort();
}

/**
 * Why a misspelt permission is refused instead of stored: user_permission takes
 * any string, listMembers reads it back, and the roster then shows a grant that
 * no requireAuth list will ever match — so the member is told they have access
 * they do not have, and the admin has no way to tell a typo from a permission
 * the screen simply does not use yet. The offending names are quoted so the
 * admin can see which box they meant.
 *
 * TENSE. Every path that shows this sentence has already refused the save —
 * the route answers 422 without calling setMemberPermissions, and
 * setMemberPermissions throws before it deletes a single row. So the sentence
 * says outright that nothing was saved, and puts the consequence of a typo in
 * the conditional. It used to read "a name spelled any other way IS saved as a
 * grant that nothing ever checks", which described the behaviour this refusal
 * replaced: an admin was told their misspelling had been stored on the member
 * when it had not been stored at all, and could go looking on /team for a
 * grant that was never written.
 */
export function unknownPermissionMessage(unknown: readonly string[]): string {
  const names = unknown.map((p) => `"${p}"`).join(", ");
  return (
    `Not a permission this product has: ${names}. Nothing was saved. Pick from the ` +
    `list on this page — a name spelled any other way would be stored as a grant that ` +
    `nothing ever checks, so it would grant nothing at all.`
  );
}

/**
 * Shared by both bodies that carry a permission set, so the catalogue cannot be
 * enforced on the invite form and missing from the member editor. Raised on the
 * OBJECT for the same reason PERMISSION_SET_REQUIRED is — see below.
 */
function refuseUnknownPermissions(
  body: { permissions: string[] },
  ctx: z.RefinementCtx,
): void {
  const unknown = unknownPermissions(body.permissions);
  if (unknown.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: unknownPermissionMessage(unknown) });
  }
}

/**
 * The shape of a permission set as it arrives from a browser. Both paths that
 * accept one — the invite form and the member editor — build their schema from
 * this, so the "at least one" rule can't be true on one and missing on the
 * other. The member editor's route used to declare its own array with no
 * minimum, and unticking every box and saving was accepted.
 *
 * The element rule is length only; WHICH names are allowed is checked on the
 * object, so the sentence the admin reads is not prefixed with "permissions.3:".
 */
const PermissionSet = z.array(z.string().max(64)).max(80);

export const InviteSchema = z
  .object({
    email: z.string().email().toLowerCase(),
    roleTemplate: z.enum(ROLE_TEMPLATES),
    // At least one: a consultant invite with none granted nothing, silently (R38).
    permissions: PermissionSet.min(1, "Pick at least one permission"),
  })
  .superRefine(refuseUnknownPermissions);
export type InviteInput = z.infer<typeof InviteSchema>;

/**
 * Why an empty set is refused instead of obeyed: the account survives, the
 * password still works, and every screen answers 403 — which reads as a broken
 * login rather than as a decision an admin made, and leaves no grant behind to
 * show what was intended (audit R38). The message names the alternative that
 * actually exists today; /team has no way to take a member off the roster.
 */
export const PERMISSION_SET_REQUIRED =
  "A member must keep at least one permission. With none they can still sign in " +
  "but open nothing — untick what they should lose and leave one they still need. " +
  "Removing a member from the team isn't something this page can do yet.";

/**
 * Body of PUT /api/team/members/[userId] — a wholesale replacement.
 *
 * The "at least one" rule sits on the OBJECT rather than on the array, so the
 * sentence above reaches the admin as written. formatZodError in lib/api
 * prefixes any issue that carries a field path, and an issue raised on
 * `permissions` arrived in the red box on /team as "permissions: A member must
 * keep at least one permission…" — a field name pasted onto an explanation
 * written for a person. An object-level issue has an empty path and is printed
 * verbatim, which also makes it the same string the service throws
 * (ValidationError → 422) for any caller that reaches it another way.
 */
export const MemberPermissionsSchema = z
  .object({
    permissions: PermissionSet,
  })
  .superRefine((body, ctx) => {
    if (body.permissions.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PERMISSION_SET_REQUIRED });
    }
    // The set is checked against the catalogue as well as counted. This array
    // was z.string().max(64) with no allowlist, which is a security property
    // and not only a spelling one: the editor accepted any 64 characters, so a
    // set no shipped role template grants — ["billing.superbills.view"] on its
    // own, say — could be saved onto a member, and per-visit routes gated on
    // billing.superbills.* were reasoned about as if only the templates existed.
    // Refusing unknown names does not make that set unsavable (it is spelled
    // correctly); it removes the OTHER half, where a typo is stored as a grant
    // that reads as access and confers none.
    refuseUnknownPermissions(body, ctx);
  });

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
  /** Individual NPI from clinician_profile — the rendering provider on claims. */
  npi: string | null;
  /** Licensure from clinician_profile — sets the pricing tier. */
  credential: string | null;
}
