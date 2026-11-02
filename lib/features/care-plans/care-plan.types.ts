/**
 * The formal care plan's structured parts (0116; Level-1 doc:38, :50-51, :55):
 * goals, interventions and who is responsible, what is monitored and how
 * often, the NP's escalation parameters, and when the plan is next reviewed.
 * Pure constants, Zod schemas and the escalation check itself, safe to import
 * from client components.
 */
import { z } from "zod";

import { isCalendarDay } from "@/lib/features/org/org-date";

/** Who does it: an intervention's responsible discipline, a task's. */
export const DISCIPLINES = ["np", "nursing", "social_work", "chaplaincy", "admin", "other"] as const;
export type Discipline = (typeof DISCIPLINES)[number];
export const DISCIPLINE_LABEL: Record<Discipline, string> = {
  np: "NP",
  nursing: "Nursing",
  social_work: "Social work",
  chaplaincy: "Chaplaincy",
  admin: "Administration",
  other: "Other",
};

export const MONITORING_HOW = ["phone", "visit", "any"] as const;
export type MonitoringHow = (typeof MONITORING_HOW)[number];
export const MONITORING_HOW_LABEL: Record<MonitoringHow, string> = {
  phone: "by phone",
  visit: "at a visit",
  any: "by phone or at a visit",
};

// ---------------------------------------------------------------------------
// Escalation parameters (doc:55): a measure and the NP's limit
// ---------------------------------------------------------------------------

export const ESCALATION_MEASURES = ["pain", "dyspnea", "nausea", "pps", "spo2", "fall", "ed_visit", "hospital_admission"] as const;
export type EscalationMeasure = (typeof ESCALATION_MEASURES)[number];

interface MeasureInfo {
  label: string;
  /** at_least: a reading at or above the limit; at_most: at or below; any: whenever it happens. */
  crosses: "at_least" | "at_most" | "any";
  min?: number;
  max?: number;
  unit?: string;
}

export const ESCALATION_MEASURE_INFO: Record<EscalationMeasure, MeasureInfo> = {
  pain: { label: "Pain", crosses: "at_least", min: 1, max: 10, unit: "/10" },
  dyspnea: { label: "Shortness of breath", crosses: "at_least", min: 1, max: 10, unit: "/10" },
  nausea: { label: "Nausea", crosses: "at_least", min: 1, max: 10, unit: "/10" },
  pps: { label: "PPS", crosses: "at_most", min: 0, max: 100, unit: "%" },
  spo2: { label: "SpO₂", crosses: "at_most", min: 50, max: 100, unit: "%" },
  fall: { label: "A fall", crosses: "any" },
  ed_visit: { label: "An ED visit", crosses: "any" },
  hospital_admission: { label: "A hospital admission", crosses: "any" },
};

/** "Pain at or above 7/10", "A fall". */
export function escalationRuleText(r: { measure: EscalationMeasure; threshold: number | null }): string {
  const m = ESCALATION_MEASURE_INFO[r.measure];
  if (m.crosses === "any") return m.label;
  return `${m.label} ${m.crosses === "at_least" ? "at or above" : "at or below"} ${r.threshold}${m.unit ?? ""}`;
}

export const EscalationRuleSchema = z
  .object({ measure: z.enum(ESCALATION_MEASURES), threshold: z.number().nullable() })
  .strict()
  .superRefine((r, ctx) => {
    const m = ESCALATION_MEASURE_INFO[r.measure];
    if (m.crosses === "any") {
      if (r.threshold !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${m.label} has no limit.`, path: ["threshold"] });
      return;
    }
    if (r.threshold === null || !Number.isInteger(r.threshold) || r.threshold < m.min! || r.threshold > m.max!) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${m.label}: a whole number from ${m.min} to ${m.max}.`,
        path: ["threshold"],
      });
    }
  });
export type EscalationRule = z.infer<typeof EscalationRuleSchema>;

/** What a reading carries that a rule can test. */
export type EscalationReadings = Partial<Record<"pain" | "dyspnea" | "nausea" | "pps" | "spo2", number | null>>;

