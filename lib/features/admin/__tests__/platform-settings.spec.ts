/**
 * The settings catalog was decoration: the upsert took any key and any JSON.
 *
 * That matters because nothing downstream complains. `lookup.daily_quotas` —
 * one letter wrong — saved, returned success, and then could never be seen
 * again, since the page renders the catalog and a key outside it has no row.
 * An hour of 99 means the cron never fires. A dimension that is not 1024
 * writes vectors that will not compare against everything already stored.
 * All of them fail quietly, later, somewhere else.
 */
import { describe, expect, it } from "vitest";

import { KNOWN_SETTINGS, SYSTEM_MANAGED_KEYS } from "@/lib/features/admin/platform-settings.service";

const check = (key: string, value: unknown) =>
  KNOWN_SETTINGS.find((k) => k.key === key)!.check(value);

describe("platform settings catalog", () => {
  it("describes every key it offers to edit", () => {
    for (const k of KNOWN_SETTINGS) {
      expect(k.description, k.key).toBeTruthy();
      expect(typeof k.check, k.key).toBe("function");
    }
  });

  it("accepts a plausible value for every key", () => {
    const good: Record<string, unknown> = {
      "lookup.daily_quota": 500,
      "ai.synthesizer_model": "claude-sonnet-4-6",
      "ai.parser_model": "claude-haiku-4-5",
      "embeddings.dimension": 1024,
      "cron.alert_hour_utc": 13,
      "cron.backup_hour_utc": 3,
    };
    for (const k of KNOWN_SETTINGS) {
      expect(k.check(good[k.key]), `${k.key} = ${JSON.stringify(good[k.key])}`).toBeNull();
    }
  });

  it("rejects an hour outside 0-23 — the cron would simply never fire", () => {
    expect(check("cron.alert_hour_utc", 24)).toMatch(/0–23/);
    expect(check("cron.alert_hour_utc", -1)).toMatch(/0–23/);
    expect(check("cron.backup_hour_utc", 3.5)).toMatch(/0–23/);
    expect(check("cron.backup_hour_utc", "3")).toMatch(/0–23/);
  });

  it("pins the embedding dimension to the column width", () => {
    // vector(1024) in production. Any other number does not resize anything.
    expect(check("embeddings.dimension", 1024)).toBeNull();
    expect(check("embeddings.dimension", 1536)).toMatch(/1024/);
    expect(check("embeddings.dimension", "banana")).toMatch(/1024/);
  });

  it("rejects a quota that is not a positive whole number", () => {
    expect(check("lookup.daily_quota", 0)).toBeTruthy();
    expect(check("lookup.daily_quota", -5)).toBeTruthy();
    expect(check("lookup.daily_quota", 12.5)).toBeTruthy();
    expect(check("lookup.daily_quota", "500")).toBeTruthy();
    expect(check("lookup.daily_quota", 500)).toBeNull();
  });

  it("rejects a model id that is not a Claude model", () => {
    expect(check("ai.parser_model", "gpt-4")).toBeTruthy();
    expect(check("ai.synthesizer_model", "")).toBeTruthy();
    expect(check("ai.synthesizer_model", 5)).toBeTruthy();
    expect(check("ai.synthesizer_model", "claude-opus-4-8")).toBeNull();
  });

  it("knows which keys the database owns", () => {
    // Written by migration 0021's trigger on every payer_rule insert. Not
    // settable by hand, but it has to be visible — a stored row with no row
    // on screen is what made the page report "1 configured" above six rows
    // that all read "(not set)".
    expect(SYSTEM_MANAGED_KEYS.has("synthesis_cache.version")).toBe(true);
    expect(KNOWN_SETTINGS.some((k) => k.key === "synthesis_cache.version")).toBe(false);
  });
});
