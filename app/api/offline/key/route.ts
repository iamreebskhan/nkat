/**
 * GET /api/offline/key — the key that opens this clinician's offline copy
 * when they are signed in (0121; see lib/features/offline/offline-vault.ts).
 *
 * Not stored anywhere: derived from PALLIO_TOKEN_KEY, the org and the user, so
 * it is the same every time for the same clinician and useless for anyone
 * else. The copy's PIN opens it with no signal; this opens it whenever the
 * clinician can sign in, so notes written offline are never lost to a
 * forgotten PIN. patients.view, as the copy itself takes; never cached.
 */
import { createHmac } from "node:crypto";

import { fail, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Bumped to retire every copy's server wrapping at once. */
const OFFLINE_KEY_ID = "v1";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const secret = process.env.PALLIO_TOKEN_KEY;
  if (!secret || secret.length < 32) {
    return fail(
      "Offline copies are kept encrypted, and the server has no encryption key yet (PALLIO_TOKEN_KEY). Ask whoever runs the server to set it.",
      { status: 503 },
    );
  }
  const key = createHmac("sha256", secret)
    .update(`pallio-offline-${OFFLINE_KEY_ID}:${session.orgId}:${session.userId}`)
    .digest("base64");
  const res = ok({ keyId: OFFLINE_KEY_ID, key });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
