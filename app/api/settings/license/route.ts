/** Disclose whether the AMA CPT license is active in this environment. */
import { ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { hasAmaLicense } from "@/lib/features/billing/code.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  return ok({
    amaLicensed: hasAmaLicense(),
  });
}
