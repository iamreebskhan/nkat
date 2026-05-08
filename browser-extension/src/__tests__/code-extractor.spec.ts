import { _testing, extractCodes } from '../lib/code-extractor';

describe('collectFromText', () => {
  const { collectFromText } = _testing;

  it('finds CPT codes', () => {
    const out = collectFromText('Bill 99497 for ACP and 99213 for follow-up.');
    expect(out.map((o) => o.code).sort()).toEqual(['99213', '99497']);
    expect(out.every((o) => o.code_system === 'CPT')).toBe(true);
  });

  it('finds HCPCS Level II codes', () => {
    const out = collectFromText('Submit J9035 for the bevacizumab and E0470 for BiPAP.');
    expect(out.map((o) => o.code).sort()).toEqual(['E0470', 'J9035']);
  });

  it('excludes ICD-10s that share digits with CPT-shaped substrings', () => {
    const out = collectFromText('Diagnosis Z51.5 with procedure 99497.');
    const codes = out.map((o) => o.code);
    expect(codes).toContain('99497');
    expect(codes).not.toContain('Z51');
  });

  it('skips obvious year values', () => {
    const out = collectFromText('Effective 2026 for CPT 99497');
    expect(out.map((o) => o.code)).toEqual(['99497']);
  });

  it('snippet stays under 80 chars and contains the matched code', () => {
    const long = 'x'.repeat(50) + ' 99497 covered ' + 'y'.repeat(50);
    const out = collectFromText(long);
    expect(out[0].context.length).toBeLessThanOrEqual(80);
    expect(out[0].context).toContain('99497');
  });

  it('returns empty for clean text', () => {
    expect(collectFromText('No codes here, just words.')).toEqual([]);
  });
});

describe('extractCodes (DOM)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('walks the DOM and dedupes codes across nodes', () => {
    document.body.innerHTML = `
      <div>Note A — 99497 mentioned.</div>
      <div>Note B — 99497 again, plus 99498.</div>
      <p>Diagnosis: Z51.5</p>
    `;
    const out = extractCodes(document.body);
    expect(out.map((o) => o.code).sort()).toEqual(['99497', '99498']);
  });

  it('skips SCRIPT and STYLE subtrees', () => {
    document.body.innerHTML = `
      <p>99497 visible</p>
      <script>const fake = 12345;</script>
      <style>.fake { content: "67890"; }</style>
    `;
    const out = extractCodes(document.body);
    expect(out.map((o) => o.code)).toEqual(['99497']);
  });

  it('skips aria-hidden subtrees', () => {
    document.body.innerHTML = `
      <p>visible 99497</p>
      <div aria-hidden="true">should not include 36415</div>
    `;
    const out = extractCodes(document.body);
    expect(out.map((o) => o.code)).toEqual(['99497']);
  });

  it('preserves first-appearance order', () => {
    document.body.innerHTML = `<p>99213 first</p><p>99497 second</p><p>36415 third</p>`;
    const out = extractCodes(document.body);
    expect(out.map((o) => o.code)).toEqual(['99213', '99497', '36415']);
  });

  it('returns [] for an empty document', () => {
    expect(extractCodes(document.body)).toEqual([]);
  });
});
