import { describe, expect, it } from "vitest";

import { passwordResetEmail, passwordResetUrl } from "../templates-auth";

describe("passwordResetUrl", () => {
  // Regression: the reset page lives in the (auth) route GROUP, which does
  // NOT appear in the URL — it serves at /reset-password. The email once
  // linked to /auth/reset-password, which 404s in production.
  it("points at /reset-password (route groups are not URL segments)", () => {
    const u = passwordResetUrl("https://app.pallio.io", "a".repeat(64));
    expect(u).toBe(`https://app.pallio.io/reset-password?token=${"a".repeat(64)}`);
    expect(u).not.toContain("/auth/");
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(passwordResetUrl("https://app.pallio.io/", "tok")).toBe(
      "https://app.pallio.io/reset-password?token=tok",
    );
  });

  it("URL-encodes the token", () => {
    expect(passwordResetUrl("https://x.io", "a b&c")).toBe(
      "https://x.io/reset-password?token=a%20b%26c",
    );
  });
});

describe("passwordResetEmail", () => {
  it("embeds the reset URL in html and text", () => {
    const url = passwordResetUrl("https://app.pallio.io", "t0k3n");
    const e = passwordResetEmail({
      to: "n@example.com",
      resetUrl: url,
      branding: { displayName: null, primaryColor: null, logoUrl: null },
    });
    expect(e.html).toContain(url);
    expect(e.text).toContain(url);
    expect(e.subject).toContain("Pallio");
  });
});
