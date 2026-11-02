/**
 * The session's idle clock (0121; HIPAA 164.312(a)(2)(iii), ONC (d)(5)).
 *
 * GET  — when the session was last used and its limit, without touching it:
 *        a tab about to sign out asks first, in case another tab was in use.
 * POST — the person did something: the session is re-signed with now as its
 *        last activity. The browser sends this at most once a minute, and only
 *        after a key, a click, a touch or a scroll; background refreshes never
 *        do, so an open tab nobody touches still reaches its limit. It also
 *        says whether the refresh left the session owing a second factor.
 *
 * A session past its limit answers 401 to both: getSession() refuses it.
 */
import { fail, ok } from "@/lib/api";
import { getSession, setSessionCookie, signSession } from "@/lib/auth";
import { mfaRequiredFor, readSessionPolicy } from "@/lib/features/auth/session-policy";

export async function GET(): Promise<Response> {
  const s = await getSession();
  if (!s) return fail("Not authenticated.", { status: 401 });
  return ok({ act: s.act, idleMinutes: s.idle, now: Math.floor(Date.now() / 1000) });
}

export async function POST(): Promise<Response> {
  const s = await getSession();
  if (!s) return fail("Not authenticated.", { status: 401 });
  const act = Math.floor(Date.now() / 1000);
  // Re-signing also reads the org's limit and MFA policy again, so a change
  // made by an admin reaches a session in use within a minute.
  await setSessionCookie(await signSession(s, { mfa: s.mfa, act }));
  const { idleMinutes, mfaPolicy } = await readSessionPolicy(s.orgId);
  // Said here because nothing else can say it: the layout that holds MfaGate
  // does not re-render on an in-app navigation, so a page already open would
  // go on answering with the API's refusals (components/auth/idle-guard.tsx).
  const mfaPending = !s.mfa && mfaRequiredFor(s.role, s.permissions, mfaPolicy);
  return ok({ act, idleMinutes, now: act, mfaPending });
}
