/**
 * The payer pickers list active payers only, with the states each has live
 * rules in (audit R17).
 *
 * listPayers returned every row and ignored payer.active, so a retired plan
 * could never leave intake, the rule lookup or the attestation form. And a
 * picker could not tell Aetna · NC (listed, no rules) from Aetna · OH.
 *
 * prisma is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: vi.fn() } }));

import { prisma } from "@/lib/db";

import { listPayers } from "../payer-rule.repository";

const sqlOf = () =>
  (vi.mocked(prisma.$queryRaw).mock.calls[0]![0] as unknown as TemplateStringsArray).join("¶");

beforeEach(() => {
  vi.mocked(prisma.$queryRaw).mockReset();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([
    { id: "p1", name: "Aetna", payer_type: "commercial", states_served: ["OH", "NC", "SC"], rule_states: ["OH"] },
  ] as never);
});

describe("listPayers", () => {
  it("reads active payers only, and the states each one has live rules in", async () => {
    await listPayers();
    const sql = sqlOf();
    expect(sql).toMatch(/WHERE\s+(p\.)?active\b/);
    expect(sql).toContain("rule_states");
    expect(sql).toContain("expiration_date IS NULL");
  });

  it("maps rule_states to ruleStates", async () => {
    expect(await listPayers()).toEqual([
      { id: "p1", name: "Aetna", type: "commercial", states: ["OH", "NC", "SC"], ruleStates: ["OH"] },
    ]);
  });

  it("reads a NULL array as empty", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: "p2", name: "New Plan", payer_type: "medicare_advantage_org", states_served: null, rule_states: null },
    ] as never);
    const [row] = await listPayers();
    expect(row).toMatchObject({ states: [], ruleStates: [] });
  });
});
