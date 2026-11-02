/**
 * Documents kept on a referral or a chart (0112). What a file is comes from
 * its bytes; a closed referral takes none; the audit never carries the file's
 * name; an encrypted file is not served without its key; removal empties it.
 * lib/db is mocked with a fake tx that records every statement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/hipaa/pgp", () => ({ applyPhiKeyIfConfigured: vi.fn(async () => false) }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { applyPhiKeyIfConfigured } from "@/lib/hipaa/pgp";

import { addDocument, openDocument, removeDocument } from "../patient-document.service";
import { documentFileName, sniffDocumentType } from "../patient-document.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REFERRAL = "f0000000-0000-4000-8000-000000000001";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const DOC = "d0c00000-0000-4000-8000-000000000001";

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);

let calls: { sql: string; values: unknown[] }[];
let referral: { stage: string; patient_id: string | null } | null;
let stored: { encrypted: boolean; removed_at: Date | null; patient_id: string | null; referral_id: string | null } | null;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM referral WHERE id")) return Promise.resolve(referral ? [referral] : []);
    if (sql.includes("SELECT id FROM patient WHERE id")) return Promise.resolve([{ id: PATIENT }]);
    if (sql.includes("INSERT INTO patient_document")) return Promise.resolve([{ id: DOC }]);
    if (sql.includes("SELECT encrypted, removed_at")) return Promise.resolve(stored ? [stored] : []);
    if (sql.includes("SELECT file_name, content_type")) {
      return Promise.resolve([{ file_name: "a.pdf", content_type: "application/pdf", content: PDF }]);
    }
    if (sql.includes("UPDATE patient_document") && sql.includes("RETURNING kind")) {
      return Promise.resolve(stored && !stored.removed_at ? [{ kind: "face_sheet", patient_id: PATIENT, referral_id: null }] : []);
    }
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  referral = { stage: "pre_admission", patient_id: null };
  stored = { encrypted: false, removed_at: null, patient_id: PATIENT, referral_id: REFERRAL };
  vi.mocked(applyPhiKeyIfConfigured).mockResolvedValue(false);
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const inserted = () => calls.find((c) => c.sql.includes("INSERT INTO patient_document"));
const audited = () => vi.mocked(writeAudit).mock.calls.map((c) => c[1]);

describe("what a file is", () => {
  it("knows a PDF, a JPEG and a PNG by their first bytes", () => {
    expect(sniffDocumentType(PDF)).toBe("application/pdf");
    expect(sniffDocumentType(JPEG)).toBe("image/jpeg");
    expect(sniffDocumentType(PNG)).toBe("image/png");
  });

  it("CONTROL: takes nothing else, whatever it is called", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    for (const bytes of [enc("<html><script>x</script>"), enc("<svg onload=x>"), enc("GIF89a"), enc("MZ\x90\x00"), enc("")]) {
      expect(sniffDocumentType(bytes)).toBeNull();
    }
  });

  it("keeps a name without its path or control characters, never empty, at most 200", () => {
    expect(documentFileName("C:\\fax\\Smith face sheet.pdf", "application/pdf")).toBe("Smith face sheet.pdf");
    expect(documentFileName('../x"\u0007<b>.png', "image/png")).toBe("xb.png");
    expect(documentFileName("scan", "image/jpeg")).toBe("scan.jpg");
    expect(documentFileName("   ", "application/pdf")).toBe("document.pdf");
    const long = documentFileName(`${"a".repeat(300)}.pdf`, "application/pdf");
    expect(long).toHaveLength(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("addDocument", () => {
  const add = (over: Partial<Parameters<typeof addDocument>[0]> = {}) =>
    addDocument({
      orgId: ORG,
      userId: USER,
      subject: { referralId: REFERRAL },
      kind: "face_sheet",
      fileName: "Smith_John_facesheet.pdf",
      bytes: PDF,
      ...over,
    });

  it("files the paperwork on the referral, and audits kind, type and size but never the name", async () => {
    await add();
    const ins = inserted()!;
    // INSERT … VALUES (org, referral, patient, kind, name, type, size, sha, …)
    expect(ins.values.slice(0, 7)).toEqual([ORG, REFERRAL, null, "face_sheet", "Smith_John_facesheet.pdf", "application/pdf", PDF.byteLength]);
    expect(ins.values[7]).toMatch(/^[0-9a-f]{64}$/);
    const entry = audited()[0]!;
    expect(entry).toMatchObject({ action: "document_upload", targetType: "patient_document", targetId: DOC });
    expect(entry.payload).toMatchObject({ subject: "referral", kind: "face_sheet", contentType: "application/pdf" });
    expect(JSON.stringify(entry.payload)).not.toMatch(/Smith|John|facesheet/);
  });

  it("names the patient on an admitted referral's paperwork", async () => {
    referral = { stage: "admitted", patient_id: PATIENT };
    await add();
    expect(inserted()!.values.slice(1, 3)).toEqual([REFERRAL, PATIENT]);
  });

  it("encrypts the file when the key is configured, and says so", async () => {
    vi.mocked(applyPhiKeyIfConfigured).mockResolvedValue(true);
    await add();
    expect(inserted()!.sql).toContain("pgp_sym_encrypt_bytea");
    expect(audited()[0]!.payload).toMatchObject({ encrypted: true });
  });

  it("CONTROL: refuses a file that is not a PDF, JPEG or PNG — renamed or not — and writes nothing", async () => {
    const html = new TextEncoder().encode("<html><body onload=alert(1)>");
    await expect(add({ fileName: "orders.pdf", bytes: html })).rejects.toMatchObject({ name: "ValidationError" });
    await expect(add({ bytes: new Uint8Array(0) })).rejects.toMatchObject({ name: "ValidationError" });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF);
    await expect(add({ bytes: big })).rejects.toThrow(/10 MB/);
    expect(inserted()).toBeUndefined();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("CONTROL: a closed referral takes no paperwork", async () => {
    for (const stage of ["ntuc", "transitioned"]) {
      referral = { stage, patient_id: null };
      await expect(add()).rejects.toThrow(/Reopen/);
    }
    expect(inserted()).toBeUndefined();
  });
});

describe("openDocument", () => {
  it("serves the file and audits the opening", async () => {
    const doc = await openDocument({ orgId: ORG, userId: USER, id: DOC });
    expect(doc).toMatchObject({ contentType: "application/pdf", patientId: PATIENT });
    expect(Buffer.from(doc.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(audited()[0]).toMatchObject({ action: "document_view", targetId: DOC });
  });

  it("CONTROL: an encrypted file without the key, or a removed one, is not served", async () => {
    stored = { ...stored!, encrypted: true };
    await expect(openDocument({ orgId: ORG, userId: USER, id: DOC })).rejects.toThrow(/key/);
    stored = { ...stored!, encrypted: false, removed_at: new Date() };
    await expect(openDocument({ orgId: ORG, userId: USER, id: DOC })).rejects.toMatchObject({ name: "NotFoundError" });
    expect(calls.some((c) => c.sql.includes("SELECT file_name, content_type"))).toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe("removeDocument", () => {
  it("empties the file, keeps who and why, and audits the kind only", async () => {
    await removeDocument({ orgId: ORG, userId: USER, id: DOC, reason: "Filed on the wrong patient" });
    const upd = calls.find((c) => c.sql.includes("UPDATE patient_document"))!;
    expect(upd.sql).toContain("content = NULL");
    expect(upd.values).toEqual(expect.arrayContaining([USER, "Filed on the wrong patient", DOC, ORG]));
    expect(audited()[0]).toMatchObject({ action: "document_remove", payload: { kind: "face_sheet" } });
    expect(JSON.stringify(audited()[0]!.payload)).not.toMatch(/wrong patient/);
  });

  it("CONTROL: no reason, no removal; a removed document is not removed twice", async () => {
    await expect(removeDocument({ orgId: ORG, userId: USER, id: DOC, reason: "  " })).rejects.toMatchObject({
      name: "ValidationError",
    });
    expect(calls).toHaveLength(0);
    stored = { ...stored!, removed_at: new Date() };
    await expect(removeDocument({ orgId: ORG, userId: USER, id: DOC, reason: "again" })).rejects.toMatchObject({
      name: "NotFoundError",
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
