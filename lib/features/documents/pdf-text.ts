/**
 * Read a PDF's text layer — FOR SCREENING, not for extraction.
 *
 * Rule extraction still hands the PDF to Claude as a document block; Claude
 * reads tables, layout and scanned pages far better than a text layer does,
 * and nothing here changes what gets sent. What was missing is that the PHI
 * guard could not see PDFs at all: document-ingestion built its extract input
 * as `isPdf ? { pdfBase64 } : { textContent }`, and the guard only ran on
 * textContent. So the guard was strict on the documents it could read and
 * absent on the ~20 of 25 registered sources it could not — the wrong way
 * round, since a patient roster is likelier to be a PDF than a web page.
 *
 * pdfjs-dist rather than a shell-out to pdftotext: the VPS has poppler
 * installed for scripts/recheck-source-drift.mjs, but a Windows dev box does
 * not, and a screening step that is simply absent on some machines creates
 * pressure to let unscreened documents through. An in-process library behaves
 * the same everywhere. Text extraction needs no canvas and no native code.
 *
 * Measured on six real payer PDFs (9.8 KB to 887 KB, 3 to 104 pages):
 * 271 ms to 3.1 s. The Claude call on the same document costs far more.
 */

/**
 * Stop reading after this long. A PDF can be pathological — the CMS payment
 * files run to hundreds of megabytes — and a screening step that hangs is a
 * screening step that gets removed. On timeout the caller gets what was read
 * plus `complete: false`, and MUST treat a partial read as unverified rather
 * than as a clean scan: the roster page could be the one we did not reach.
 */
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";

export const PDF_TEXT_DEADLINE_MS = 60_000;

export interface PdfTextResult {
  text: string;
  pages: number;
  /** False when the deadline cut the read short, or the file would not parse. */
  complete: boolean;
  /** Why it is incomplete, for the operator. null when complete. */
  reason: string | null;
}

export async function extractPdfText(
  bytes: Buffer,
  opts: { deadlineMs?: number } = {},
): Promise<PdfTextResult> {
  const deadline = Date.now() + (opts.deadlineMs ?? PDF_TEXT_DEADLINE_MS);

  // Imported here, not at module scope, so the library stays out of the graph
  // for every route that never touches a PDF. The legacy build is the one
  // that runs under plain Node without a DOM.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const params: DocumentInitParameters = {
    // pdf.js takes ownership of the buffer it is given, so hand it a copy —
    // the same bytes are hashed, base64'd for Claude and chunked afterwards.
    data: new Uint8Array(bytes),
    // No font loading of any kind. This parses untrusted third-party files
    // pulled from payer websites, and text extraction needs no glyphs — only
    // the character codes behind them. (pdf.js v5 dropped isEvalSupported;
    // it no longer evals at all.)
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  };

  // Hold the loading task, not just its promise: tearing down the worker is
  // `task.destroy()`. (It was `doc.destroy()` up to pdf.js v5, which is worth
  // knowing if this ever gets pinned backwards — the v5 call is silently
  // absent in v6 and shows up only when a document is actually parsed.)
  const task = pdfjs.getDocument(params);

  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => {});
    return {
      text: "",
      pages: 0,
      complete: false,
      reason: `could not parse the PDF: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const parts: string[] = [];
  let read = 0;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (Date.now() > deadline) {
        return {
          text: parts.join("\n"),
          pages: doc.numPages,
          complete: false,
          reason: `timed out after ${read} of ${doc.numPages} pages`,
        };
      }
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      parts.push(
        content.items.map((i) => ("str" in i ? i.str : "")).join(" "),
      );
      page.cleanup();
      read++;
    }
  } finally {
    await task.destroy();
  }

  return { text: parts.join("\n"), pages: doc.numPages, complete: true, reason: null };
}
