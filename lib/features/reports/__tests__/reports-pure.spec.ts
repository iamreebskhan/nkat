import { describe, expect, it } from "vitest";

import {
  denialRateTrend,
  denialsByPayer,
  revenueSummary,
  ruleCoverage,
  visitVolumeByClinician,
} from "../reports-pure";

const PAYER_A = "11111111-1111-4111-8111-111111111111";
const PAYER_B = "22222222-2222-4222-8222-222222222222";

describe("denialRateTrend", () => {
  it("emits a value per day in the [from, to] range, inclusive", () => {
    const series = denialRateTrend({
      superbills: [],
      denials: [],
      fromDate: new Date("2026-05-01T00:00:00Z"),
      toDate: new Date("2026-05-03T00:00:00Z"),
    });
    expect(series).toHaveLength(3);
    expect(series[0].date).toBe("2026-05-01");
    expect(series[2].date).toBe("2026-05-03");
  });

  it("zero rate when nothing billed that day", () => {
    const series = denialRateTrend({
      superbills: [],
      denials: [
        {
          carcCode: "197",
          payerId: PAYER_A,
          cptCode: "99349",
          deniedAmountCents: 5000,
          decision: "pending",
          outcome: "pending",
          deniedAt: "2026-05-01T10:00:00Z",
        },
      ],
      fromDate: new Date("2026-05-01T00:00:00Z"),
      toDate: new Date("2026-05-01T00:00:00Z"),
    });
    expect(series[0].value).toBe(0); // No denominator → 0%
  });

  it("computes percentage rate to 2 decimal places", () => {
    const series = denialRateTrend({
      superbills: [
        {
          payerId: PAYER_A,
          status: "submitted",
          billedAmountCents: 100_00,
          paidAmountCents: null,
          dateOfService: "2026-05-01",
        },
      ],
      denials: [
        {
          carcCode: "50",
          payerId: PAYER_A,
          cptCode: "99349",
          deniedAmountCents: 25_00,
          decision: "pending",
          outcome: "pending",
          deniedAt: "2026-05-01T08:00:00Z",
        },
      ],
      fromDate: new Date("2026-05-01T00:00:00Z"),
      toDate: new Date("2026-05-01T00:00:00Z"),
    });
    expect(series[0].value).toBe(25); // 25%
  });
});

describe("denialsByPayer", () => {
  it("groups by payer_id with $ + count + rate", () => {
    const out = denialsByPayer({
      superbills: [
        { payerId: PAYER_A, status: "submitted", billedAmountCents: 100_00, paidAmountCents: null, dateOfService: "2026-05-01" },
        { payerId: PAYER_A, status: "submitted", billedAmountCents: 100_00, paidAmountCents: null, dateOfService: "2026-05-02" },
        { payerId: PAYER_B, status: "submitted", billedAmountCents: 100_00, paidAmountCents: null, dateOfService: "2026-05-01" },
      ],
      denials: [
        { carcCode: "50", payerId: PAYER_A, cptCode: "99349", deniedAmountCents: 25_00, decision: "pending", outcome: "pending", deniedAt: "2026-05-01T08:00:00Z" },
      ],
    });
    const a = out.find((p) => p.payerId === PAYER_A)!;
    expect(a.count).toBe(1);
    expect(a.deniedCents).toBe(2500);
    expect(a.rate).toBeCloseTo(0.5);
  });

  it("excludes draft + voided from rate denominator", () => {
    const out = denialsByPayer({
      superbills: [
        { payerId: PAYER_A, status: "draft", billedAmountCents: 100_00, paidAmountCents: null, dateOfService: "2026-05-01" },
        { payerId: PAYER_A, status: "voided", billedAmountCents: 100_00, paidAmountCents: null, dateOfService: "2026-05-01" },
        { payerId: PAYER_A, status: "submitted", billedAmountCents: 100_00, paidAmountCents: null, dateOfService: "2026-05-01" },
      ],
      denials: [
        { carcCode: "50", payerId: PAYER_A, cptCode: "99349", deniedAmountCents: 100_00, decision: "pending", outcome: "pending", deniedAt: "2026-05-01T08:00:00Z" },
      ],
    });
    expect(out[0].rate).toBe(1); // 1 denial / 1 submitted
  });

  it("sorts highest dollar impact first", () => {
    const out = denialsByPayer({
      superbills: [
        { payerId: PAYER_A, status: "submitted", billedAmountCents: 100_00, paidAmountCents: null, dateOfService: "2026-05-01" },
        { payerId: PAYER_B, status: "submitted", billedAmountCents: 100_00, paidAmountCents: null, dateOfService: "2026-05-01" },
      ],
      denials: [
        { carcCode: "50", payerId: PAYER_A, cptCode: "99349", deniedAmountCents: 25_00, decision: "pending", outcome: "pending", deniedAt: "2026-05-01T08:00:00Z" },
        { carcCode: "50", payerId: PAYER_B, cptCode: "99349", deniedAmountCents: 75_00, decision: "pending", outcome: "pending", deniedAt: "2026-05-01T08:00:00Z" },
      ],
    });
    expect(out[0].payerId).toBe(PAYER_B);
  });
});

