/**
 * US customary units for vitals entry and display.
 *
 * visit_vitals stores metric — that is deliberate and stays. Metric is the
 * unambiguous canonical form, it is what the trend arithmetic and the CHECK
 * constraints are written against, and it is what an interchange format would
 * expect. But nobody enters it.
 *
 * Mark is a US palliative-care NP and the market he describes is the US home
 * care industry ("the entire home care industry in the U.S. is centralizing
 * around palliative", 14:20). A US nurse practitioner at a bedside weighs a
 * patient in pounds and takes a temperature in Fahrenheit. Asking them to
 * convert in their head is how you get a 68 kg patient recorded as 68 lb.
 *
 * So: metric in the database, US customary at the edge. This module is the
 * edge, and it is pure so the conversions are testable on their own.
 *
 * NOTE on what the Perfect Note does and does not say: its vitals line is
 * "BP 106/62. HR 62. RR 16." — no weight and no temperature, so it states no
 * units at all. This is not "the PDF says pounds". It is the ordinary practice
 * of the clinicians the product is for.
 */

/** Exact by definition (international avoirdupois pound, 1959). */
export const KG_PER_LB = 0.45359237;
/** Exact by definition (international inch, 1959). */
export const CM_PER_IN = 2.54;

const round = (value: number, dp: number): number => {
  const f = 10 ** dp;
  // Nudge before rounding so a value the float representation puts a hair
  // under .5 (68.265 stored as 68.26499999...) still rounds up, which is what
  // a clinician reading the number expects.
  return Math.round((value + Number.EPSILON * Math.abs(value)) * f) / f;
};

/**
 * Stored precision, matching db/migrations/0088 exactly. Conversions round to
 * these before persisting, so what comes back is what the database will hold
 * and the field does not appear to change value on reload.
 */
export const STORED_DP = { kg: 2, cm: 1, celsius: 2 } as const;
/** Entry precision — what the clinician types and reads back. */
export const DISPLAY_DP = { lb: 1, inch: 1, fahrenheit: 1 } as const;

export const lbToKg = (lb: number): number => round(lb * KG_PER_LB, STORED_DP.kg);
export const kgToLb = (kg: number): number => round(kg / KG_PER_LB, DISPLAY_DP.lb);

export const inchToCm = (inch: number): number => round(inch * CM_PER_IN, STORED_DP.cm);
export const cmToInch = (cm: number): number => round(cm / CM_PER_IN, DISPLAY_DP.inch);

export const fahrenheitToCelsius = (f: number): number =>
  round(((f - 32) * 5) / 9, STORED_DP.celsius);
export const celsiusToFahrenheit = (c: number): number =>
  round((c * 9) / 5 + 32, DISPLAY_DP.fahrenheit);

/**
 * A vitals field as the form renders it: what the clinician sees, and how to
 * move between that and the stored metric value.
 *
 * `toStored`/`fromStored` are identity for fields whose unit is the same in
 * both systems (blood pressure, heart rate, respiratory rate, SpO2, PPS,
 * pain). Keeping them in the same table means the form has one code path.
 */
export interface VitalsFieldSpec {
  /** Key on the stored (metric) vitals object. */
  key: string;
  label: string;
  /** Unit shown to the clinician. */
  unit?: string;
  /** Input step for the displayed unit. */
  step?: string;
  /** Displayed value -> value to persist. */
  toStored: (shown: number) => number;
  /** Stored value -> value to show. */
  fromStored: (stored: number) => number;
  /** Sanity bounds in the DISPLAYED unit, mirroring the DB CHECK constraints. */
  min?: number;
  max?: number;
}

const identity = (n: number) => n;

export const VITALS_FIELDS: VitalsFieldSpec[] = [
  {
    key: "weightKg", label: "Weight", unit: "lb", step: "0.1",
    toStored: lbToKg, fromStored: kgToLb,
    // 0.5-500 kg in the schema.
    min: 1.1, max: 1102,
  },
  {
    key: "heightCm", label: "Height", unit: "in", step: "0.1",
    toStored: inchToCm, fromStored: cmToInch,
    // 20-280 cm in the schema.
    min: 7.9, max: 110.2,
  },
  { key: "bpSystolic", label: "BP systolic", unit: "mmHg", toStored: identity, fromStored: identity, min: 40, max: 300 },
  { key: "bpDiastolic", label: "BP diastolic", unit: "mmHg", toStored: identity, fromStored: identity, min: 20, max: 200 },
  { key: "heartRate", label: "Heart rate", unit: "bpm", toStored: identity, fromStored: identity, min: 20, max: 250 },
  { key: "respRate", label: "Resp. rate", unit: "/min", toStored: identity, fromStored: identity, min: 4, max: 80 },
  {
    key: "temperatureC", label: "Temperature", unit: "°F", step: "0.1",
    toStored: fahrenheitToCelsius, fromStored: celsiusToFahrenheit,
    // 25-45 C in the schema.
    min: 77, max: 113,
  },
  { key: "spo2Percent", label: "SpO₂", unit: "%", toStored: identity, fromStored: identity, min: 30, max: 100 },
  {
    key: "ppsPercent", label: "PPS", unit: "%", step: "10",
    toStored: identity, fromStored: identity, min: 0, max: 100,
  },
  { key: "painScore", label: "Pain", unit: "/10", toStored: identity, fromStored: identity, min: 0, max: 10 },
];

/** Format a stored metric value for display, or "—" when it was never taken. */
export function showStored(spec: VitalsFieldSpec, stored: number | null | undefined): string {
  if (stored === null || stored === undefined) return "—";
  return String(spec.fromStored(stored));
}
