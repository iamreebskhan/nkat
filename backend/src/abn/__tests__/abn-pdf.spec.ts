import { buildAbnPdf, type AbnFormData } from '../abn-pdf';

const baseData: AbnFormData = {
  formVersion: 'CMS-R-131-2026-03-13',
  notifierName: 'Acme Hospice',
  notifierAddress: '123 Oak Street, Cleveland, OH 44109',
  patientName: 'Jane Q. Public',
  patientId: 'pat-abc-123',
  serviceDescription: 'Daily skilled visit for terminal CHF',
  reasonForNoncoverage: 'Frequency exceeds LCD limit.',
  estimatedCost: '$ 245.00',
  optionSelected: 'OPTION_1',
  signedAt: new Date('2026-04-15T10:00:00Z'),
  signaturePresent: true,
};

describe('buildAbnPdf', () => {
  it('emits a structurally valid PDF 1.4 file', () => {
    const buf = buildAbnPdf(baseData);
    const head = buf.subarray(0, 8).toString('binary');
    expect(head).toBe('%PDF-1.4');
    // Must contain the trailer + EOF marker.
    const tail = buf.subarray(-6).toString('binary');
    expect(tail).toContain('%%EOF');
    // xref + startxref + trailer markers exist.
    const text = buf.toString('binary');
    expect(text).toContain('xref');
    expect(text).toContain('trailer');
    expect(text).toContain('startxref');
    // Catalog → Pages → single page chain.
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    expect(text).toContain('/Type /Page');
    expect(text).toContain('/Count 1');
  });

  it('embeds form-version + patient name + service description', () => {
    const buf = buildAbnPdf(baseData);
    const text = buf.toString('binary');
    expect(text).toContain('CMS-R-131-2026-03-13');
    expect(text).toContain('Jane Q. Public');
    expect(text).toContain('Daily skilled visit for terminal CHF');
  });

  it('marks the selected option box', () => {
    const o1 = buildAbnPdf({ ...baseData, optionSelected: 'OPTION_1' }).toString('binary');
    expect(o1).toMatch(/\[X\] OPTION 1/);
    expect(o1).toMatch(/\[ \] OPTION 2/);
    expect(o1).toMatch(/\[ \] OPTION 3/);

    const o3 = buildAbnPdf({ ...baseData, optionSelected: 'OPTION_3' }).toString('binary');
    expect(o3).toMatch(/\[ \] OPTION 1/);
    expect(o3).toMatch(/\[X\] OPTION 3/);
  });

  it('escapes parens and backslashes in user-supplied strings', () => {
    const buf = buildAbnPdf({
      ...baseData,
      patientName: 'Smith (Senior)',
      serviceDescription: 'Test \\ backslash',
    });
    const text = buf.toString('binary');
    // PDF escape sequences in the content stream:
    expect(text).toContain('Smith \\(Senior\\)');
    expect(text).toContain('Test \\\\ backslash');
  });

  it('omits the signed_at date when null', () => {
    const buf = buildAbnPdf({ ...baseData, signedAt: null, signaturePresent: false });
    const text = buf.toString('binary');
    expect(text).toContain('Date: __________');
  });

  it('renders an xref table whose offsets actually point at object headers', () => {
    const buf = buildAbnPdf(baseData);
    const text = buf.toString('binary');
    // Find the xref offset
    const m = text.match(/startxref\n(\d+)/);
    expect(m).not.toBeNull();
    const xrefStart = parseInt(m![1], 10);
    const xrefSection = text.slice(xrefStart);
    expect(xrefSection.startsWith('xref')).toBe(true);
    // Parse "0000000123 00000 n " entries.
    const entries = xrefSection.match(/^\d{10} \d{5} n /gm) || [];
    expect(entries.length).toBeGreaterThanOrEqual(6); // 6 objects in our PDF
    for (const e of entries) {
      const off = parseInt(e.slice(0, 10), 10);
      expect(text.slice(off)).toMatch(/^\d+ 0 obj/);
    }
  });
});
