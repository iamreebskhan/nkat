import { describe, expect, it } from "vitest";

import { inviteEmail, payerRuleAlertEmail } from "../templates";

const BRANDING = {
  displayName: "Acme Hospice",
  primaryColor: "#0d9488",
  logoUrl: "https://cdn.example.com/logo.png",
};

describe("inviteEmail", () => {
  it("includes the inviter, orgName, and accept URL", () => {
    const e = inviteEmail({
      inviteeEmail: "n@example.com",
      inviterName: "Mark",
      acceptUrl: "https://app.pallio.io/invites/abc",
      expiresAt: "2026-05-15T00:00:00Z",
      branding: BRANDING,
    });
    expect(e.subject).toContain("Acme Hospice");
    expect(e.html).toContain("Mark");
    expect(e.html).toContain("https://app.pallio.io/invites/abc");
    expect(e.text).toContain("https://app.pallio.io/invites/abc");
  });

  it("escapes HTML in the inviter name", () => {
    const e = inviteEmail({
      inviteeEmail: "n@example.com",
      inviterName: "<script>alert(1)</script>",
      acceptUrl: "https://app.pallio.io/invites/x",
      expiresAt: "2026-05-15T00:00:00Z",
      branding: BRANDING,
    });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
  });

  it("falls back to Pallio when displayName is null", () => {
    const e = inviteEmail({
      inviteeEmail: "n@example.com",
      inviterName: "Mark",
      acceptUrl: "https://app.pallio.io/invites/x",
      expiresAt: "2026-05-15T00:00:00Z",
      branding: { displayName: null, primaryColor: null, logoUrl: null },
    });
    expect(e.subject).toContain("Pallio");
  });

  it("uses brand primary color in CTA", () => {
    const e = inviteEmail({
      inviteeEmail: "n@example.com",
      inviterName: "Mark",
      acceptUrl: "https://app.pallio.io/invites/x",
      expiresAt: "2026-05-15T00:00:00Z",
      branding: { ...BRANDING, primaryColor: "#ff00aa" },
    });
    expect(e.html).toContain("#ff00aa");
  });
});

describe("payerRuleAlertEmail", () => {
  it("renders count + payer + state", () => {
    const e = payerRuleAlertEmail({
      recipientEmail: "n@example.com",
      payerName: "Humana",
      state: "OH",
      changedCount: 3,
      rulebookUrl: "https://app.pallio.io/settings/rulebook",
      branding: BRANDING,
    });
    expect(e.subject).toContain("Humana");
    expect(e.subject).toContain("OH");
    expect(e.subject).toContain("3");
    expect(e.html).toContain("https://app.pallio.io/settings/rulebook");
  });

  it("uses singular wording for 1 change", () => {
    const e = payerRuleAlertEmail({
      recipientEmail: "n@example.com",
      payerName: "Aetna",
      state: "CA",
      changedCount: 1,
      rulebookUrl: "https://app.pallio.io/settings/rulebook",
      branding: BRANDING,
    });
    expect(e.subject).toContain("1 rule change");
    expect(e.subject).not.toContain("rule changes");
  });
});
