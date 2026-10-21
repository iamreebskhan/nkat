/**
 * The draft bill raised at sign-off, and what the clinician is told about it.
 *
 * The draft was always best-effort — a visit signs even if billing prep fails
 * — but a failure used to go to error tracking and nowhere else. The route
 * returned superbillId: null, the page showed "Submitted" regardless, and the
 * clinician left believing a bill existed. autoDraftSuperbill now returns the
 * outcome with a reason fit for the screen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../superbill.service", () => ({
  buildDraftFromVisit: vi.fn(),
  getSuperbillByVisit: vi.fn(),
  persistDraft: vi.fn(),
}));
vi.mock("@/lib/observability/sentry", () => ({ reportError: vi.fn() }));

import { NotFoundError, ValidationError } from "@/lib/api";
import { reportError } from "@/lib/observability/sentry";

import { AUTO_DRAFT_GENERIC_REASON, autoDraftSuperbill } from "../auto-draft";
import { buildDraftFromVisit, getSuperbillByVisit, persistDraft } from "../superbill.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "e0000000-0000-4000-8000-00000000000c";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRAFT = { visitId: VISIT } as unknown as Awaited<ReturnType<typeof buildDraftFromVisit>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSuperbillByVisit).mockResolvedValue(null);
  vi.mocked(buildDraftFromVisit).mockResolvedValue(DRAFT);
  vi.mocked(persistDraft).mockResolvedValue({ id: "sb-1", created: true });
});

const run = () => autoDraftSuperbill({ orgId: ORG, visitId: VISIT, actorUserId: USER });

describe("autoDraftSuperbill", () => {
  it("returns the new bill's id when the draft is raised", async () => {
    expect(await run()).toEqual({ superbillId: "sb-1", reason: null });
    expect(persistDraft).toHaveBeenCalledWith({ orgId: ORG, draft: DRAFT, actorUserId: USER });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("leaves a visit billed before it was submitted with the bill it has", async () => {
    // Billed from the billing side while it sat signed, then edited there.
    // Drafting it again wrote the visit's codes back over those edits, with
    // nothing on the bill's history to say so (localhost, 21 Oct).
    vi.mocked(getSuperbillByVisit).mockResolvedValue({ id: "sb-billed" } as Awaited<ReturnType<typeof getSuperbillByVisit>>);
    expect(await run()).toEqual({ superbillId: "sb-billed", reason: null });
    expect(getSuperbillByVisit).toHaveBeenCalledWith({ orgId: ORG, visitId: VISIT });
    expect(buildDraftFromVisit).not.toHaveBeenCalled();
    expect(persistDraft).not.toHaveBeenCalled();
  });

  it("does not turn a failure to read the bill into a failed sign-off", async () => {
    vi.mocked(getSuperbillByVisit).mockRejectedValueOnce(new Error("connection reset"));
    expect(await run()).toEqual({ superbillId: null, reason: AUTO_DRAFT_GENERIC_REASON });
  });

  it("never throws — the sign-off must survive a billing-prep failure", async () => {
    vi.mocked(persistDraft).mockRejectedValueOnce(new Error("connection reset"));
    await expect(run()).resolves.toMatchObject({ superbillId: null });
  });

  it("passes our own user-facing messages through unchanged", async () => {
    // Service errors are already written for the person at the screen.
    vi.mocked(buildDraftFromVisit).mockRejectedValueOnce(
      new ValidationError("This visit is in_progress and has not been signed."),
    );
    expect(await run()).toEqual({
      superbillId: null,
      reason: "This visit is in_progress and has not been signed.",
    });
    expect(persistDraft).not.toHaveBeenCalled();
  });

  it("passes a not-found message through too", async () => {
    vi.mocked(buildDraftFromVisit).mockRejectedValueOnce(new NotFoundError("Visit not found."));
    expect((await run()).reason).toBe("Visit not found.");
  });

  it("summarises anything else rather than showing a clinician a driver error", async () => {
    // A constraint name is not something a clinician can act on, and it can
    // carry schema detail that has no business on a clinical screen.
    vi.mocked(persistDraft).mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "superbill_visit_id_key"'),
    );
    const r = await run();
    expect(r).toEqual({ superbillId: null, reason: AUTO_DRAFT_GENERIC_REASON });
    expect(r.reason).not.toMatch(/constraint|duplicate key/);
  });

  it("still reports every failure to error tracking, with the original error", async () => {
    // Error tracking is where the cause gets fixed. The change is that it is
    // no longer the only place the failure goes.
    const boom = new Error("connection reset");
    vi.mocked(persistDraft).mockRejectedValueOnce(boom);
    await run();
    expect(reportError).toHaveBeenCalledWith(boom, { source: "transition:autoDraftSuperbill" });
  });
});
