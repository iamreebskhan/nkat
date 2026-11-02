/**
 * GET /api/offline/snapshot — the copy of my caseload and my coming visits a
 * clinician takes onto their device for a home with no signal (0119; doc:33;
 * Mark Q8 default). patients.view, as reading those charts takes; the visits
 * are only the caller's own. Logged as a PHI export.
 */
import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getOfflineSnapshot } from "@/lib/features/offline/offline-snapshot.service";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  try {
    const res = ok(await getOfflineSnapshot({ orgId: session.orgId, userId: session.userId }));
    // PHI: never kept by a cache between here and the device.
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return handleServiceError(err);
  }
}