/**
 * The rules these readings cross. Rules come from the stored plan: anything
 * that does not parse is skipped rather than allowed to break the save that
 * asked.
 */
export function crossedRules(rules: unknown, readings: EscalationReadings): { measure: EscalationMeasure; value: number; threshold: number }[] {
  const out: { measure: EscalationMeasure; value: number; threshold: number }[] = [];
  for (const raw of Array.isArray(rules) ? rules : []) {
    const p = EscalationRuleSchema.safeParse(raw);
    if (!p.success || p.data.threshold === null) continue;
    const { measure, threshold } = p.data;
    const value = readings[measure as keyof EscalationReadings];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const crosses = ESCALATION_MEASURE_INFO[measure].crosses;
    if ((crosses === "at_least" && value >= threshold) || (crosses === "at_most" && value <= threshold)) {
      out.push({ measure, value, threshold });
    }
  }
  return out;
}

/** Whether the plan asks to hear of this event (a fall, an ED visit, an admission). */
export function eventRuleFor(rules: unknown, kind: string): EscalationMeasure | null {
  for (const raw of Array.isArray(rules) ? rules : []) {
    const p = EscalationRuleSchema.safeParse(raw);
    if (p.success && p.data.measure === kind && ESCALATION_MEASURE_INFO[p.data.measure].crosses === "any") {
      return p.data.measure;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The plan's lists
// ---------------------------------------------------------------------------

export const InterventionSchema = z
  .object({ item: z.string().trim().min(1, "Say what").max(200), by: z.enum(DISCIPLINES).nullable() })
  .strict();
export type Intervention = z.infer<typeof InterventionSchema>;

export const MonitoringItemSchema = z
  .object({
    item: z.string().trim().min(1, "Say what").max(160),
    /** How often, in days; none for "as needed". */
    everyDays: z.number().int().min(1).max(365).nullable(),
    how: z.enum(MONITORING_HOW),
  })
  .strict();
export type MonitoringItem = z.infer<typeof MonitoringItemSchema>;

const unique = <T>(key: (x: T) => string, what: string) => (list: T[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  for (const x of list) {
    const k = key(x).toLowerCase();
    if (seen.has(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${what} is on the list twice.` });
    seen.add(k);
  }
};

/** The structured parts as a PUT carries them: each absent part is kept. */
export const CarePlanStructureSchema = z.object({
  goals: z.array(z.string().trim().min(1).max(200)).max(30).superRefine(unique((g) => g, "A goal")).optional(),
  interventions: z.array(InterventionSchema).max(40).superRefine(unique((i) => i.item, "An intervention")).optional(),
  monitoring: z.array(MonitoringItemSchema).max(30).superRefine(unique((m) => m.item, "A monitored item")).optional(),
  escalation: z
    .array(EscalationRuleSchema)
    .max(ESCALATION_MEASURES.length)
    .superRefine(unique((r) => r.measure, "A measure"))
    .optional(),
  /** When the plan is next reviewed; null clears it. */
  reviewOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .refine(isCalendarDay, "Not a calendar day.")
    .nullable()
    .optional(),
});
export type CarePlanStructure = z.infer<typeof CarePlanStructureSchema>;

/** A monitored item is due when its interval has run out since the last contact that counts. */
export function monitoringDue(
  m: Pick<MonitoringItem, "everyDays" | "how">,
  last: { phone: string | null; visit: string | null; since: string | null },
  today: string,
): { lastOn: string | null; dueOn: string | null; overdue: boolean } {
  const candidates = m.how === "phone" ? [last.phone] : m.how === "visit" ? [last.visit] : [last.phone, last.visit];
  const lastOn = candidates.filter((d): d is string => !!d).sort().at(-1) ?? null;
  if (m.everyDays === null) return { lastOn, dueOn: null, overdue: false };
  // Counted from the last contact, or from when care began when there has been none.
  const from = lastOn ?? last.since;
  if (!from) return { lastOn, dueOn: null, overdue: false };
  const due = new Date(Date.parse(`${from}T00:00:00Z`) + m.everyDays * 86_400_000).toISOString().slice(0, 10);
  return { lastOn, dueOn: due, overdue: due < today };
}
