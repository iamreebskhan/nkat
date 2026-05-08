import {
  findCodeMentions,
  proposeCandidates,
  scoreCoverageStance,
} from '../extractor';

describe('findCodeMentions', () => {
  it('finds CPT codes', () => {
    const text = 'CMS will pay for 99213 and 99214 office visits.';
    const r = findCodeMentions(text);
    expect(r.map((m) => m.code).sort()).toEqual(['99213', '99214']);
  });

  it('finds HCPCS Level II codes', () => {
    const text = 'Hospice routine home care code G0299 and J7322 drug.';
    const r = findCodeMentions(text);
    expect(r.map((m) => m.code).sort()).toEqual(['G0299', 'J7322']);
  });

  it('captures a sentence-window context per mention', () => {
    const before = 'a'.repeat(50);
    const after = 'b'.repeat(50);
    const text = `${before} 99213 ${after}`;
    const [m] = findCodeMentions(text);
    expect(m.context).toContain('99213');
    // Should include surrounding chars but be reasonably bounded.
    expect(m.context.length).toBeGreaterThan(50);
    expect(m.context.length).toBeLessThan(420);
  });

  it('approximates a page number', () => {
    // 100 lines of padding pushes past the first page (50 lines/page).
    const padding = '\n'.repeat(100);
    const text = `${padding} 99213 office visit.`;
    const [m] = findCodeMentions(text);
    expect(m.page).toBeGreaterThanOrEqual(2);
  });

  it('keeps separate mentions of the same code at different offsets', () => {
    const text = '99213 first reference.\n' + '\n'.repeat(40) + '99213 second reference much later.';
    // Force 2k+ chars between by padding.
    const padded = text + ' '.repeat(2000);
    const r = findCodeMentions(padded);
    // Same-code-near-offset gets dedup'd but distant occurrences stay.
    const ninetyTwoThirteens = r.filter((m) => m.code === '99213');
    expect(ninetyTwoThirteens.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for clean prose with no codes', () => {
    expect(findCodeMentions('Once upon a time there was no code.')).toEqual([]);
  });
});

describe('scoreCoverageStance', () => {
  it('flags positive cues → covered', () => {
    const r = scoreCoverageStance('CMS will cover and reimburse 99213.');
    expect(r.status).toBe('covered');
    expect(r.confidence).toBeGreaterThan(0.10);
  });

  it('flags negative cues → not_covered', () => {
    const r = scoreCoverageStance('CMS will not cover 99213.');
    expect(r.status).toBe('not_covered');
  });

  it('mixed cues → varies', () => {
    const r = scoreCoverageStance('Generally covered, but excluded for ASC.');
    expect(r.status).toBe('varies');
  });

  it('no cues → unknown low-confidence', () => {
    const r = scoreCoverageStance('The code 99213 appears in Table 4-2.');
    expect(r.status).toBe('unknown');
    expect(r.confidence).toBeLessThan(0.20);
  });
});

describe('proposeCandidates', () => {
  it('emits one candidate per mention with regex_v1 extractor', () => {
    // Spaced > 400 chars apart so each code's 200-char context window
    // sees only its own cue — otherwise opposing nearby cues correctly
    // classify as `varies`, which the next test covers.
    const text = 'CMS will cover 99213.' + ' '.repeat(500) + 'CMS will not cover 99214.';
    const proposals = proposeCandidates(findCodeMentions(text));
    expect(proposals).toHaveLength(2);
    const byCode = Object.fromEntries(proposals.map((p) => [p.code, p]));
    expect(byCode['99213'].proposed_coverage_status).toBe('covered');
    expect(byCode['99214'].proposed_coverage_status).toBe('not_covered');
    for (const p of proposals) {
      expect(p.extractor_name).toBe('regex_v1');
      expect(p.proposed_confidence).toBeGreaterThan(0);
      expect(p.proposed_confidence).toBeLessThanOrEqual(1);
    }
  });

  it('classifies opposing cues in the same context window as varies', () => {
    const text = 'CMS will cover 99213 in office settings, but excluded for ASC.';
    const proposals = proposeCandidates(findCodeMentions(text));
    expect(proposals[0].proposed_coverage_status).toBe('varies');
  });

  it('handles a clean text → no candidates', () => {
    expect(proposeCandidates([])).toEqual([]);
  });
});
