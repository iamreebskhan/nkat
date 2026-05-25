/**
 * denial-feedback.service — Phase B nightly join of predicted_risk vs.
 * actual superbill_denial outcomes. Aggregates per reason_code into
 * the denial_rule_metrics table so the predictor can be tuned over
 * time, and so the UI can surface "this rule has X% precision."
 *
 * Algorithm (per reason_code):
 *   TP = predicted high/block AND a denial row exists for the superbill
 *   FP = predicted high/block AND no denial after N days (default 30)
 *   FN = predicted low/medium AND a denial came back
 * Precision = TP / (TP+FP), Recall = TP / (TP+FN).
 *
 * Idempotent — runs as a daily cron via scripts/nightly-denial-feedback.mjs
 * (workflow-dispatch fallback). UPSERT into denial_rule_metrics.
 *
 * No RLS — operates cross-tenant under the admin role (withBreakglass).
 * Aggregate counts are not PHI; per-reason precision is platform metadata.
 */
import { withBreakglass } from "@/lib/db";

interface LineLikePredictedRisk {
  perLine?: Array<{
    code?: string;
    riskBand?: "low" | "medium" | "high" | "block";
    reasons?: Array<{ code?: string }>;
  }>;
}

interface SuperbillRow {
  id: string;
  predicted_risk: LineLikePredictedRisk | null;
  created_at: Date;
  denied: boolean;
}

export interface FeedbackResult {
  reasonsUpdated: number;
  superbillsScanned: number;
  windowDays: number;
}

/**
 * Run the aggregator. Default window: only look at superbills created
 * more than `windowDays` ago — by then a denial would have come back
 * (or we trust the silence).
 */
export async function runDenialFeedback(opts: {
  windowDays?: number;
} = {}): Promise<FeedbackResult> {
  const windowDays = opts.windowDays ?? 30;
  return withBreakglass(async (client) => {
    // Pull every persisted superbill with a prediction in the
    // reportable window. Mark "denied" if any superbill_denial row
    // exists for it.
    const rows = await client.$queryRaw<SuperbillRow[]>`
      SELECT s.id, s.predicted_risk, s.created_at,
             EXISTS (
               SELECT 1 FROM superbill_denial d WHERE d.superbill_id = s.id
             ) AS denied
        FROM superbill s
       WHERE s.predicted_risk IS NOT NULL
         AND s.created_at <= NOW() - (${windowDays}::int * INTERVAL '1 day')
    `;

    // Tally per reason_code.
    const counters = new Map<
      string,
      { tp: number; fp: number; fn: number; samples: number }
    >();
    function bump(code: string, kind: "tp" | "fp" | "fn") {
      const c = counters.get(code) ?? { tp: 0, fp: 0, fn: 0, samples: 0 };
      c[kind] += 1;
      c.samples += 1;
      counters.set(code, c);
    }
    for (const row of rows) {
      const pl = row.predicted_risk?.perLine ?? [];
      // Unique set of reason codes that appeared anywhere in the
      // superbill, plus per-line band.
      for (const line of pl) {
        const band = line.riskBand;
        const reasons = line.reasons ?? [];
        const high = band === "high" || band === "block";
        const seenReasons = new Set<string>();
        for (const r of reasons) {
          if (r?.code) seenReasons.add(r.code);
        }
        // If no reasons but band still high (shouldn't happen but guard):
        if (seenReasons.size === 0 && high) {
          bump(band === "block" ? "block_no_reason" : "high_no_reason",
            row.denied ? "tp" : "fp");
        }
        for (const reasonCode of seenReasons) {
          if (high) bump(reasonCode, row.denied ? "tp" : "fp");
          else bump(reasonCode, row.denied ? "fn" : "fp"); // low/medium + denied = FN
        }
      }
    }

    // Upsert metrics. precision/recall NULL when denominator zero.
    let updated = 0;
    for (const [reasonCode, c] of counters) {
      const precision =
        c.tp + c.fp > 0 ? Math.round((c.tp / (c.tp + c.fp)) * 10_000) / 100 : null;
      const recall =
        c.tp + c.fn > 0 ? Math.round((c.tp / (c.tp + c.fn)) * 10_000) / 100 : null;
      await client.$executeRaw`
        INSERT INTO denial_rule_metrics (
          reason_code, true_positives, false_positives, false_negatives,
          precision_pct, recall_pct, sample_size, last_computed_at
        ) VALUES (
          ${reasonCode}, ${c.tp}, ${c.fp}, ${c.fn},
          ${precision}, ${recall}, ${c.samples}, NOW()
        )
        ON CONFLICT (reason_code) DO UPDATE SET
          true_positives = EXCLUDED.true_positives,
          false_positives = EXCLUDED.false_positives,
          false_negatives = EXCLUDED.false_negatives,
          precision_pct = EXCLUDED.precision_pct,
          recall_pct = EXCLUDED.recall_pct,
          sample_size = EXCLUDED.sample_size,
          last_computed_at = NOW()
      `;
      updated += 1;
    }

    return {
      reasonsUpdated: updated,
      superbillsScanned: rows.length,
      windowDays,
    };
  }, "nightly denial-feedback aggregator");
}
