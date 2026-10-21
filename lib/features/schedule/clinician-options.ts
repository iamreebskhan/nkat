/**
 * Who the signed-in user may pick as the clinician in the schedule's two
 * composers (Add PTO and New visit).
 *
 * The full roster comes from /api/team/members, which needs team.view — a
 * permission the shipped clinician template does not carry. Both composers
 * used to read that one endpoint and, when it refused, silently leave the list
 * empty. The Clinician field is required, so a clinician could book neither
 * their own leave nor their own visit, and nothing on screen said why: the
 * dropdown just held "Select…". Found by opening Add PTO as a clinician in the
 * browser; every test passed, because none of them rendered that page.
 *
 * The server already lets them act on their own calendar — createTimeOff's
 * caller rule, and scheduleVisit's active-member check — so for someone who
 * cannot see the roster the honest list is themselves.
 *
 * Lives here rather than in the page so it can be tested: vitest does not
 * collect specs from app/.
 */

export interface ClinicianOption {
  userId: string;
  email: string;
  fullName: string | null;
}

export async function loadClinicianOptions(
  fetcher: typeof fetch = fetch,
): Promise<ClinicianOption[]> {
  const roster = await fetcher("/api/team/members?active=1")
    .then((r) => r.json())
    .catch(() => null);
  if (roster?.success) return roster.data?.rows ?? [];

  const me = await fetcher("/api/auth/me")
    .then((r) => r.json())
    .catch(() => null);
  const u = me?.data;
  return u?.userId ? [{ userId: u.userId, email: u.email, fullName: u.fullName ?? null }] : [];
}
