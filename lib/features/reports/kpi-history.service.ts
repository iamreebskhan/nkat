/**
 * Monthly history (0125): reading a year of a practice's entered figures and
 * saving what changed. Counts and money only; the audit says how many and for
 * which months, never a figure.
 */
import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";

import {
  ACTUAL_MEASURES,
  PLAN_MEASURES,
  reasonMeasure,
  type KpiEntered,
  type KpiHistoryMeasure,
  type KpiReason,
} from "./kpi-history";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

/** The figures for the months a window touches; the plan is read on its own. */
export async function readEnteredMonths(tx: Tx, orgId: string, from: string, to: string): Promise<KpiEntered[]> {
  const rows = await tx.$queryRaw<{ month: string; measure: string; value: number }[]>`
    SELECT to_char(month, 'YYYY-MM') AS month, measure, value::float8 AS value
      FROM org_kpi_month
     WHERE org_id = ${orgId}::uuid
       AND measure NOT LIKE 'plan:%'
       AND month BETWEEN date_trunc('month', ${from}::date)::date AND ${to}::date
  `;
  return rows.map((r) => ({ month: r.month, measure: r.measure, value: Number(r.value) }));
}

/** The plan figures, whenever entered: one carries forward until the next. */
export async function readPlanMonths(tx: Tx, orgId: string): Promise<KpiEntered[]> {
  const rows = await tx.$queryRaw<{ month: string; measure: string; value: number }[]>`
    SELECT to_char(month, 'YYYY-MM') AS month, measure, value::float8 AS value
      FROM org_kpi_month
     WHERE org_id = ${orgId}::uuid AND measure LIKE 'plan:%'
  `;
  return rows.map((r) => ({ month: r.month, measure: r.measure, value: Number(r.value) }));
}

export async function readReasons(tx: Tx, orgId: string): Promise<KpiReason[]> {
  return tx.$queryRaw<KpiReason[]>`
    SELECT kind, code, label, category
      FROM org_reason_code
     WHERE org_id = ${orgId}::uuid
     ORDER BY kind, sort_order, code
  `;
}

export interface KpiHistoryGroup {
  title: string;
  /** Plan rows may be set ahead; actuals only up to the month under way. */
  ahead: boolean;
  measures: KpiHistoryMeasure[];
}

export interface KpiHistoryYear {
  year: number;
  /** The practice's month, 'YYYY-MM'. */
  thisMonth: string;
  groups: KpiHistoryGroup[];
  /** measure → month → the figure as typed. */
  values: Record<string, Record<string, number>>;
}

function historyGroups(reasons: KpiReason[]): KpiHistoryGroup[] {
  const byKind = (kind: KpiReason["kind"]): KpiHistoryMeasure[] =>
    reasons.filter((r) => r.kind === kind).map((r) => ({ key: reasonMeasure(r), label: `${r.code} ${r.label}`, unit: "count" }));
  return [
    { title: "Plan", ahead: true, measures: PLAN_MEASURES },
    { title: "Actuals", ahead: false, measures: ACTUAL_MEASURES },
    { title: "Discharges, by reason", ahead: false, measures: byKind("discharge") },
    { title: "Not taken under care, by reason", ahead: false, measures: byKind("ntuc") },
  ];
}

export async function getKpiHistoryYear(args: { orgId: string; year?: number; now?: Date }): Promise<KpiHistoryYear> {
  return withOrgContext(args.orgId, async (tx) => {
    const thisMonth = orgToday(await readOrgTimeZone(tx, args.orgId), args.now).slice(0, 7);
    const year = args.year ?? Number(thisMonth.slice(0, 4));
    const rows = await tx.$queryRaw<{ month: string; measure: string; value: number }[]>`
      SELECT to_char(month, 'YYYY-MM') AS month, measure, value::float8 AS value
        FROM org_kpi_month
       WHERE org_id = ${args.orgId}::uuid
         AND month BETWEEN make_date(${year}::int, 1, 1) AND make_date(${year}::int, 12, 1)
    `;
    const values: KpiHistoryYear["values"] = {};
    for (const r of rows) (values[r.measure] ??= {})[r.month] = Number(r.value);
    return { year, thisMonth, groups: historyGroups(await readReasons(tx, args.orgId)), values };
  });
}

export async function saveKpiHistory(args: {
  orgId: string;
  userId: string;
  changes: { month: string; measure: string; value: number | null }[];
  now?: Date;
}): Promise<{ entered: number; cleared: number }> {
  return withOrgContext(args.orgId, async (tx) => {
    const thisMonth = orgToday(await readOrgTimeZone(tx, args.orgId), args.now).slice(0, 7);
    const groups = historyGroups(await readReasons(tx, args.orgId));
    const measure = new Map(groups.flatMap((g) => g.measures.map((m): [string, { group: KpiHistoryGroup; m: KpiHistoryMeasure }] => [m.key, { group: g, m }])));
    for (const c of args.changes) {
      const known = measure.get(c.measure);
      if (!known) throw new ValidationError(`${c.measure} is not a figure Pallio keeps.`);
      if (!known.group.ahead && c.month > thisMonth) throw new ValidationError(`${known.m.label} for ${c.month} is still ahead.`);
      if (c.value !== null && known.m.unit === "count" && !Number.isInteger(c.value)) {
        throw new ValidationError(`${known.m.label} for ${c.month} is a whole number.`);
      }
    }
    const set = args.changes.filter((c) => c.value !== null);
    const clear = args.changes.filter((c) => c.value === null);
    if (set.length > 0) {
      await tx.$executeRaw`
        INSERT INTO org_kpi_month (org_id, month, measure, value, updated_by_user_id)
        SELECT ${args.orgId}::uuid, (t.month || '-01')::date, t.measure, t.value::numeric, ${args.userId}::uuid
          FROM unnest(${set.map((c) => c.month)}::text[], ${set.map((c) => c.measure)}::text[], ${set.map((c) => String(c.value))}::text[])
               AS t(month, measure, value)
        ON CONFLICT (org_id, month, measure)
        DO UPDATE SET value = EXCLUDED.value, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
      `;
    }
    if (clear.length > 0) {
      await tx.$executeRaw`
        DELETE FROM org_kpi_month k
         USING unnest(${clear.map((c) => c.month)}::text[], ${clear.map((c) => c.measure)}::text[]) AS t(month, measure)
         WHERE k.org_id = ${args.orgId}::uuid AND k.month = (t.month || '-01')::date AND k.measure = t.measure
      `;
    }
    const months = args.changes.map((c) => c.month).sort();
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "kpi_history_change", targetType: "kpi_history", targetId: null,
      payload: { entered: set.length, cleared: clear.length, from: months[0], to: months.at(-1) },
    });
    return { entered: set.length, cleared: clear.length };
  });
}
