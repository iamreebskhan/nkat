import { describe, expect, it } from "vitest";

import { slugify } from "../auth.service";

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("Acme Hospice")).toBe("acme-hospice");
  });

  it("collapses runs of non-alnum to single dash", () => {
    expect(slugify("Acme   &   Co!")).toBe("acme-co");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugify("--acme--")).toBe("acme");
  });

  it("caps at 60 chars", () => {
    const long = "a".repeat(120);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });

  it("falls back to 'org' on empty input", () => {
    expect(slugify("!!!")).toBe("org");
    expect(slugify("")).toBe("org");
  });

  it("strips diacritics", () => {
    expect(slugify("Café Médical")).toBe("cafe-medical");
  });
});
