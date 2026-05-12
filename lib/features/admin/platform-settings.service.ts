/**
 * Platform settings — read/upsert system_setting + read rate_limit_override.
 *
 * platform_admin only. Keys live in a fixed catalog; the value JSONB
 * shape is open per key.
 */
import { prisma } from "@/lib/db";

export interface SystemSettingView {
  key: string;
  value: unknown;
  note: string | null;
  updatedAt: string;
}

export interface RateLimitOverrideView {
  orgId: string;
  scope: string;
  limit: number;
  refillPerSec: number;
  reason: string | null;
  expiresAt: string | null;
}

export const KNOWN_SETTINGS = [
  { key: "lookup.daily_quota", description: "Default daily lookup quota per org." },
  { key: "ai.synthesizer_model", description: "Pinned Claude model for rule synthesis." },
  { key: "ai.parser_model", description: "Pinned Claude model for query parsing." },
  { key: "embeddings.dimension", description: "OpenAI text-embedding-3-large slice (1024)." },
  { key: "cron.alert_hour_utc", description: "Hour-of-day UTC for the payer-rule alert digest cron." },
  { key: "cron.backup_hour_utc", description: "Hour-of-day UTC for the nightly logical dump." },
];

export async function listSettings(): Promise<SystemSettingView[]> {
  const rows = await prisma.$queryRaw<
    {
      key: string;
      value: unknown;
      note: string | null;
      updated_at: Date;
    }[]
  >`
    SELECT key, value, note, updated_at FROM system_setting ORDER BY key ASC
  `;
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    note: r.note,
    updatedAt: r.updated_at.toISOString(),
  }));
}

export async function upsertSetting(args: {
  key: string;
  value: unknown;
  note: string | null;
  byUserId: string;
}): Promise<SystemSettingView> {
  const rows = await prisma.$queryRaw<
    { key: string; value: unknown; note: string | null; updated_at: Date }[]
  >`
    INSERT INTO system_setting (key, value, note, updated_by_user_id)
    VALUES (${args.key}, ${JSON.stringify(args.value)}::jsonb, ${args.note}, ${args.byUserId}::uuid)
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      note = EXCLUDED.note,
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = now()
    RETURNING key, value, note, updated_at
  `;
  const r = rows[0]!;
  return { key: r.key, value: r.value, note: r.note, updatedAt: r.updated_at.toISOString() };
}

export async function listRateLimitOverrides(): Promise<RateLimitOverrideView[]> {
  const rows = await prisma.$queryRaw<
    {
      org_id: string;
      scope: string;
      limit: number;
      refill_per_sec: string;
      reason: string | null;
      expires_at: Date | null;
    }[]
  >`
    SELECT org_id, scope, "limit", refill_per_sec, reason, expires_at
    FROM rate_limit_override
    ORDER BY org_id, scope
  `;
  return rows.map((r) => ({
    orgId: r.org_id,
    scope: r.scope,
    limit: r.limit,
    refillPerSec: Number(r.refill_per_sec),
    reason: r.reason,
    expiresAt: r.expires_at?.toISOString() ?? null,
  }));
}
