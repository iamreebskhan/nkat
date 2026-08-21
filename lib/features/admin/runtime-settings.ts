/**
 * Read a platform setting at runtime, with the code constant as the fallback.
 *
 * The settings page offered six keys and nothing read any of them: setting
 * lookup.daily_quota changed no quota, and pinning ai.synthesizer_model
 * pinned nothing. A configuration screen that stores values nobody consults
 * is worse than no screen — it invites an operator to believe they have
 * changed something.
 *
 * Only the keys marked `ownedBy: "app"` in KNOWN_SETTINGS are read here. The
 * others cannot be made to work from this table and now say so on the page
 * instead of pretending: two are owned by infrastructure (an EventBridge rule
 * and the deploy host's crontab), one is fixed by a column type, and one
 * describes a feature nobody has built.
 *
 * CACHED, because these are read on the request path — the model pins are
 * consulted on every rule lookup. A stale read for up to a minute is the
 * right trade: the alternative is a database round trip in front of every
 * Claude call to answer a question whose answer changes a few times a year.
 */
import { prisma } from "@/lib/db";

const TTL_MS = 60_000;

interface Entry {
  value: unknown;
  readAt: number;
}
const cache = new Map<string, Entry>();

/**
 * The stored value for `key`, or `fallback` when it is unset, unreadable, or
 * the wrong shape.
 *
 * Never throws. A settings lookup that fails must not take down the thing it
 * was configuring — the fallback is the value the code shipped with, which is
 * by definition a working one.
 */
export async function getSettingValue<T>(
  key: string,
  fallback: T,
  isValid: (v: unknown) => v is T,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.readAt < TTL_MS) {
    return isValid(hit.value) ? hit.value : fallback;
  }
  try {
    const rows = await prisma.$queryRaw<{ value: unknown }[]>`
      SELECT value FROM system_setting WHERE key = ${key} LIMIT 1
    `;
    const value = rows[0]?.value;
    cache.set(key, { value, readAt: Date.now() });
    return isValid(value) ? value : fallback;
  } catch {
    // Cache the miss too, so a database that is refusing connections does not
    // get one query per Claude call on top of whatever else is wrong.
    cache.set(key, { value: undefined, readAt: Date.now() });
    return fallback;
  }
}

/** Drop the cache — called after a successful write so the change is visible. */
export function invalidateSettingCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

/** A Claude model id, the only shape the two model pins may hold. */
export const isClaudeModel = (v: unknown): v is string =>
  typeof v === "string" && /^claude-[a-z0-9.-]+$/.test(v);
