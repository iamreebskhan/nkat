/**
 * Documents kept on a referral or a patient (0112; Mark Q11j default).
 *
 * The file is encrypted in the row when the PHI key is configured
 * (pgp_sym_encrypt_bytea, as 0034's companions use pgp_sym_encrypt) and held
 * as uploaded when it is not; `encrypted` says which. Every upload, opening
 * and removal is audited with the kind, type and size, never the file's name,
 * which is often the patient's.
 */
import { createHash } from "node:crypto";

import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { applyPhiKeyIfConfigured } from "@/lib/hipaa/pgp";

import {
  DOCUMENT_MAX_BYTES,
  documentFileName,
  sniffDocumentType,
  type DocumentContentType,
  type DocumentKind,
  type DocumentView,
} from "./patient-document.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

export type DocumentSubject = { referralId: string } | { patientId: string };

interface Row {
  id: string;
  kind: DocumentKind;
  file_name: string;
  content_type: DocumentContentType;
  size_bytes: number;
  uploaded_by_name: string | null;
  uploaded_at: Date;
  referral_id: string | null;
  removed_at: Date | null;
  removed_by_name: string | null;
  removed_reason: string | null;
}

const toView = (r: Row): DocumentView => ({
  id: r.id,
  kind: r.kind,
  fileName: r.file_name,
  contentType: r.content_type,
  sizeBytes: Number(r.size_bytes),
  uploadedByName: r.uploaded_by_name,
  uploadedAt: r.uploaded_at.toISOString(),
  fromReferral: r.referral_id !== null,
  removedAt: r.removed_at ? r.removed_at.toISOString() : null,
  removedByName: r.removed_by_name,
  removedReason: r.removed_reason,
});

/**
 * The subject, as stored: a referral's documents, or a patient's. An admitted
 * referral's documents are the patient's too; a closed one takes none.
 */
async function resolveSubject(
  tx: Tx,
  orgId: string,
  subject: DocumentSubject,
  forWrite: boolean,
): Promise<{ referralId: string | null; patientId: string | null }> {
  if ("referralId" in subject) {
    const r = await tx.$queryRaw<{ stage: string; patient_id: string | null }[]>`
      SELECT stage, patient_id FROM referral WHERE id = ${subject.referralId}::uuid AND org_id = ${orgId}::uuid
    `;
    if (!r[0]) throw new NotFoundError("Referral not found.");
    if (forWrite && (r[0].stage === "ntuc" || r[0].stage === "transitioned")) {
      throw new ValidationError("This referral is closed. Reopen it to add paperwork.");
    }
    return { referralId: subject.referralId, patientId: r[0].patient_id };
  }
  const p = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM patient WHERE id = ${subject.patientId}::uuid AND org_id = ${orgId}::uuid
  `;
  if (!p[0]) throw new NotFoundError("Patient not found.");
  return { referralId: null, patientId: subject.patientId };
}

export async function listDocuments(args: { orgId: string; subject: DocumentSubject }): Promise<DocumentView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const s = await resolveSubject(tx, args.orgId, args.subject, false);
    // A patient's list includes what came with their referral; a referral's
    // is its own.
    const byPatient = "patientId" in args.subject;
    const rows = await tx.$queryRaw<Row[]>`
      SELECT d.id, d.kind, d.file_name, d.content_type, d.size_bytes,
             COALESCE(u.full_name, u.email) AS uploaded_by_name, d.uploaded_at, d.referral_id,
             d.removed_at, COALESCE(ru.full_name, ru.email) AS removed_by_name, d.removed_reason
        FROM patient_document d
        LEFT JOIN app_user u ON u.id = d.uploaded_by_user_id
        LEFT JOIN app_user ru ON ru.id = d.removed_by_user_id
       WHERE d.org_id = ${args.orgId}::uuid
         AND (CASE WHEN ${byPatient} THEN d.patient_id = ${s.patientId}::uuid
                   ELSE d.referral_id = ${s.referralId}::uuid END)
       ORDER BY d.uploaded_at DESC
       LIMIT 200
    `;
    return rows.map(toView);
  });
}

export async function addDocument(args: {
  orgId: string;
  userId: string;
  subject: DocumentSubject;
  kind: DocumentKind;
  fileName: string;
  bytes: Uint8Array;
}): Promise<{ id: string }> {
  const size = args.bytes.byteLength;
  if (size === 0) throw new ValidationError("The file is empty.");
  if (size > DOCUMENT_MAX_BYTES) throw new ValidationError("The file is over 10 MB.");
  const type = sniffDocumentType(args.bytes);
  if (!type) throw new ValidationError("Only PDF, JPEG and PNG files can be kept here.");
  const name = documentFileName(args.fileName, type);
  const sha256 = createHash("sha256").update(args.bytes).digest("hex");
  const data = Buffer.from(args.bytes);
  return withOrgContext(args.orgId, async (tx) => {
    const s = await resolveSubject(tx, args.orgId, args.subject, true);
    const phi = await applyPhiKeyIfConfigured(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient_document (
        org_id, referral_id, patient_id, kind, file_name, content_type, size_bytes, sha256,
        content, encrypted, uploaded_by_user_id
      ) VALUES (
        ${args.orgId}::uuid, ${s.referralId}::uuid, ${s.patientId}::uuid, ${args.kind}, ${name}, ${type},
        ${size}, ${sha256},
        CASE WHEN ${phi}
             THEN pgp_sym_encrypt_bytea(${data}::bytea, current_setting('app.phi_key'), 'cipher-algo=aes256')
             ELSE ${data}::bytea END,
        ${phi}, ${args.userId}::uuid
      )
      RETURNING id
    `;
    const id = rows[0]!.id;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "document_upload",
      targetType: "patient_document",
      targetId: id,
      payload: {
        subject: s.referralId ? "referral" : "patient",
        referralId: s.referralId,
        patientId: s.patientId,
        kind: args.kind,
        contentType: type,
        sizeBytes: size,
        encrypted: phi,
      },
    });
    return { id };
  });
}

