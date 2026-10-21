/**
 * The clinician list in the schedule's Add PTO and New visit composers.
 *
 * Both composers used to fill it from /api/team/members alone. That route
 * needs team.view, which the shipped clinician template does not carry, so for
 * every clinician the request was refused, the list stayed empty, and the
 * required Clinician field left them unable to book their own leave or their
 * own visit — with no message. It was found by opening Add PTO as a clinician
 * in the browser; the whole suite was green.
 *
 * These run the real loadClinicianOptions against a fake fetcher that answers
 * by URL, the way the two endpoints do. The CONTROL is the case that used to
 * fail: a refused roster must still produce the signed-in user.
 */
import { describe, expect, it, vi } from "vitest";

import { loadClinicianOptions } from "../clinician-options";

const PRIYA = { userId: "d0000000-0000-4000-8000-000000000103", email: "priya.raman@demo.pallio.io", fullName: "Priya Raman" };
const MARCUS = { userId: "d0000000-0000-4000-8000-000000000102", email: "marcus.delgado@demo.pallio.io", fullName: "Marcus Delgado" };

type Answer = unknown | Error;

/** A fetcher answering each URL with a JSON body, or rejecting with an Error. */
function fetcher(answers: Record<string, Answer>) {
  const fn = vi.fn(async (url: string | URL | Request) => {
    const key = String(url);
    const a = answers[key];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`fake fetcher: no answer for ${key}`);
    return { json: async () => a } as Response;
  });
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const ROSTER = "/api/team/members?active=1";
const ME = "/api/auth/me";
const REFUSED = { success: false, data: null, error: "Permission denied: missing team.view." };

describe("loadClinicianOptions", () => {
  it("offers the whole roster to someone who can see it, and never asks who they are", async () => {
    const f = fetcher({ [ROSTER]: { success: true, data: { rows: [PRIYA, MARCUS] } } });
    expect(await loadClinicianOptions(f)).toEqual([PRIYA, MARCUS]);
    // An admin must see everyone, not be collapsed to themselves.
    expect(f).not.toHaveBeenCalledWith(ME);
  });

  it("CONTROL — offers a clinician THEMSELVES when the roster is refused them", async () => {
    // The defect: the roster route refuses a clinician (no team.view), and the
    // old code left the list empty, so the required field could never be
    // filled. The server allows them their own calendar; so must the list.
    const f = fetcher({ [ROSTER]: REFUSED, [ME]: { success: true, data: PRIYA } });
    expect(await loadClinicianOptions(f)).toEqual([PRIYA]);
  });

  it("falls back the same way when the roster request fails outright", async () => {
    const f = fetcher({ [ROSTER]: new Error("network down"), [ME]: { success: true, data: PRIYA } });
    expect(await loadClinicianOptions(f)).toEqual([PRIYA]);
  });

  it("invents no one when it cannot tell who is signed in either", async () => {
    // An empty list is honest here; a made-up option would book leave for
    // somebody the server never named.
    const f = fetcher({ [ROSTER]: REFUSED, [ME]: { success: false, data: null } });
    expect(await loadClinicianOptions(f)).toEqual([]);
  });

  it("gives a missing name as null, so the composer falls back to the email", async () => {
    // The composers render `fullName ?? email`; undefined would pass through
    // that the same way today, but null is what MemberOption promises.
    const f = fetcher({ [ROSTER]: REFUSED, [ME]: { success: true, data: { userId: PRIYA.userId, email: PRIYA.email } } });
    expect(await loadClinicianOptions(f)).toEqual([{ userId: PRIYA.userId, email: PRIYA.email, fullName: null }]);
  });
});
