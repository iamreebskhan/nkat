/**
 * Platform settings — read/upsert system_setting + read rate_limit_override.
 *
 * platform_admin only. Keys live in a fixed catalog, and BOTH the key and the
 * value are now checked against it.
 *
 * They were not. The catalog was a display list and nothing else: the upsert
 * took any key and any JSON, so `lookup.daily_quotas` — one letter wrong —
 * saved happily, did nothing, and could never be seen again, because the page
 * renders the catalog and a key outside it has no row to appear in. The
 * operator gets a success toast for a setting that does not exist. Likewise
 * `embeddings.dimension` would accept the string "banana" and wait to be
 * discovered by whatever reads it next.
 */
import { ValidationError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { invalidateSettingCache } from "@/lib/features/admin/runtime-settings";

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

/**
 * What each key is allowed to hold. `check` returns null when the value is
 * acceptable, or the sentence the operator should read when it is not.
 *
 * Deliberately narrow. Every one of these is read by something that will not
 * complain: an hour outside 0–23 means the cron simply never fires, and a
 * wrong embedding dimension means vectors that no longer compare. Both fail
 * silently later rather than loudly here, which is the argument for checking
 * here.
 */
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Who actually controls a key.
 *
 * All six used to look alike on the page — six rows, six Edit buttons, one
 * implication: change this and something happens. Nothing happened for any of
 * them, and the reasons are not the same reason:
 *
 *   app             read at runtime from this table; editing it works
 *   infrastructure  the real value is an EventBridge rule or a crontab line
 *   schema          fixed by a column type; not a choice anyone gets to make
 *   unbuilt         describes a feature that does not exist yet
 *
 * Only "app" keys are settable. The rest stay listed, because deleting them
 * would leave an operator asking "where DO I change the backup hour?" with
 * nowhere to look — the page now answers that.
 */
export type SettingOwner = "app" | "infrastructure" | "schema" | "unbuilt";

export const KNOWN_SETTINGS: {
  key: string;
  description: string;
  ownedBy: SettingOwner;
  /** Where the value really lives, for the keys this table cannot change. */
  livesAt?: string;
  check: (v: unknown) => string | null;
}[] = [
  {
    key: "ai.synthesizer_model",
    description: "Pinned Claude model for rule synthesis.",
    ownedBy: "app",
    check: (v) => (typeof v === "string" && /^claude-[a-z0-9.-]+$/.test(v) ? null : 'Expected a Claude model id, e.g. "claude-sonnet-4-6".'),
  },
  {
    key: "ai.parser_model",
    description: "Pinned Claude model for query parsing.",
    ownedBy: "app",
    check: (v) => (typeof v === "string" && /^claude-[a-z0-9.-]+$/.test(v) ? null : 'Expected a Claude model id, e.g. "claude-haiku-4-5".'),
  },
  {
    key: "lookup.daily_quota",
    description: "Default daily lookup quota per org.",
    // There is no quota enforcement in this codebase — not a counter, not a
    // check, not a column. The key describes a feature, not a setting for
    // one. Wiring it means building quota enforcement first.
    ownedBy: "unbuilt",
    livesAt: "per-org lookup quotas are not implemented",
    check: (v) => (isInt(v) && v > 0 && v <= 1_000_000 ? null : "Expected a whole number of lookups, 1–1000000."),
  },
  {
    key: "embeddings.dimension",
    description: "OpenAI text-embedding-3-large slice.",
    // The column is vector(1024). A different number here resizes nothing; it
    // writes vectors that cannot be compared against everything already
    // stored. That makes this a fact about the schema, not a preference.
    ownedBy: "schema",
    livesAt: "1024, set by the vector(1024) columns; changing it needs a migration",
    check: (v) => (isInt(v) && v === 1024 ? null : "Must be 1024 — the embedding column is vector(1024)."),
  },
  {
    key: "cron.alert_hour_utc",
    description: "Hour-of-day UTC for the payer-rule alert digest cron.",
    ownedBy: "infrastructure",
    livesAt: "infra/terraform/scheduled-tasks.tf (EventBridge schedule_expression)",
    check: (v) => (isInt(v) && v >= 0 && v <= 23 ? null : "Expected an hour 0–23 (UTC)."),
  },
  {
    key: "cron.backup_hour_utc",
    description: "Hour-of-day UTC for the nightly logical dump.",
    ownedBy: "infrastructure",
    livesAt: "the deploy host's crontab — see scripts/nightly-backup.sh",
    check: (v) => (isInt(v) && v >= 0 && v <= 23 ? null : "Expected an hour 0–23 (UTC)."),
  },
];

/**
 * Keys written by the database rather than by a person — migration 0021's
 * trigger bumps synthesis_cache.version on every payer_rule insert. They are
 * not settable here, but they ARE shown, because a row that exists and cannot
 * be seen is how "1 configured" ended up printed above six rows that all read
 * "(not set)".
 */
export const SYSTEM_MANAGED_KEYS = new Set(["synthesis_cache.version"]);

/**
 * Return a catalog key to "(not set)".
 *
 * There was no way to do this. Once a key had a value the only move was to
 * give it a different one, so a setting written by mistake stayed written —
 * which is how four probe rows had to be cleaned up by a migration instead of
 * by the operator who made them. "Set it back to the default" is not
 * available either, because the default lives in code and the page has no
 * idea what it is.
 *
 * Refuses the same two cases the upsert refuses, for the same reasons: an
 * unknown key was never settable here, and a database-owned key would be
 * rewritten by the next payer_rule insert anyway.
 */
export async function unsetSetting(key: string): Promise<{ removed: boolean }> {
  if (SYSTEM_MANAGED_KEYS.has(key)) {
    throw new ValidationError(
      `"${key}" is maintained by the database. Deleting the row would not ` +
        `clear it — the next payer_rule insert writes it straight back.`,
    );
  }
  if (!KNOWN_SETTINGS.some((k) => k.key === key)) {
    throw new ValidationError(
      `Unknown setting "${key}". Known keys: ${KNOWN_SETTINGS.map((k) => k.key).join(", ")}.`,
    );
  }
  const n = await prisma.$executeRaw`DELETE FROM system_setting WHERE key = ${key}`;
  invalidateSettingCache(key);
  return { removed: n > 0 };
}

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
  const known = KNOWN_SETTINGS.find((k) => k.key === args.key);
  if (!known) {
    if (SYSTEM_MANAGED_KEYS.has(args.key)) {
      throw new ValidationError(
        `"${args.key}" is maintained by the database, not by hand. ` +
          `Changing it here would be overwritten by the next payer_rule insert.`,
      );
    }
    throw new ValidationError(
      `Unknown setting "${args.key}". Nothing reads a key that is not in the ` +
        `catalog, so saving it would look like it worked and change nothing. ` +
        `Known keys: ${KNOWN_SETTINGS.map((k) => k.key).join(", ")}.`,
    );
  }
  if (known.ownedBy !== "app") {
    // Refusing is the honest answer. Storing it would succeed, show a value
    // on the page, and change nothing about the system — which is the exact
    // failure this catalog had for its whole existence.
    throw new ValidationError(
      `"${args.key}" is not settable here — ${known.livesAt}.`,
    );
  }
  const bad = known.check(args.value);
  if (bad) throw new ValidationError(`${args.key}: ${bad}`);

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
  // The runtime reader caches for a minute; without this an operator changes
  // the synthesis model, sees the new value on the page, and watches the old
  // one keep answering.
  invalidateSettingCache(r.key);
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
