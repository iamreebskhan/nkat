/**
 * A Pallio claim as an 837P claim (0120): what stops it, what goes with it,
 * and the pieces a clearinghouse checks before a payer ever sees it (the NPI
 * check digit, the nine-digit billing ZIP, the payer's ID at this
 * clearinghouse).
 */
import { describe, expect, it } from "vitest";

import { claimFileName, claimTo837, npiValid, splitPersonName, type ClaimSource } from "../claim-837";
import { applySecretsPatch, connectionProblems, defaultSettings } from "../connection-settings";
import { isPrivateAddress } from "../endpoint-guard";

const settings = defaultSettings("availity", "test");

const claim: ClaimSource = {
  superbillId: "b2e303af-e2cb-4292-8d00-c35c07423a0d",
  claimRef: "B2E303AFE2CB",
  status: "ready_to_submit",
  dateOfService: "2026-10-27",
  placeOfService: "12",
  codes: ["99350", "G0318"],
  units: { G0318: 2 },
  modifiers: [],
  icd10: ["I50.9"],
  chargeCents: { "99350": 22713, G0318: 6240 },
  patient: { lastName: "Testcase", firstName: "Ruth", dob: "1941-03-02", sex: "F", address: { line1: "12 Elm St", city: "Columbus", state: "OH", zip: "43215" } },
  memberId: "1EG4TE5MK72",
  groupNumber: null,
  payer: { id: "p1", name: "Medicare Ohio", type: "medicare_mac" },
  rendering: { name: "Helen Okafor", npi: "1245319599", taxonomy: "363LF0000X" },
  billing: {
    name: "Demo Palliative (test)", npi: "1234567893", ein: "123456789", taxonomy: "207QH0002X",
    address: { line1: "100 Main St", city: "Columbus", state: "OH", zip: "432151234" }, payTo: null,
  },
  priorPayerClaimNumber: null,
};
const ctx = { settings, vendorName: "Availity", payerId: { externalPayerId: "15202", claimFilingIndicator: null } };

describe("npiValid", () => {
  it("checks the Luhn digit over 80840 and the first nine digits", () => {
    expect(npiValid("1234567893")).toBe(true);
    expect(npiValid("1245319599")).toBe(true);
    // CONTROL: one digit off fails.
    expect(npiValid("1234567894")).toBe(false);
    expect(npiValid("123456789")).toBe(false);
    expect(npiValid(null)).toBe(false);
  });
});

describe("splitPersonName", () => {
  it("takes the last word as the surname and drops a credential after a comma", () => {
    expect(splitPersonName("Helen Okafor")).toEqual({ firstName: "Helen", lastName: "Okafor" });
    expect(splitPersonName("Mary Ann Van-Dyke, NP")).toEqual({ firstName: "Mary Ann", lastName: "Van-Dyke" });
  });
});

