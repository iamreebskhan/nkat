/**
 * Branding service — per-org white-label settings.
 *
 * Source: pallio_complete_vision_v3 §6.1 (Org Settings → Branding).
 *
 * Cookies + middleware (Phase 7) flip the surface based on the
 * request's hostname when custom_domain is set + verified.
 */
import { z } from "zod";

import { withOrgContext } from "@/lib/db";

export const BrandingSchema = z.object({
  displayName: z.string().min(1).max(120).nullable().optional(),
  logoUrl: z.string().url().max(2000).nullable().optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Hex color #RRGGBB")
    .nullable()
    .optional(),
  customDomain: z
    .string()
    .max(200)
    .regex(/^[a-z0-9.-]+$/, "Lowercase letters, digits, dots, dashes only")
    .nullable()
    .optional(),
  emailFromName: z.string().max(120).nullable().optional(),
  emailFromAddress: z.string().email().max(200).nullable().optional(),
});
export type BrandingInput = z.infer<typeof BrandingSchema>;

export type DomainStatus = "unconfigured" | "pending" | "verified" | "failed";

export interface BrandingView {
  orgId: string;
  displayName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  customDomain: string | null;
  domainStatus: DomainStatus;
  domainLastChecked: string | null;
  emailFromName: string | null;
  emailFromAddress: string | null;
  updatedAt: string;
}

interface Row {
  org_id: string;
  display_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  custom_domain: string | null;
  domain_status: DomainStatus;
  domain_last_checked: Date | null;
  email_from_name: string | null;
  email_from_address: string | null;
  updated_at: Date;
}

function toView(r: Row): BrandingView {
  return {
    orgId: r.org_id,
    displayName: r.display_name,
    logoUrl: r.logo_url,
    primaryColor: r.primary_color,
    customDomain: r.custom_domain,
    domainStatus: r.domain_status,
    domainLastChecked: r.domain_last_checked?.toISOString() ?? null,
    emailFromName: r.email_from_name,
    emailFromAddress: r.email_from_address,
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function getBranding(orgId: string): Promise<BrandingView> {
  return withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      INSERT INTO org_branding (org_id) VALUES (${orgId}::uuid)
      ON CONFLICT (org_id) DO UPDATE SET updated_at = org_branding.updated_at
      RETURNING *
    `;
    return toView(rows[0]!);
  });
}

export async function updateBranding(args: {
  orgId: string;
  payload: BrandingInput;
}): Promise<BrandingView> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      INSERT INTO org_branding (
        org_id, display_name, logo_url, primary_color,
        custom_domain, domain_status,
        email_from_name, email_from_address
      ) VALUES (
        ${args.orgId}::uuid,
        ${p.displayName ?? null},
        ${p.logoUrl ?? null},
        ${p.primaryColor ?? null},
        ${p.customDomain ?? null},
        ${p.customDomain ? "pending" : "unconfigured"},
        ${p.emailFromName ?? null},
        ${p.emailFromAddress ?? null}
      )
      ON CONFLICT (org_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, org_branding.display_name),
        logo_url = COALESCE(EXCLUDED.logo_url, org_branding.logo_url),
        primary_color = COALESCE(EXCLUDED.primary_color, org_branding.primary_color),
        custom_domain = EXCLUDED.custom_domain,
        domain_status = CASE
          WHEN EXCLUDED.custom_domain IS DISTINCT FROM org_branding.custom_domain
          THEN ${p.customDomain ? "pending" : "unconfigured"}
          ELSE org_branding.domain_status
        END,
        email_from_name = COALESCE(EXCLUDED.email_from_name, org_branding.email_from_name),
        email_from_address = COALESCE(EXCLUDED.email_from_address, org_branding.email_from_address),
        updated_at = now()
      RETURNING *
    `;
    return toView(rows[0]!);
  });
}
