/**
 * POST /api/rulebook/merge — Path B accept (§9.4.3). Persists the
 * org's per-row decisions into the org rulebook.
 *
 * Body: { uploadId, decisions: [{ payerId, state, cptCode, attribute,
 *         coverageStatus, ruleValue }] }
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { mergeUploadedRulebook } from "@/lib/features/rulebook/rulebook.service";
import { COVERAGE_STATUSES } from "@/lib/features/rulebook/rulebook.types";

const Body = z.object({
  uploadId: z.string().uuid(),
  decisions: z
    .array(
      z.object({
        payerId: z.string().uuid().nullable(),
        state: z.string().length(2),
        cptCode: z.string().min(4).max(5),
        attribute: z.string().min(3).max(40),
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
    return fail(err instanceof Error ? err.message : "Merge failed", {
      status: 422,
    });
  }
}
