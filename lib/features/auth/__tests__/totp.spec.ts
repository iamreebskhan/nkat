import { describe, expect, it } from "vitest";

import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpAtTime,
  verifyTotp,
} from "../totp";

describe("base32 round-trip", () => {
  it("encodes + decodes back to the same bytes", () => {
    const original = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    const enc = base32Encode(original);
    const dec = base32Decode(enc);
    expect(dec.equals(original)).toBe(true);
  });

  it("ignores trailing = padding on decode", () => {
    const enc = base32Encode(Buffer.from([0xff, 0x00, 0x12]));
    const padded = enc + "===";
    expect(base32Decode(padded).equals(base32Decode(enc))).toBe(true);
  });
});

describe("totpAtTime", () => {
  it("produces a 6-digit numeric string", () => {
    const { base32 } = generateTotpSecret();
    const code = totpAtTime(base32, new Date("2026-05-10T00:00:00Z"));
    expect(code).toMatch(/^\d{6}$/);
  });

  it("is deterministic for the same secret + time", () => {
    const { base32 } = generateTotpSecret();
    const t = new Date("2026-05-10T00:00:00Z");
    expect(totpAtTime(base32, t)).toBe(totpAtTime(base32, t));
  });

  it("matches the RFC 6238 test vector at T=59", () => {
    // RFC 6238 Appendix B uses ASCII secret "12345678901234567890"
    const secret = base32Encode(Buffer.from("12345678901234567890", "utf8"));
    const t = new Date(59 * 1000);
    // RFC 6238 lists 94287082 for SHA-1 at T=59. SHA-1 / 8 digits.
    // We use 6 digits → last 6 digits of 94287082 are "287082".
    expect(totpAtTime(secret, t)).toBe("287082");
  });
});

describe("verifyTotp", () => {
  it("accepts the current code", () => {
    const { base32 } = generateTotpSecret();
    const t = new Date("2026-05-10T00:00:00Z");
    const code = totpAtTime(base32, t);
    expect(verifyTotp(base32, code, t)).toBe(true);
  });

  it("accepts code from 30s ago (clock skew tolerance)", () => {
    const { base32 } = generateTotpSecret();
    const now = new Date("2026-05-10T00:00:30Z");
    const before = new Date("2026-05-10T00:00:00Z");
    const code = totpAtTime(base32, before);
    expect(verifyTotp(base32, code, now)).toBe(true);
  });

  it("rejects code from 90s ago (outside tolerance)", () => {
    const { base32 } = generateTotpSecret();
    const now = new Date("2026-05-10T00:01:30Z");
    const old = new Date("2026-05-10T00:00:00Z");
    const code = totpAtTime(base32, old);
    expect(verifyTotp(base32, code, now)).toBe(false);
  });

  it("rejects malformed input", () => {
    const { base32 } = generateTotpSecret();
    expect(verifyTotp(base32, "abcdef")).toBe(false);
    expect(verifyTotp(base32, "12345")).toBe(false);
    expect(verifyTotp(base32, "1234567")).toBe(false);
  });
});

describe("otpauthUri", () => {
  it("renders the canonical otpauth:// URI", () => {
    const uri = otpauthUri({
      secretBase32: "JBSWY3DPEHPK3PXP",
      accountName: "alice@acme.com",
      issuer: "Pallio",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Pallio%3Aalice/);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Pallio");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
