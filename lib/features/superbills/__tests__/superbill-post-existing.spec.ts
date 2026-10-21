/**
 * POST /api/visits/[id]/superbill on a visit that already has a bill.
 *
 * The bill page and Create Bill post here when the bill did not exist when
 * they loaded. Saved since — at sign-off, by someone else, in another tab — the
 * route used to rebuild the draft from the visit, write it over that bill and
 * answer 201 "created": a stale "Save superbill" on localhost wiped a reviewed
 * bill's modifier 33 and left it "ready to submit". It now hands the bill back
 * as it stands, 200 with created: false, so the screen can show it.
 *
 * The handler is driven directly; its services are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/features/visits/visit-access", () => ({ requireVisitAccess: vi.fn() }));
vi.mock("@/lib/hipaa/phi-access-log", () => ({ logPhiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/features/superbills/superbill.service", () => ({
  getSuperbillByVisit: vi.fn(),
  buildDraftFromVisit: vi.fn(),
  persistDraft: vi.fn(),
}));

import { type NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import {
  buildDraftFromVisit,
  getSuperbillByVisit,
  persistDraft,
} from "@/lib/features/superbills/superbill.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

import { POST } from "@/app/api/visits/[id]/superbill/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VISIT = "d855b6b1-e2c2-49c7-9ecc-17bbdc29a12f";
const PATIENT = "100d40c3-2ce2-4d86-8b55-58e9f42f55fa";
const BILL = "4aa35448-1786-46fb-8fe9-434bb29af746";

/** The bill as it stands: reviewed, with the biller's modifier. */
const SAVED = {
  id: BILL, visitId: VISIT, patientId: PATIENT, status: "ready_to_submit",
  cptCodes: ["99497"], modifiers: ["33"], icd10Codes: ["C34.90"], billedAmountCents: 7660,
};
const DRAFT = { visitId: VISIT, patientId: PATIENT, cptCodes: ["99497"], modifiers: [] };

const req = new Request(`http://localhost/api/visits/${VISIT}/superbill`, { method: "POST" }) as unknown as NextRequest;
const post = () => POST(req, { params: Promise.resolve({ id: VISIT }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({
    orgId: ORG, userId: ME, permissions: ["billing.superbills.create"],
  } as never);
  vi.mocked(requireVisitAccess).mockResolvedValue(null);
  vi.mocked(getSuperbillByVisit).mockResolvedValue(null);
  vi.mocked(buildDraftFromVisit).mockResolvedValue(DRAFT as never);
  vi.mocked(persistDraft).mockResolvedValue({ id: "5b000000-0000-4000-8000-000000000001", created: true });
});

describe("POST /api/visits/[id]/superbill", () => {
  it("hands back a bill saved since the screen loaded, as it stands, and writes nothing", async () => {
    vi.mocked(getSuperbillByVisit).mockResolvedValue(SAVED as never);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { id: BILL, created: false, existing: SAVED, draft: null },
      error: null,
    });
    expect(buildDraftFromVisit).not.toHaveBeenCalled();
    expect(persistDraft).not.toHaveBeenCalled();
    // The bill's member id and diagnoses went out, so it is logged as the GET logs it.
    expect(logPhiAccess).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, userId: ME, patientId: PATIENT, accessType: "view", context: "superbill" }),
    );
  });

  it("CONTROL: still creates the bill for a visit that has none: 201, with the draft", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ id: "5b000000-0000-4000-8000-000000000001", draft: DRAFT });
    expect(persistDraft).toHaveBeenCalledWith({ orgId: ORG, draft: DRAFT, actorUserId: ME });
    expect(logPhiAccess).not.toHaveBeenCalled();
  });

  it("says when it created the bill", async () => {
    expect((await (await post()).json()).data.created).toBe(true);
  });

  it("hands back the bill someone else saved between its read and its write", async () => {
    vi.mocked(getSuperbillByVisit).mockResolvedValueOnce(null).mockResolvedValueOnce(SAVED as never);
    vi.mocked(persistDraft).mockResolvedValue({ id: BILL, created: false });
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: BILL, created: false, existing: SAVED, draft: null });
  });

  it("says to reload when that bill cannot then be read", async () => {
    vi.mocked(persistDraft).mockResolvedValue({ id: BILL, created: false });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This visit already has a bill. Reload the page to open it.");
  });

  it("reads nothing for a caller refused the visit", async () => {
    vi.mocked(requireVisitAccess).mockResolvedValue(
      Response.json({ success: false, data: null, error: "Permission denied" }, { status: 403 }) as never,
    );
    const res = await post();
    expect(res.status).toBe(403);
    expect(getSuperbillByVisit).not.toHaveBeenCalled();
    expect(logPhiAccess).not.toHaveBeenCalled();
  });
});
