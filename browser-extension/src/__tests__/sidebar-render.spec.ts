import { renderDetectedCodes, renderFindings, todayIso } from '../lib/sidebar-render';
import type { Finding, LookupResponse } from '../lib/api-client';

describe('todayIso', () => {
  it('returns YYYY-MM-DD', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('zero-pads month and day', () => {
    const fixed = new Date(Date.UTC(2026, 0, 5));
    expect(todayIso(fixed)).toBe('2026-01-05');
  });

  it('uses UTC date', () => {
    const newYear = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(todayIso(newYear)).toBe('2026-01-01');
  });
});

describe('renderDetectedCodes', () => {
  it('renders an <li> per code', () => {
    const ul = document.createElement('ul') as HTMLUListElement;
    renderDetectedCodes(ul, [
      { code: '99497', context: 'ACP first 30 min', code_system: 'CPT' },
      { code: 'J9035', context: 'Bevacizumab', code_system: 'HCPCS2' },
    ]);
    expect(ul.querySelectorAll('li')).toHaveLength(2);
    expect(ul.textContent).toContain('99497');
    expect(ul.textContent).toContain('J9035');
  });

  it('clears previous content on re-render', () => {
    const ul = document.createElement('ul') as HTMLUListElement;
    ul.innerHTML = '<li>old</li>';
    renderDetectedCodes(ul, []);
    expect(ul.querySelectorAll('li')).toHaveLength(0);
  });
});

describe('renderFindings', () => {
  const finding = (over: Partial<Finding> = {}): Finding => ({
    severity: 'critical',
    carc_class: 'bundled_97',
    title: 'NCCI bundling',
    detail: '99213 + 36415 are bundled',
    confidence: 1,
    citations: [
      { source_doc_id: 'd1', source_url: 'https://cms/ncci', retrieved_at: 'r' },
    ],
    recommendation: 'Drop 36415 or add an X-modifier.',
    ...over,
  });

  const baseResp = (over: Partial<LookupResponse> = {}): LookupResponse => ({
    request_id: 'r1',
    date_of_service: '2026-04-15',
    lines: [],
    cross_line_findings: [],
    overall_severity: 'ok',
    summary: '',
    ...over,
  });

  it('renders empty-state message when there are no findings', () => {
    const ol = document.createElement('ol');
    renderFindings(ol, baseResp());
    expect(ol.textContent).toMatch(/No findings/);
  });

  it('orders findings critical → warning → info → ok', () => {
    const ol = document.createElement('ol');
    renderFindings(
      ol,
      baseResp({
        cross_line_findings: [
          finding({ severity: 'ok',       title: 'A', detail: '' }),
          finding({ severity: 'critical', title: 'B', detail: '' }),
          finding({ severity: 'info',     title: 'C', detail: '' }),
          finding({ severity: 'warning',  title: 'D', detail: '' }),
        ],
      }),
    );
    const titles = Array.from(ol.querySelectorAll('li')).map((li) =>
      li.querySelector('header span')?.textContent ?? '',
    );
    expect(titles[0]).toContain('B');
    expect(titles[1]).toContain('D');
    expect(titles[2]).toContain('C');
    expect(titles[3]).toContain('A');
  });

  it('adds severity class to each li for CSS coloring', () => {
    const ol = document.createElement('ol');
    renderFindings(
      ol,
      baseResp({
        cross_line_findings: [finding({ severity: 'critical' }), finding({ severity: 'info' })],
      }),
    );
    const lis = ol.querySelectorAll('li');
    expect(lis[0].className).toContain('critical');
    expect(lis[1].className).toContain('info');
  });

  it('renders citation links with rel=noopener and target=_blank', () => {
    const ol = document.createElement('ol');
    renderFindings(ol, baseResp({ cross_line_findings: [finding()] }));
    const a = ol.querySelector('a')!;
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener noreferrer');
    expect(a.href).toBe('https://cms/ncci');
  });

  it('renders the recommendation paragraph when present', () => {
    const ol = document.createElement('ol');
    renderFindings(ol, baseResp({ cross_line_findings: [finding()] }));
    expect(ol.textContent).toContain('Recommendation:');
    expect(ol.textContent).toContain('Drop 36415');
  });

  it('renders confidence as 2-decimal string', () => {
    const ol = document.createElement('ol');
    renderFindings(ol, baseResp({ cross_line_findings: [finding({ confidence: 0.873 })] }));
    expect(ol.textContent).toContain('confidence 0.87');
  });
});
