/**
 * Documents kept on a referral or a patient (0112; Mark Q11j default: referral
 * paperwork kept on the patient as attachments). Pure constants and checks,
 * safe to import from client components.
 */

export const DOCUMENT_KINDS = [
  "referral_order",
  "medical_records",
  "face_sheet",
  "insurance_card",
  "consent",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  referral_order: "Referral or order",
  medical_records: "Medical records",
  face_sheet: "Face sheet",
  insurance_card: "Insurance card",
  consent: "Signed consent",
  other: "Other",
};

export const DOCUMENT_CONTENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type DocumentContentType = (typeof DOCUMENT_CONTENT_TYPES)[number];

/** 10 MB, as the table's CHECK. */
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * What the file is, from its own first bytes: the name and the browser's type
 * are the uploader's to choose, the bytes are not. Null for anything but a
 * PDF, a JPEG or a PNG.
 */
export function sniffDocumentType(bytes: Uint8Array): DocumentContentType | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

const EXTENSION: Record<DocumentContentType, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

/**
 * The name a document is kept under: the last path segment, without control
 * characters, at most 200 characters, never empty. A name with no extension
 * gets the one its bytes say it is.
 */
export function documentFileName(raw: string, type: DocumentContentType): string {
  const base = (raw.split(/[\\/]/).pop() ?? "")
    // Control characters and the ones a header or a file system chokes on.
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const named = base || `document${EXTENSION[type]}`;
  const withExt = /\.[a-z0-9]{2,5}$/i.test(named) ? named : `${named}${EXTENSION[type]}`;
  if (withExt.length <= 200) return withExt;
  const ext = withExt.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? "";
  return withExt.slice(0, 200 - ext.length) + ext;
}

/** A document as listed: everything but the file. */
export interface DocumentView {
  id: string;
  kind: DocumentKind;
  fileName: string;
  contentType: DocumentContentType;
  sizeBytes: number;
  uploadedByName: string | null;
  uploadedAt: string;
  /** Came with the referral (and moved to the chart at admission). */
  fromReferral: boolean;
  removedAt: string | null;
  removedByName: string | null;
  removedReason: string | null;
}

/** "1.2 MB", "340 KB". */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
