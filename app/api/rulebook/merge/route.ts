/**
 * POST /api/rulebook/merge — Path B accept (§9.4.3). Persists the
 * org's per-row decisions into the org rulebook.
 *
 * Body: { uploadId, decisions: [{ payerId, state, cptCode, attribute,
 *         use?: "library" | "upload", coverageStatus, ruleValue }] }
 *
 * `use: "library"` keeps Pallio's rule for the cell, as a copy that follows
 * the library (its coverageStatus and ruleValue are not used); "upload", or
 * no `use`, keeps the practice's own value.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { ATTRIBUTE_DB_MAP } from "@/lib/features/billing/payer-rule.repository";
import { mergeUploadedRulebook } from "@/lib/features/rulebook/rulebook.service";
import { COVERAGE_STATUSES } from "@/lib/features/rulebook/rulebook.types";

/** An attribute under either name: the file's ('prior_auth') or the library's ('prior_auth_required'). */
const ATTRIBUTES = new Set<string>([...Object.keys(ATTRIBUTE_DB_MAP), ...Object.values(ATTRIBUTE_DB_MAP)]);

const Body = z.object({
  uploadId: z.string().uuid(),
  decisions: z
    .array(
      z.object({
        payerId: z.string().uuid().nullable(),
        state: z.string().length(2),
        cptCode: z.string().min(4).max(5),
        attribute: z.string().refine((a) => ATTRIBUTES.has(a), { message: "Unknown rule attribute." }),
        use: z.enum(["library", "upload"]).optional(),
        coverageStatus: z.enum(COVERAGE_STATUSES),
        ruleValue: z.record(z.unknown()),
      }),
    )
    .min(1)
    .max(5000),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["knowledge.edit"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  try {
    const r = await mergeUploadedRulebook({
      orgId: session.orgId,
      uploadId: body.uploadId,
      byUserId: session.userId,
      decisions: body.decisions,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
