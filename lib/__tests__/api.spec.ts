/**
 * lib/api error-policy + param-guard helpers. These back the repo-wide
 * sweep that stopped raw Postgres/Prisma error text (and 22P02 on a
 * non-UUID path id) from reaching clients.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/sentry", () => ({ reportError: vi.fn() }));

import {
  NotFoundError,
  SeatLimitError,
  ValidationError,
  handleServiceError,
  isUuid,
  requireUuidParam,
} from "../api";
import { reportError } from "@/lib/observability/sentry";

const UUID = "593374d9-acc6-4c46-a683-6d0940d565e8";

async function statusAndBody(res: Response) {
  return { status: res.status, body: await res.json() };
}

describe("isUuid", () => {
  it("accepts a canonical uuid, rejects junk", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(true);
    expect(isUuid("undefined")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("593374d9")).toBe(false);
    expect(isUuid(`${UUID}'; DROP TABLE patient;--`)).toBe(false);
  });
});

describe("requireUuidParam", () => {
  it("returns null for a valid uuid (handler proceeds)", () => {
    expect(requireUuidParam(UUID)).toBeNull();
  });
  it("returns a 404 envelope for a malformed id (no existence leak)", async () => {
    const res = requireUuidParam("undefined");
    expect(res).not.toBeNull();
    const { status, body } = await statusAndBody(res!);
    expect(status).toBe(404);
    expect(body).toEqual({ success: false, data: null, error: "Not found." });
  });
});

describe("handleServiceError", () => {
  it("NotFoundError → 404 with its message echoed", async () => {
    const { status, body } = await statusAndBody(handleServiceError(new NotFoundError("Visit not found.")));
    expect(status).toBe(404);
    expect(body.error).toBe("Visit not found.");
  });

  it("SeatLimitError → 402", async () => {
    const { status } = await statusAndBody(handleServiceError(new SeatLimitError()));
    expect(status).toBe(402);
  });

  it("ValidationError → 422 with its message echoed", async () => {
    const { status, body } = await statusAndBody(handleServiceError(new ValidationError("Illegal superbill transition draft → paid.")));
    expect(status).toBe(422);
    expect(body.error).toContain("Illegal superbill transition");
  });

  it("unknown error → generic 500 that leaks NOTHING + reports it", async () => {
    vi.mocked(reportError).mockClear();
    // e.g. a Prisma raw-query failure whose message embeds the SQL
    const leaky = new Error('invalid input syntax for type uuid: "undefined"\nquery: SELECT * FROM patient WHERE id = $1');
    const { status, body } = await statusAndBody(handleServiceError(leaky));
    expect(status).toBe(500);
    expect(body.error).toBe("Something went wrong. Try again or contact support.");
    expect(body.error).not.toContain("uuid");
    expect(body.error).not.toContain("SELECT");
    expect(reportError).toHaveBeenCalledOnce();
  });
});
