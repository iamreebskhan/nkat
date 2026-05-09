/**
 * Onboarding service — wizard state persistence.
 *
 * One row per org in `onboarding_status`. Each step's save endpoint
 * upserts the relevant fields and flips the corresponding boolean.
 */
import { withOrgContext } from "@/lib/db";
import type {
  OnboardingStatusView,
  OrgType,
  Profile,
} from "./onboarding.types";

interface Row {
  org_id: string;
  profile_complete: boolean;
  states_complete: boolean;
  payers_complete: boolean;
  cpt_codes_complete: boolean;
  rulebook_complete: boolean;
  active_states: string[] | null;
  active_payer_ids: string[] | null;
  org_type: OrgType | null;
  custom_domain: string | null;
  notes: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toView(r: Row): OnboardingStatusView {
  return {
    orgId: r.org_id,
    profileComplete: r.profile_complete,
    statesComplete: r.states_complete,
    payersComplete: r.payers_complete,
    cptCodesComplete: r.cpt_codes_complete,
    rulebookComplete: r.rulebook_complete,
    activeStates: r.active_states ?? [],
    activePayerIds: r.active_payer_ids ?? [],
    orgType: r.org_type,
    customDomain: r.custom_domain,
    notes: r.notes,
    completedAt: r.completed_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Read-or-create the org's onboarding row. */
export async function getOrCreateOnboarding(
  orgId: string,
): Promise<OnboardingStatusView> {
  return withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      INSERT INTO onboarding_status (org_id) VALUES (${orgId}::uuid)
      ON CONFLICT (org_id) DO UPDATE SET updated_at = onboarding_status.updated_at
      RETURNING *
    `;
    return toView(rows[0]!);
  });
}

export async function saveProfile(args: {
  orgId: string;
  profile: Profile;
}): Promise<OnboardingStatusView> {
  return withOrgContext(args.orgId, async (tx) => {
    // Profile lives partly in `org` (name, npi, custom domain) and
    // partly in onboarding_status (org_type, notes). Update both.
    await tx.$executeRaw`
      UPDATE org SET
        name = ${args.profile.name},
        slug = COALESCE(slug, lower(replace(${args.profile.name}, ' ', '-'))),
        updated_at = now()
      WHERE id = ${args.orgId}::uuid
    `;

    const rows = await tx.$queryRaw<Row[]>`
      INSERT INTO onboarding_status (
        org_id, profile_complete, org_type, custom_domain, notes
      ) VALUES (
        ${args.orgId}::uuid, TRUE,
        ${args.profile.orgType},
        ${args.profile.customDomain ?? null},
        ${args.profile.notes ?? null}
      )
      ON CONFLICT (org_id) DO UPDATE SET
        profile_complete = TRUE,
        org_type = EXCLUDED.org_type,
        custom_domain = EXCLUDED.custom_domain,
        notes = COALESCE(EXCLUDED.notes, onboarding_status.notes),
        updated_at = now()
      RETURNING *
    `;
    return toView(rows[0]!);
  });
}

export async function saveStates(args: {
  orgId: string;
  states: string[];
}): Promise<OnboardingStatusView> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      INSERT INTO onboarding_status (org_id, active_states, states_complete)
      VALUES (${args.orgId}::uuid, ${args.states}::text[], TRUE)
      ON CONFLICT (org_id) DO UPDATE SET
        active_states = EXCLUDED.active_states,
        states_complete = TRUE,
        updated_at = now()
      RETURNING *
    `;
    return toView(rows[0]!);
  });
}

export async function savePayers(args: {
  orgId: string;
  payerIds: string[];
}): Promise<OnboardingStatusView> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      INSERT INTO onboarding_status (org_id, active_payer_ids, payers_complete)
      VALUES (${args.orgId}::uuid, ${args.payerIds}::uuid[], TRUE)
      ON CONFLICT (org_id) DO UPDATE SET
        active_payer_ids = EXCLUDED.active_payer_ids,
        payers_complete = TRUE,
        updated_at = now()
      RETURNING *
    `;
    return toView(rows[0]!);
  });
}

export async function saveCptCodes(args: {
  orgId: string;
  cptCodes: string[];
}): Promise<OnboardingStatusView> {
  return withOrgContext(args.orgId, async (tx) => {
    // CPT selections live in `org_cpt_code_set` (added in 0029). Replace
    // the active set wholesale; preserve any custom notes per code.
    await tx.$executeRaw`
      DELETE FROM org_cpt_code_set
      WHERE org_id = ${args.orgId}::uuid
        AND cpt_code NOT IN (${args.cptCodes.length > 0 ? args.cptCodes : [""]})
    `;
    for (const code of args.cptCodes) {
      await tx.$executeRaw`
        INSERT INTO org_cpt_code_set (org_id, cpt_code, active)
        VALUES (${args.orgId}::uuid, ${code}, TRUE)
        ON CONFLICT (org_id, cpt_code) DO UPDATE SET active = TRUE
      `;
    }

    const rows = await tx.$queryRaw<Row[]>`
      INSERT INTO onboarding_status (org_id, cpt_codes_complete)
      VALUES (${args.orgId}::uuid, TRUE)
      ON CONFLICT (org_id) DO UPDATE SET
        cpt_codes_complete = TRUE,
        updated_at = now()
      RETURNING *
    `;
    return toView(rows[0]!);
  });
}

export async function markRulebookComplete(
  orgId: string,
): Promise<OnboardingStatusView> {
  return withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE onboarding_status SET
        rulebook_complete = TRUE,
        completed_at = COALESCE(completed_at, now()),
        updated_at = now()
      WHERE org_id = ${orgId}::uuid
      RETURNING *
    `;
    return toView(rows[0]!);
  });
}
