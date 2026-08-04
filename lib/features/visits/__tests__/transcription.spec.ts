/**
 * The PHI gate on transcription + note drafting.
 *
 * These assertions are the compliance boundary, not a nicety: an encounter
 * recording is PHI, and shipping it to a third party without a BAA is a
 * HIPAA breach. The default must be "off", and turning cloud processing on
 * must require a deliberate acknowledgement.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { transcriptionStatus } from "../transcription.service";
import { noteDraftStatus } from "../note-draft.service";

const KEYS = [
  "TRANSCRIPTION_URL",
  "TRANSCRIPTION_PROVIDER",
  "PHI_BAA_ACKNOWLEDGED",
  "NOTE_DRAFT_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("transcriptionStatus", () => {
  it("is off by default", () => {
    const s = transcriptionStatus();
    expect(s.available).toBe(false);
    expect(s.engine).toBeNull();
    expect(s.reason).toMatch(/not configured/i);
  });

  it("prefers self-hosted and needs no BAA acknowledgement", () => {
    process.env.TRANSCRIPTION_URL = "http://127.0.0.1:9000";
    const s = transcriptionStatus();
    expect(s.available).toBe(true);
    expect(s.engine).toBe("self_hosted");
  });

  it("refuses the hosted provider without an acknowledged BAA", () => {
    process.env.TRANSCRIPTION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    const s = transcriptionStatus();
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/BAA/);
  });

  it("still refuses when the acknowledgement is anything but the literal true", () => {
    process.env.TRANSCRIPTION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    for (const v of ["1", "yes", "TRUE", "true "]) {
      process.env.PHI_BAA_ACKNOWLEDGED = v;
      expect(transcriptionStatus().available).toBe(false);
    }
  });

  it("allows the hosted provider once the BAA is acknowledged and a key is set", () => {
    process.env.TRANSCRIPTION_PROVIDER = "openai";
    process.env.PHI_BAA_ACKNOWLEDGED = "true";
    process.env.OPENAI_API_KEY = "sk-test";
    const s = transcriptionStatus();
    expect(s.available).toBe(true);
    expect(s.engine).toBe("openai");
  });

  it("reports the missing key rather than claiming availability", () => {
    process.env.TRANSCRIPTION_PROVIDER = "openai";
    process.env.PHI_BAA_ACKNOWLEDGED = "true";
    const s = transcriptionStatus();
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/OPENAI_API_KEY/);
  });
});

describe("noteDraftStatus", () => {
  it("is off by default", () => {
    expect(noteDraftStatus().available).toBe(false);
  });

  it("does not enable drafting from an API key alone", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const s = noteDraftStatus();
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/PHI/);
  });

  it("enables drafting on a self-hosted model with no acknowledgement needed", () => {
    process.env.NOTE_DRAFT_URL = "http://127.0.0.1:8080";
    expect(noteDraftStatus().available).toBe(true);
  });

  it("enables hosted drafting only with both the acknowledgement and a key", () => {
    process.env.PHI_BAA_ACKNOWLEDGED = "true";
    expect(noteDraftStatus().available).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(noteDraftStatus().available).toBe(true);
  });
});