/** The file, for the person opening it; the opening is audited. */
export async function openDocument(args: {
  orgId: string;
  userId: string;
  id: string;
}): Promise<{ fileName: string; contentType: DocumentContentType; bytes: Buffer; patientId: string | null }> {
  return withOrgContext(args.orgId, async (tx) => {
    const meta = await tx.$queryRaw<
      { encrypted: boolean; removed_at: Date | null; patient_id: string | null; referral_id: string | null }[]
    >`
      SELECT encrypted, removed_at, patient_id, referral_id FROM patient_document
       WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    const m = meta[0];
    if (!m) throw new NotFoundError("Document not found.");
    if (m.removed_at) throw new NotFoundError("This document was removed.");
    const phi = await applyPhiKeyIfConfigured(tx);
    if (m.encrypted && !phi) {
      throw new ValidationError("This document is encrypted and the key is not configured on this server.");
    }
    const rows = await tx.$queryRaw<{ file_name: string; content_type: DocumentContentType; content: Uint8Array }[]>`
      SELECT file_name, content_type,
             CASE WHEN encrypted THEN pgp_sym_decrypt_bytea(content, current_setting('app.phi_key'))
                  ELSE content END AS content
        FROM patient_document
       WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    const r = rows[0]!;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "document_view",
      targetType: "patient_document",
      targetId: args.id,
      payload: { subject: m.patient_id ? "patient" : "referral", patientId: m.patient_id, referralId: m.referral_id },
    });
    return { fileName: r.file_name, contentType: r.content_type, bytes: Buffer.from(r.content), patientId: m.patient_id };
  });
}

/**
 * Remove a document filed in error: its content goes, the row and why stay.
 * Not a way to tidy a chart — the reason is required and audited.
 */
export async function removeDocument(args: {
  orgId: string;
  userId: string;
  id: string;
  reason: string;
}): Promise<void> {
  const reason = args.reason.trim();
  if (!reason) throw new ValidationError("Say why it is being removed.");
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ kind: DocumentKind; patient_id: string | null; referral_id: string | null }[]>`
      UPDATE patient_document
         SET content = NULL, removed_at = now(), removed_by_user_id = ${args.userId}::uuid,
             removed_reason = ${reason.slice(0, 300)}
       WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid AND removed_at IS NULL
      RETURNING kind, patient_id, referral_id
    `;
    if (!rows[0]) throw new NotFoundError("Document not found, or already removed.");
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "document_remove",
      targetType: "patient_document",
      targetId: args.id,
      payload: { kind: rows[0].kind, patientId: rows[0].patient_id, referralId: rows[0].referral_id },
    });
  });
}

/** Admission (0111): the referral's paperwork is the patient's from now on. */
export async function moveReferralDocumentsToPatient(
  tx: Tx,
  args: { orgId: string; referralId: string; patientId: string },
): Promise<void> {
  await tx.$executeRaw`
    UPDATE patient_document SET patient_id = ${args.patientId}::uuid
     WHERE referral_id = ${args.referralId}::uuid AND org_id = ${args.orgId}::uuid AND patient_id IS NULL
  `;
}
