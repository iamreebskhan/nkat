/**
 * The default discharge and NTUC codes (0111) against the practice's own
 * Trend Report numbering ('Discharges and NTUC' sheet): discharges 01-10 with
 * 01b/02b, NTUC 20a-27.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_REASON_CODES, REASON_CATEGORIES, REASON_CODE_PATTERN } from "../reason-codes";

const codes = (kind: string) => DEFAULT_REASON_CODES.filter((c) => c.kind === kind).map((c) => c.code);

describe("DEFAULT_REASON_CODES", () => {
  it("numbers discharges and NTUC as the Trend Report does", () => {
    expect(codes("discharge")).toEqual(["01", "01b", "02", "02b", "03", "04", "05", "06", "07", "08", "09", "10"]);
    expect(codes("ntuc")).toEqual(["20a", "20b", "21a", "21b", "22a", "22b", "23", "24", "25", "26", "27"]);
  });

  it("names no practice: the partner hospice and hospitals are each practice's to fill in", () => {
    const generic = /^(Hospice - (partner hospice|other)|To (the partner|another) hospice)(, from hospital)?$/;
    const hospice = DEFAULT_REASON_CODES.filter((c) => c.category === "hospice_partner" || c.category === "hospice_other");
    expect(hospice).toHaveLength(9);
    for (const c of hospice) expect(c.label).toMatch(generic);
  });

  it("counts every hospice code as a transition, and deaths as deaths", () => {
    const cat = (code: string, kind = "discharge") =>
      DEFAULT_REASON_CODES.find((c) => c.code === code && c.kind === kind)!.category;
    expect(["01", "01b"].map((c) => cat(c))).toEqual(["hospice_partner", "hospice_partner"]);
    expect(["02", "02b", "04"].map((c) => cat(c))).toEqual(["hospice_other", "hospice_other", "hospice_other"]);
    expect(cat("08")).toBe("death");
    expect(cat("26", "ntuc")).toBe("death");
  });

  it("fits the table: the pattern, a known category, one row per kind and code", () => {
    const sql = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "db", "migrations", "0111_intake_referrals.sql"),
      "utf8",
    );
    const allowed = [...(/category IN \(([\s\S]*?)\)\)/.exec(sql)![1]!.matchAll(/'([a-z_]+)'/g))].map((m) => m[1]);
    expect([...REASON_CATEGORIES].sort()).toEqual(allowed.sort());
    const keys = new Set<string>();
    for (const c of DEFAULT_REASON_CODES) {
      expect(c.code).toMatch(REASON_CODE_PATTERN);
      expect(allowed).toContain(c.category);
      keys.add(`${c.kind}:${c.code}`);
    }
    expect(keys.size).toBe(DEFAULT_REASON_CODES.length);
  });
});