describe("revenueSummary", () => {
  it("sums billed/paid + collection rate", () => {
    const r = revenueSummary([
      { payerId: PAYER_A, status: "paid", billedAmountCents: 100_00, paidAmountCents: 100_00, dateOfService: "2026-05-01" },
      { payerId: PAYER_A, status: "partially_paid", billedAmountCents: 100_00, paidAmountCents: 60_00, dateOfService: "2026-05-02" },
      { payerId: PAYER_A, status: "submitted", billedAmountCents: 100_00, paidAmountCents: null, dateOfService: "2026-05-03" },
    ]);
    expect(r.billedCents).toBe(30000);
    expect(r.paidCents).toBe(16000);
    // outstanding = (submitted: 10000) + (partial: 10000-6000=4000) = 14000
    expect(r.outstandingCents).toBe(14000);
    expect(r.collectionRate).toBeCloseTo(16000 / 30000);
  });

  it("zero collectionRate when nothing billed", () => {
    expect(revenueSummary([]).collectionRate).toBe(0);
  });
});

describe("visitVolumeByClinician", () => {
  it("counts only documented+ visits", () => {
    const v = visitVolumeByClinician([
      { visitType: "established_patient_home", status: "documented", clinicianUserId: "u1", scheduledStart: "2026-05-01", startTime: null },
      { visitType: "established_patient_home", status: "documented", clinicianUserId: "u1", scheduledStart: "2026-05-02", startTime: null },
      { visitType: "established_patient_home", status: "scheduled", clinicianUserId: "u1", scheduledStart: "2026-05-03", startTime: null },
      { visitType: "established_patient_home", status: "cancelled", clinicianUserId: "u1", scheduledStart: "2026-05-04", startTime: null },
      { visitType: "established_patient_home", status: "billed", clinicianUserId: "u2", scheduledStart: "2026-05-01", startTime: null },
    ]);
    const u1 = v.find((x) => x.clinicianUserId === "u1");
    const u2 = v.find((x) => x.clinicianUserId === "u2");
    expect(u1?.count).toBe(2);
    expect(u2?.count).toBe(1);
  });

  it("sorts highest count first", () => {
    const v = visitVolumeByClinician([
      { visitType: "established_patient_home", status: "documented", clinicianUserId: "u1", scheduledStart: "2026-05-01", startTime: null },
      { visitType: "established_patient_home", status: "documented", clinicianUserId: "u2", scheduledStart: "2026-05-01", startTime: null },
      { visitType: "established_patient_home", status: "documented", clinicianUserId: "u2", scheduledStart: "2026-05-02", startTime: null },
    ]);
    expect(v[0].clinicianUserId).toBe("u2");
  });
});

describe("ruleCoverage", () => {
  it("computes coverage rate", () => {
    const r = ruleCoverage([
      { coverageStatus: "covered" },
      { coverageStatus: "covered" },
      { coverageStatus: "varies" },
      { coverageStatus: "unknown" },
    ]);
    expect(r.total).toBe(4);
    expect(r.confirmed).toBe(3);
    expect(r.unknown).toBe(1);
    expect(r.coverageRate).toBe(0.75);
  });

  it("zero coverage when empty", () => {
    expect(ruleCoverage([]).coverageRate).toBe(0);
  });
});
