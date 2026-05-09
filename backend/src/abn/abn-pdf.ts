/**
 * Minimal pure-Node PDF generator for the CMS-R-131 ABN form.
 *
 * Form CMS-R-131 (ABN — Advance Beneficiary Notice of Noncoverage) is
 * a single Letter-size page with mandatory header text + filled
 * patient/provider fields + the three options checkboxes + signature
 * block. We generate a deterministic, fillable rendition using only
 * Node's stdlib — no `pdfkit`, no `pdf-lib`, no font files.
 *
 * The output is a valid PDF 1.4 file that opens in any reader. The
 * Helvetica font is one of the 14 standard PDF "core fonts" that
 * every conforming reader provides without an embedded font file.
 *
 * Tested by:
 *   - `abn-pdf.spec.ts` — asserts the structural xref table is sound
 *     and that the rendered text contains every expected field.
 *
 * Form version `CMS-R-131-2026-03-13` (effective March 13, 2026 —
 * old form usable through May 12, 2026 per CMS).
 */

export interface AbnFormData {
  formVersion: string; // e.g. 'CMS-R-131-2026-03-13'
  notifierName: string;
  notifierAddress: string;
  patientName: string;
  patientId: string; // typically an internal opaque id, NOT MRN
  serviceDescription: string; // the items/services we expect Medicare not to cover
  reasonForNoncoverage: string;
  estimatedCost: string; // "$ 145.00" or similar
  optionSelected: 'OPTION_1' | 'OPTION_2' | 'OPTION_3' | null;
  signedAt: Date | null;
  signaturePresent: boolean;
}

interface PdfObject {
  id: number;
  body: string;
}

/**
 * Build the PDF byte buffer. The output is reproducible: same input
 * produces the same bytes (modulo the timestamp in `signedAt`).
 */
export function buildAbnPdf(data: AbnFormData): Buffer {
  const lines = renderLines(data);
  const stream = buildContentStream(lines);

  const objects: PdfObject[] = [];
  // 1: catalog
  objects.push({
    id: 1,
    body: '<< /Type /Catalog /Pages 2 0 R >>',
  });
  // 2: page tree
  objects.push({
    id: 2,
    body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  });
  // 3: page (Letter = 612 x 792 points; 1 inch = 72 pt)
  objects.push({
    id: 3,
    body:
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> ' +
      '/Contents 4 0 R >>',
  });
  // 4: content stream
  objects.push({
    id: 4,
    body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  });
  // 5: Helvetica regular
  objects.push({
    id: 5,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  });
  // 6: Helvetica-Bold
  objects.push({
    id: 6,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  });

  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  let body = header;
  const offsets: number[] = [0]; // index 0 is the free entry
  for (const o of objects) {
    offsets[o.id] = Buffer.byteLength(body, 'binary');
    body += `${o.id} 0 obj\n${o.body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

/**
 * Lines of text + their formatting. The content stream emits these
 * in PDF text-object form using HelveticaBold for headers, Helvetica
 * for body.
 */
interface RenderedLine {
  text: string;
  bold: boolean;
  size: number;
  yOffset: number; // distance from page top in points
}

function renderLines(data: AbnFormData): RenderedLine[] {
  // Letter top is y=792. We render from top down by computing absolute
  // baseline y = 792 - yOffset.
  const out: RenderedLine[] = [];
  let y = 50;
  const head = (text: string, size = 12) => {
    out.push({ text, bold: true, size, yOffset: y });
    y += size + 4;
  };
  const body = (text: string, size = 10) => {
    out.push({ text, bold: false, size, yOffset: y });
    y += size + 3;
  };
  const blank = (n = 1) => {
    y += 6 * n;
  };

  head(`Advance Beneficiary Notice of Noncoverage (ABN)`, 14);
  body(`Form ${data.formVersion} — Office of Management and Budget approved.`);
  blank();

  head('NOTIFIER', 10);
  body(escapePdf(data.notifierName));
  body(escapePdf(data.notifierAddress));
  blank();

  head('PATIENT NAME', 10);
  body(escapePdf(data.patientName));
  body(`Identification number: ${escapePdf(data.patientId)}`);
  blank();

  head("NOTE: If Medicare doesn't pay for D. below, you may have to pay.", 10);
  body('Medicare does not pay for everything, even some care that you or your');
  body('health care provider have good reason to think you need. We expect');
  body('Medicare may not pay for the D. below.');
  blank();

  head('D. SERVICE / ITEM', 10);
  body(escapePdf(data.serviceDescription));
  blank();

  head('E. REASON MEDICARE MAY NOT PAY', 10);
  body(escapePdf(data.reasonForNoncoverage));
  blank();

  head('F. ESTIMATED COST', 10);
  body(escapePdf(data.estimatedCost));
  blank();

  head('OPTIONS — CHOOSE ONE', 10);
  body(
    `${data.optionSelected === 'OPTION_1' ? '[X]' : '[ ]'} OPTION 1. I want the D. listed above. You may ask`,
  );
  body('  Medicare to be billed for an official decision on payment, which');
  body('  is sent to me on a Medicare Summary Notice.');
  body(
    `${data.optionSelected === 'OPTION_2' ? '[X]' : '[ ]'} OPTION 2. I want the D. listed above, but do not bill Medicare.`,
  );
  body(
    `${data.optionSelected === 'OPTION_3' ? '[X]' : '[ ]'} OPTION 3. I don't want the D. listed above. I understand that`,
  );
  body('  with this choice I am not responsible for payment.');
  blank();

  head('H. SIGNATURE', 10);
  body(
    data.signaturePresent
      ? '/// signed in accompanying record ///'
      : '_____________________________________',
  );
  body(`Date: ${data.signedAt ? data.signedAt.toISOString().slice(0, 10) : '__________'}`);
  blank();

  head('Additional Information', 10);
  body('This notice gives our opinion, not an official Medicare decision.');
  body('If you have other questions on this notice or Medicare billing,');
  body('call 1-800-MEDICARE (1-800-633-4227 / TTY: 1-877-486-2048).');

  return out;
}

function escapePdf(s: string): string {
  // PDF strings (...) escape (, ), and \\.
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildContentStream(lines: RenderedLine[]): string {
  // BT/ET wraps text objects. Tj draws a string. Tf sets font + size.
  // Td moves cursor by (dx, dy) from previous origin.
  let out = 'BT\n';
  let lastY = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const font = ln.bold ? 'F2' : 'F1';
    const baselineY = 792 - ln.yOffset; // PDF origin is bottom-left
    const dy = baselineY - lastY;
    if (i === 0) {
      out += `1 0 0 1 50 ${baselineY.toFixed(2)} Tm\n`;
    } else {
      out += `0 ${dy.toFixed(2)} Td\n`;
    }
    out += `/${font} ${ln.size} Tf\n`;
    out += `(${ln.text}) Tj\n`;
    lastY = baselineY;
  }
  out += 'ET\n';
  return out;
}
