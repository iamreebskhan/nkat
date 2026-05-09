import { describe, expect, it } from "vitest";

import {
  AMA_PLACEHOLDER,
  gateAmaDescriptors,
  type CodeRowFromDb,
} from "../code-pure";

const cpt: CodeRowFromDb = {
  code: "99349",
  code_system: "CPT",
  short_descriptor: "Established Patient Home Visit, 40 min",
  category: "E/M Home Visit",
  effective_date: new Date("2024-01-01"),
  expiration_date: null,
};

const hcpcs: CodeRowFromDb = {
  code: "G0318",
  code_system: "HCPCS2",
  short_descriptor: "Prolonged Service (Medicare)",
  category: "Prolonged Service",
  effective_date: new Date("2024-01-01"),
  expiration_date: null,
};

describe("gateAmaDescriptors", () => {
  it("redacts CPT short_descriptor when license is absent", () => {
    const [view] = gateAmaDescriptors([cpt], false);
    expect(view.short_descriptor).toBe(AMA_PLACEHOLDER);
    expect(view.ama_descriptor_redacted).toBe(true);
    // Code itself + metadata always pass through.
    expect(view.code).toBe("99349");
    expect(view.category).toBe("E/M Home Visit");
  });

  it("returns CPT short_descriptor verbatim when license is present", () => {
    const [view] = gateAmaDescriptors([cpt], true);
    expect(view.short_descriptor).toBe("Established Patient Home Visit, 40 min");
    expect(view.ama_descriptor_redacted).toBe(false);
  });

  it("never redacts HCPCS Level II — they're CMS public domain", () => {
    const [view] = gateAmaDescriptors([hcpcs], false);
    expect(view.short_descriptor).toBe("Prolonged Service (Medicare)");
    expect(view.ama_descriptor_redacted).toBe(false);
  });

  it("formats dates as ISO YYYY-MM-DD", () => {
    const [view] = gateAmaDescriptors(
      [{ ...cpt, effective_date: new Date("2025-03-15T00:00:00Z") }],
      true,
    );
    expect(view.effective_date).toBe("2025-03-15");
  });

  it("preserves expiration_date null vs ISO date", () => {
    const [v1] = gateAmaDescriptors([cpt], true);
    expect(v1.expiration_date).toBeNull();
    const [v2] = gateAmaDescriptors(
      [{ ...cpt, expiration_date: new Date("2026-12-31T00:00:00Z") }],
      true,
    );
    expect(v2.expiration_date).toBe("2026-12-31");
  });
});
