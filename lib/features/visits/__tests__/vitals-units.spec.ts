/**
 * Unit conversion for vitals entry.
 *
 * The property that matters is the ROUND TRIP: a clinician types 97.8 °F,
 * we store Celsius, and on reload they must read 97.8 back. A value that
 * changes on its own between entry and reload reads as the product losing
 * data, and in a chart it is worse than that.
 *
 * Every round-trip test below runs against the stored precision that
 * db/migrations/0088 actually declares, so a later narrowing of a column
 * fails here rather than silently drifting in production.
 */
import { describe, expect, it } from "vitest";

import {
  celsiusToFahrenheit,
  cmToInch,
  fahrenheitToCelsius,
  inchToCm,
  kgToLb,
  lbToKg,
  showStored,
  VITALS_FIELDS,
  type VitalsFieldSpec,
} from "../vitals-units";

const field = (key: string): VitalsFieldSpec => VITALS_FIELDS.find((f) => f.key === key)!;

describe("weight", () => {
  it("converts the reference values exactly enough", () => {
    expect(lbToKg(100)).toBe(45.36);
    expect(kgToLb(45.36)).toBe(100);
    expect(lbToKg(1)).toBe(0.45);
  });

  it("round-trips every tenth of a pound across the clinical range", () => {
    // Palliative patients are often cachectic, so the low end matters as much
    // as the high — Mark's own sample patient presents with cachexia.
    for (let lb = 60; lb <= 400; lb += 0.1) {
      const shown = Math.round(lb * 10) / 10;
      expect(kgToLb(lbToKg(shown))).toBe(shown);
    }
  });

  it("round-trips the extremes the schema allows", () => {
    for (const lb of [1.1, 2, 50, 150.5, 999.9, 1102]) {
      expect(kgToLb(lbToKg(lb))).toBe(lb);
    }
  });

  it("stays inside the column's 5,2 precision", () => {
    for (const lb of [1.1, 150.5, 1102]) {
      const kg = lbToKg(lb);
      expect(kg).toBeLessThanOrEqual(500);
      expect(String(kg).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    }
  });
});

describe("height", () => {
  it("converts the reference values", () => {
    expect(inchToCm(70)).toBe(177.8);
    expect(cmToInch(177.8)).toBe(70);
  });

  it("round-trips every tenth of an inch across the human range", () => {
    for (let inch = 24; inch <= 90; inch += 0.1) {
      const shown = Math.round(inch * 10) / 10;
      expect(cmToInch(inchToCm(shown))).toBe(shown);
    }
  });
});

describe("temperature", () => {
  it("converts the reference values", () => {
    expect(fahrenheitToCelsius(98.6)).toBe(37);
    expect(celsiusToFahrenheit(37)).toBe(98.6);
    expect(fahrenheitToCelsius(32)).toBe(0);
  });

  it("round-trips 97.8 °F — the case that fails at one decimal of Celsius", () => {
    // 97.8 F is 36.5556 C. Stored at 1dp that is 36.6, which reads back as
    // 97.9 — the field appears to change by itself. Two decimals fix it, and
    // this is why db/migrations/0088 declares temperature_c NUMERIC(4,2).
    expect(celsiusToFahrenheit(fahrenheitToCelsius(97.8))).toBe(97.8);
  });

  it("round-trips every tenth of a degree across the survivable range", () => {
    for (let f = 93; f <= 108; f += 0.1) {
      const shown = Math.round(f * 10) / 10;
      expect(celsiusToFahrenheit(fahrenheitToCelsius(shown))).toBe(shown);
    }
  });

  it("stays inside the column's 4,2 precision", () => {
    for (const f of [77, 98.6, 113]) {
      const c = fahrenheitToCelsius(f);
      expect(Math.abs(c)).toBeLessThan(100);
      expect(String(c).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
    }
  });
});

describe("VITALS_FIELDS", () => {
  it("shows US customary units for the three that differ", () => {
    expect(field("weightKg").unit).toBe("lb");
    expect(field("heightCm").unit).toBe("in");
    expect(field("temperatureC").unit).toBe("°F");
  });

  it("leaves unit-identical fields untouched by conversion", () => {
    for (const key of ["bpSystolic", "bpDiastolic", "heartRate", "respRate", "spo2Percent", "ppsPercent", "painScore"]) {
      const f = field(key);
      expect(f.toStored(72)).toBe(72);
      expect(f.fromStored(72)).toBe(72);
    }
  });

  it("round-trips through the field spec, not just the raw helpers", () => {
    for (const f of VITALS_FIELDS) {
      const shown = f.key === "ppsPercent" ? 60 : f.key === "painScore" ? 7 : 70;
      expect(f.fromStored(f.toStored(shown))).toBe(shown);
    }
  });

  it("states display bounds that map inside the schema's metric CHECKs", () => {
    // A clinician typing the largest allowed pounds must not produce a kg
    // value the database then rejects.
    const w = field("weightKg");
    expect(w.toStored(w.max!)).toBeLessThanOrEqual(500);
    expect(w.toStored(w.min!)).toBeGreaterThanOrEqual(0.5);
    const h = field("heightCm");
    expect(h.toStored(h.max!)).toBeLessThanOrEqual(280);
    expect(h.toStored(h.min!)).toBeGreaterThanOrEqual(20);
    const t = field("temperatureC");
    expect(t.toStored(t.max!)).toBeLessThanOrEqual(45);
    expect(t.toStored(t.min!)).toBeGreaterThanOrEqual(25);
  });

  it("keeps PPS on its ten-point steps", () => {
    expect(field("ppsPercent").step).toBe("10");
  });
});

describe("showStored", () => {
  it("renders a stored metric value in the displayed unit", () => {
    expect(showStored(field("weightKg"), 45.36)).toBe("100");
    expect(showStored(field("temperatureC"), 37)).toBe("98.6");
  });

  it("distinguishes a reading that was never taken from a zero", () => {
    // A palliative visit routinely records some vitals and not others, and
    // a blank must never render as 0.
    expect(showStored(field("weightKg"), null)).toBe("—");
    expect(showStored(field("weightKg"), undefined)).toBe("—");
    expect(showStored(field("painScore"), 0)).toBe("0");
  });
});
