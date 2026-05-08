import {
  validateModifierSet,
  type ModifierRecord,
  type ModifierRelationshipRecord,
} from '../services/modifier.service';

const T = (date: string) => new Date(`${date}T00:00:00Z`);

const modifiers: ModifierRecord[] = [
  { modifier: '25', description: 'E/M same day', modifier_type: 'distinct_service', payer_applicability: [], effective_date: T('1992-01-01'), expiration_date: null },
  { modifier: '59', description: 'Distinct service fallback', modifier_type: 'distinct_service', payer_applicability: [], effective_date: T('1996-01-01'), expiration_date: null },
  { modifier: 'XE', description: 'Separate encounter', modifier_type: 'distinct_service', payer_applicability: [], effective_date: T('2015-01-01'), expiration_date: null },
  { modifier: 'XU', description: 'Unusual non-overlapping', modifier_type: 'distinct_service', payer_applicability: [], effective_date: T('2015-01-01'), expiration_date: null },
  { modifier: '95', description: 'Sync A/V telemed', modifier_type: 'telehealth', payer_applicability: [], effective_date: T('2017-01-01'), expiration_date: null },
  { modifier: 'GT', description: 'Legacy A/V', modifier_type: 'telehealth', payer_applicability: ['Medicare'], effective_date: T('1999-01-01'), expiration_date: null },
  { modifier: 'JW', description: 'Wastage', modifier_type: 'drug', payer_applicability: [], effective_date: T('2017-01-01'), expiration_date: null },
  { modifier: 'JZ', description: 'No wastage', modifier_type: 'drug', payer_applicability: ['Medicare'], effective_date: T('2023-07-01'), expiration_date: null },
  { modifier: 'GA', description: 'Signed ABN', modifier_type: 'abn', payer_applicability: ['Medicare'], effective_date: T('2002-01-01'), expiration_date: null },
  { modifier: 'GZ', description: 'Expected denial no ABN', modifier_type: 'abn', payer_applicability: ['Medicare'], effective_date: T('2002-01-01'), expiration_date: null },
];

const relationships: ModifierRelationshipRecord[] = [
  { modifier_a: 'XE', modifier_b: '59', relationship_type: 'preferred_over', rationale: 'CMS prefers specific X-modifier', source_url: 'https://example/ncci' },
  { modifier_a: 'XU', modifier_b: '59', relationship_type: 'preferred_over', rationale: null, source_url: null },
  { modifier_a: '59', modifier_b: 'XE', relationship_type: 'mutually_exclusive', rationale: 'Never combine 59 with X-modifier', source_url: null },
  { modifier_a: '59', modifier_b: 'XU', relationship_type: 'mutually_exclusive', rationale: null, source_url: null },
  { modifier_a: 'JW', modifier_b: 'JZ', relationship_type: 'mutually_exclusive', rationale: 'Wastage vs no-wastage', source_url: null },
  { modifier_a: 'GA', modifier_b: 'GZ', relationship_type: 'mutually_exclusive', rationale: null, source_url: null },
];

describe('validateModifierSet', () => {
  const dos = T('2026-04-15');

  it('passes a clean modifier set', () => {
    const issues = validateModifierSet(
      { modifiers: ['25', '95'], payer_type: 'Commercial', dos },
      modifiers,
      relationships,
    );
    expect(issues).toHaveLength(0);
  });

  it('flags an unknown modifier', () => {
    const issues = validateModifierSet(
      { modifiers: ['ZZ'], payer_type: 'Commercial', dos },
      modifiers,
      relationships,
    );
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'unknown_modifier', modifiers: ['ZZ'] }),
    ]);
  });

  it('flags 59 + XE as mutually exclusive AND surfaces preferred-alternative', () => {
    const issues = validateModifierSet(
      { modifiers: ['59', 'XE'], payer_type: 'Commercial', dos },
      modifiers,
      relationships,
    );
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain('mutually_exclusive');
    expect(kinds).toContain('preferred_alternative');
  });

  it('flags 59 + XU as mutually exclusive', () => {
    const issues = validateModifierSet(
      { modifiers: ['59', 'XU'], payer_type: 'Commercial', dos },
      modifiers,
      relationships,
    );
    expect(issues.some((i) => i.kind === 'mutually_exclusive')).toBe(true);
  });

  it('flags JW + JZ as mutually exclusive', () => {
    const issues = validateModifierSet(
      { modifiers: ['JW', 'JZ'], payer_type: 'Medicare', dos },
      modifiers,
      relationships,
    );
    expect(issues.some((i) => i.kind === 'mutually_exclusive' && i.modifiers.includes('JW') && i.modifiers.includes('JZ'))).toBe(true);
  });

  it('flags GA + GZ as mutually exclusive', () => {
    const issues = validateModifierSet(
      { modifiers: ['GA', 'GZ'], payer_type: 'Medicare', dos },
      modifiers,
      relationships,
    );
    expect(issues.some((i) => i.kind === 'mutually_exclusive')).toBe(true);
  });

  it('flags GT used on a non-Medicare payer (payer_inapplicable)', () => {
    const issues = validateModifierSet(
      { modifiers: ['GT'], payer_type: 'Commercial', dos },
      modifiers,
      relationships,
    );
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'payer_inapplicable', modifiers: ['GT'] }),
    ]);
  });

  it('flags JZ before its 2023-07-01 effective date', () => {
    const issues = validateModifierSet(
      { modifiers: ['JZ'], payer_type: 'Medicare', dos: T('2023-06-01') },
      modifiers,
      relationships,
    );
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'expired_modifier' }),
    ]);
  });

  it('does not double-flag XE alone (no rule fires)', () => {
    const issues = validateModifierSet(
      { modifiers: ['XE'], payer_type: 'Medicare', dos },
      modifiers,
      relationships,
    );
    expect(issues).toHaveLength(0);
  });

  it('preserves rationale and source_url on rule hits', () => {
    const issues = validateModifierSet(
      { modifiers: ['59', 'XE'], payer_type: 'Commercial', dos },
      modifiers,
      relationships,
    );
    const preferred = issues.find((i) => i.kind === 'preferred_alternative')!;
    expect(preferred.rationale).toMatch(/CMS prefers/);
    expect(preferred.source_url).toBe('https://example/ncci');
  });
});