describe("claimTo837", () => {
  it("maps a ready claim with its units, charges, payer ID and filing indicator", () => {
    const m = claimTo837(claim, ctx);
    expect(m.stops).toEqual([]);
    expect(m.claim).toMatchObject({
      claimRef: "B2E303AFE2CB",
      frequency: "1",
      payer: { name: "Medicare Ohio", id: "15202", filingIndicator: "MB" },
      rendering: { lastName: "Okafor", firstName: "Helen", npi: "1245319599" },
    });
    expect(m.claim!.lines).toEqual([
      { code: "99350", modifiers: [], units: 1, chargeCents: 22713, diagnosisPointers: [1] },
      { code: "G0318", modifiers: [], units: 2, chargeCents: 6240, diagnosisPointers: [1] },
    ]);
  });

  it("stops a claim the clearinghouse would reject, naming each reason", () => {
    const m = claimTo837(
      {
        ...claim,
        memberId: "",
        billing: { ...claim.billing, npi: "1234567894", address: { ...claim.billing.address!, zip: "43215" } },
        patient: { ...claim.patient, dob: null },
      },
      { ...ctx, payerId: null },
    );
    expect(m.claim).toBeNull();
    expect(m.stops).toEqual(
      expect.arrayContaining([
        "no member ID (patient's chart → Insurance)",
        "no Availity payer ID for Medicare Ohio (Settings → Integrations → Payer IDs)",
        "a billing NPI that fails its check digit (Settings → Billing provider)",
        "a billing ZIP without its last four digits; claims need all nine (Settings → Billing provider)",
        "no patient date of birth (patient's chart → Identity)",
      ]),
    );
  });

  it("CONTROL: the same claim with every field present goes", () => {
    expect(claimTo837(claim, ctx).claim).not.toBeNull();
  });

  it("a corrected denial replaces the payer's claim when its number is on file, and warns when it is not", () => {
    const withNumber = claimTo837({ ...claim, status: "denied", priorPayerClaimNumber: "26300123456789" }, ctx);
    expect(withNumber.claim).toMatchObject({ frequency: "7", originalClaimNumber: "26300123456789" });
    const without = claimTo837({ ...claim, status: "denied" }, ctx);
    expect(without.claim!.frequency).toBe("1");
    expect(without.warnings).toContain("refiled as a new claim, not a replacement: there's no payer claim number on file for the original");
  });

  it("a mapping's own filing indicator wins over the payer's type", () => {
    const m = claimTo837(claim, { ...ctx, payerId: { externalPayerId: "15202", claimFilingIndicator: "MC" } });
    expect(m.claim!.payer.filingIndicator).toBe("MC");
  });

  it("warns about what goes but may trouble a payer", () => {
    const m = claimTo837({ ...claim, placeOfService: "32", patient: { ...claim.patient, sex: null }, rendering: { ...claim.rendering, taxonomy: null } }, ctx);
    expect(m.claim).not.toBeNull();
    expect(m.warnings).toEqual(expect.arrayContaining(["no patient sex on the chart (sent as unknown)", "no taxonomy for the clinician (Team page)"]));
    expect(m.warnings.some((w) => w.startsWith("place of service 32"))).toBe(true);
    expect(m.claim!.subscriber.sex).toBe("U");
  });

  it("names the file by its interchange number", () => {
    expect(claimFileName(77, ".txt")).toBe("pallio-837p-000000077.txt");
  });
});

describe("connection settings", () => {
  it("each channel needs its secrets, and Availity's API is Availity's only", () => {
    expect(connectionProblems({ vendor: "availity", batchChannel: "sftp", realtimeChannel: "availity_api", settings, secrets: {} })).toEqual([
      "SFTP needs a password or an SSH key.",
      "Availity's API needs its client secret.",
    ]);
    expect(connectionProblems({ vendor: "availity", batchChannel: "sftp", realtimeChannel: "availity_api", settings, secrets: { sftpPassword: "x", apiClientSecret: "y" } })).toEqual([]);
    const waystar = defaultSettings("waystar", "test");
    expect(connectionProblems({ vendor: "waystar", batchChannel: "manual", realtimeChannel: "availity_api", settings: waystar, secrets: { apiClientSecret: "y" } })).toContain(
      "Availity's API connects to Availity only.",
    );
  });

  it("a secrets patch sets, clears or keeps each one", () => {
    expect(applySecretsPatch({ sftpPassword: "old", corePassword: "c" }, { sftpPassword: "new", corePassword: null })).toEqual({ sftpPassword: "new" });
    expect(applySecretsPatch({ sftpPassword: "old" }, {})).toEqual({ sftpPassword: "old" });
  });

  it("starts from the vendor's published values", () => {
    expect(settings.receiver).toMatchObject({ qualifier: "01", id: "030240928", gsCode: "030240928" });
    expect(settings.sftp).toMatchObject({ host: "qa-files.availity.com", port: 22, uploadDir: "SendFiles", downloadDirs: ["ReceiveFiles"] });
    expect(defaultSettings("availity", "production").sftp!.host).toBe("files.availity.com");
  });
});

describe("isPrivateAddress (where a connection may not point)", () => {
  it("refuses loopback, private, link-local, CGNAT and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("CONTROL: a public address is allowed", () => {
    for (const ip of ["8.8.8.8", "34.117.59.81", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});
