/** GET — preview invite (no auth). Used by the accept-invite landing page. */
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api";
import { previewInvite } from "@/lib/features/team/invite-redeem.service";

interface Params {
  params: Promise<{ token: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const { token } = await ctx.params;
  if (!/^[a-f0-9]{48}$/i.test(token)) {
    return fail("Invalid invite token format.", { status: 400 });
  }
  const preview = await previewInvite(token);
  if (!preview) {
    return fail("Invite not found, expired, or already redeemed.", { status: 410 });
  }
  return ok(preview);
}
