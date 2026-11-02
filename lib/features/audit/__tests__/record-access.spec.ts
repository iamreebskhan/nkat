/**
 * Who opened or exported a patient's record (record-access.service.ts).
 *
 * phi_access_log and phi_export_log were written and retained, and nothing
 * read them back: a practice could not see who had looked at a patient's
 * chart. The read is one timeline over both logs, in the org's context, with
 * each download once (the export routes write it to both).
 *
 * lib/db is mocked with a fake tx that records SQL; the real query is proved
 * against the database on localhost.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { listRecordAccess } from "../record-access.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "278401e4-429d-43d0-acf1-3f894b53888f";

let calls: { sql: string; values: unknown[] }[] = [];
let rowsOut: unknown[] = [];

beforeEach(() => {
  calls = [];
  rowsOut = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)({
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join("¶"), values });
        return Promise.resolve(rowsOut);
      },
    }),
  );
});

describe("listRecordAccess", () => {
  it("reads both logs, each named by the caller's org, in the caller's org context", async () => {
    await listRecordAccess({ orgId: ORG });
    const { sql, values } = calls[0]!;
    expect(sql).toContain("FROM phi_access_log a");
    expect(sql).toContain("FROM phi_export_log e");
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("WHERE a.org_id = ");
    expect(sql).toContain("WHERE e.org_id = ");
    expect(values.filter((v) => v === ORG)).toHaveLength(2);
    expect(vi.mocked(withOrgContext).mock.calls[0]![0]).toBe(ORG);
  });

  it("filters to one patient, across opens and exports alike", async () => {
    await listRecordAccess({ orgId: ORG, patientId: PATIENT });
    const { sql, values } = calls[0]!;
    expect(sql).toContain("r.patient_id = ");
    expect(values.filter((v) => v === PATIENT)).toHaveLength(2);
  });

  it("joins a patient only within the same org", async () => {
    await listRecordAccess({ orgId: ORG });
    const { sql } = calls[0]!;
    expect(sql).toContain("LEFT JOIN patient p ON p.id = a.patient_id AND p.org_id = a.org_id");
    expect(sql).toContain("LEFT JOIN patient p ON p.id = pid AND p.org_id = e.org_id");
  });

  it("shows an export from the export log only when the access log does not already hold it", async () => {
    await listRecordAccess({ orgId: ORG });
    const { sql } = calls[0]!;
    const exportBranch = sql.slice(sql.indexOf("FROM phi_export_log e"));
    expect(exportBranch).toContain("AND NOT EXISTS (");
    expect(exportBranch).toContain("a2.access_type = 'export'");
    expect(exportBranch).toContain("a2.context = e.export_type");
    expect(exportBranch).toContain("a2.patient_id = pid");
  });

  it("pages on the time to the microsecond and the row, and says where the next page starts only when this one is full", async () => {
    const ACCESS_ID = "0b6e8f8e-3c2a-4d7e-9a51-1f2d3c4b5a69";
    rowsOut = [
      {
        id: ACCESS_ID, kind: "access", occurred_at: new Date("2026-10-22T12:00:00.123Z"),
        at_micros: "2026-10-22T12:00:00.123456Z", row_key: `access:${ACCESS_ID}:`, user_email: "a@x.test",
        patient_id: PATIENT, patient_name: "Test Livepatient", what: "view", context: "patient_record",
        ip_address: null,
      },
    ];
    const one = await listRecordAccess({ orgId: ORG, limit: 1 });
    expect(one.nextCursor).toBe(`2026-10-22T12:00:00.123456Z|access:${ACCESS_ID}:`);
    expect(one.rows[0]).toMatchObject({ kind: "access", patientName: "Test Livepatient", what: "view" });
    const two = await listRecordAccess({ orgId: ORG, limit: 2 });
    expect(two.nextCursor).toBeNull();

    // The next page starts strictly after that row: same time, later key, kept.
    await listRecordAccess({ orgId: ORG, cursor: one.nextCursor! });
    const { sql, values } = calls[calls.length - 1]!;
    expect(sql).toContain("(r.occurred_at, r.row_key COLLATE \"C\")");
    expect(values).toContain("2026-10-22T12:00:00.123456Z");
    expect(values).toContain(`access:${ACCESS_ID}:`);
  });

  it("refuses a cursor it did not hand out", async () => {
    await expect(listRecordAccess({ orgId: ORG, cursor: "2026-10-22T12:00:00.000Z" })).rejects.toThrow(
      /malformed cursor/,
    );
  });
});
