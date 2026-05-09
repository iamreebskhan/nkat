import { describe, expect, it } from "vitest";

import {
  suggestCodes,
  type SuggestVisitInput,
} from "../cpt-suggester";

const baseInput: SuggestVisitInput = {
  visitType: "established_patient_home",
  totalMinutes: 30,
  acpMinutes: 0,
  providerType: "NP",
  payerCategory: "non_medicare",
  isTelehealth: false,
};

describe("suggestCodes — base bands (vision §18.8 table)", () => {
  // New patient home
  it.each([
    [0, "99341"],
    [10, "99341"],
    [19, "99341"],
    [20, "99342"],
    [30, "99342"],
    [44, "99342"],
    [45, "99344"],
    [50, "99344"],
    [59, "99344"],
    [60, "99345"],
    [120, "99345"],
  ])("new_patient_home %d min → %s", (minutes, code) => {
    const r = suggestCodes({ ...baseInput, visitType: "new_patient_home", totalMinutes: minutes });
    expect(r.base[0]?.code).toBe(code);
  });

  // Established patient home
  it.each([
    [0, "99347"],
    [20, "99347"],
    [24, "99347"],
    [25, "99348"],
    [30, "99348"],
    [34, "99348"],
    [35, "99349"],
    [50, "99349"],
    [59, "99349"],
    [60, "99350"],
  ])("established_patient_home %d min → %s", (minutes, code) => {
    const r = suggestCodes({ ...baseInput, totalMinutes: minutes });
    expect(r.base[0]?.code).toBe(code);
  });

  it("flags `edge` when at top of band ±1 min", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 24 });
    expect(r.base[0]?.code).toBe("99347");
    expect(r.base[0]?.confidence).toBe("edge");
  });

  it("flags `confirmed` mid-band", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 30 });
    expect(r.base[0]?.confidence).toBe("confirmed");
  });

  it("returns no base for advance_care_planning visit type", () => {
    const r = suggestCodes({
      ...baseInput,
      visitType: "advance_care_planning",
      totalMinutes: 0,
    });
    expect(r.base).toEqual([]);
  });
});

describe("suggestCodes — prolonged service (G0318 / 99417)", () => {
  it("does NOT add prolonged when totalMinutes equals top of band", () => {
    // established top is 60 (99350) — exactly 60 = no overflow
    const r = suggestCodes({ ...baseInput, totalMinutes: 60 });
    expect(r.prolongedAddOns).toEqual([]);
  });

  it("adds 99417 (non-Medicare) past the 60-min top threshold", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: 75 });
    expect(r.prolongedAddOns[0]?.code).toBe("99417");
  });

  it("adds G0318 (Medicare) past the top threshold", () => {
    const r = suggestCodes({
      ...baseInput,
      totalMinutes: 75,
      payerCategory: "medicare",
    });
    expect(r.prolongedAddOns[0]?.code).toBe("G0318");
  });

  it("caps Medicare G0318 at 4 units even when time is huge", () => {
    const r = suggestCodes({
      ...baseInput,
      totalMinutes: 60 + 15 * 10, // 10 increments past cap
      payerCategory: "medicare",
    });
    expect(r.prolongedAddOns[0]?.reason).toContain("4 unit");
  });

  it("does NOT cap 99417 at 4 — non-Medicare bills as billed", () => {
    const r = suggestCodes({
      ...baseInput,
      totalMinutes: 60 + 15 * 6, // 6 increments past cap
      payerCategory: "non_medicare",
    });
    expect(r.prolongedAddOns[0]?.reason).toContain("6 unit");
  });

  it("adds prolonged for new_patient_home past 75-min threshold", () => {
    const r = suggestCodes({
      ...baseInput,
      visitType: "new_patient_home",
      totalMinutes: 90,
    });
    expect(r.prolongedAddOns[0]?.code).toBe("99417");
  });

  it("does NOT add prolonged for ACP-only visit", () => {
    const r = suggestCodes({
      ...baseInput,
      visitType: "advance_care_planning",
      totalMinutes: 100,
    });
    expect(r.prolongedAddOns).toEqual([]);
  });
});

describe("suggestCodes — ACP add-ons (99497 / 99498)", () => {
  it("emits no ACP code below 16 minutes", () => {
    const r = suggestCodes({ ...baseInput, acpMinutes: 15 });
    expect(r.acpAddOns).toEqual([]);
  });

  it("emits 99497 only between 16–45 ACP minutes", () => {
    const r = suggestCodes({ ...baseInput, acpMinutes: 30 });
    expect(r.acpAddOns).toHaveLength(1);
    expect(r.acpAddOns[0].code).toBe("99497");
  });

  it("emits 99497 + 99498 at 46+ ACP minutes", () => {
    const r = suggestCodes({ ...baseInput, acpMinutes: 60 });
    const codes = r.acpAddOns.map((c) => c.code);
    expect(codes).toEqual(["99497", "99498"]);
  });

  it("99498 unit count grows with extra ACP time", () => {
    const r = suggestCodes({ ...baseInput, acpMinutes: 90 });
    const second = r.acpAddOns.find((c) => c.code === "99498");
    expect(second?.reason).toContain("2");
  });

  it("base + ACP stack — both present in one visit", () => {
    const r = suggestCodes({
      ...baseInput,
      totalMinutes: 30,
      acpMinutes: 30,
    });
    expect(r.base[0]?.code).toBe("99348");
    expect(r.acpAddOns[0]?.code).toBe("99497");
  });
});

describe("suggestCodes — telehealth modifier", () => {
  it("emits modifier 95 when isTelehealth=true (default audio+video)", () => {
    const r = suggestCodes({ ...baseInput, isTelehealth: true });
    expect(r.modifiers.find((m) => m.modifier === "95")).toBeTruthy();
  });

  it("emits modifier 95 when modality explicitly audio_video", () => {
    const r = suggestCodes({
      ...baseInput,
      isTelehealth: true,
      telehealthModality: "audio_video",
    });
    expect(r.modifiers.find((m) => m.modifier === "95")).toBeTruthy();
  });

  it("emits modifier 93 when modality is audio_only", () => {
    const r = suggestCodes({
      ...baseInput,
      isTelehealth: true,
      telehealthModality: "audio_only",
    });
    expect(r.modifiers.find((m) => m.modifier === "93")).toBeTruthy();
    expect(r.modifiers.find((m) => m.modifier === "95")).toBeFalsy();
  });

  it("does NOT emit any telehealth modifier by default", () => {
    const r = suggestCodes({ ...baseInput });
    expect(r.modifiers).toEqual([]);
  });
});

describe("suggestCodes — degenerate inputs", () => {
  it("inconclusive=true when no base or ACP applies", () => {
    const r = suggestCodes({
      ...baseInput,
      visitType: "advance_care_planning",
      totalMinutes: 0,
      acpMinutes: 0,
    });
    expect(r.inconclusive).toBe(true);
  });

  it("negative totalMinutes returns no suggestion", () => {
    const r = suggestCodes({ ...baseInput, totalMinutes: -5 });
    expect(r.base).toEqual([]);
    expect(r.inconclusive).toBe(true);
  });
});
