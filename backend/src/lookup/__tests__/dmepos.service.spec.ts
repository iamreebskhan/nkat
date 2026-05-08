import {
  evaluateMasterListLine,
  type DmeMasterListEntry,
  type DmepostLine,
} from '../services/dmepos.service';

const entry = (over: Partial<DmeMasterListEntry> = {}): DmeMasterListEntry => ({
  code: 'E0470',
  requires_face_to_face: true,
  requires_prior_auth: true,
  requires_cmn: false,
  payment_threshold_dollar: null,
  source_release: 'CMS DMEPOS ML',
  source_url: 'https://example/master-list',
  ...over,
});

const line = (over: Partial<DmepostLine> = {}): DmepostLine => ({
  index: 0,
  code: 'E0470',
  modifiers: [],
  ...over,
});

describe('evaluateMasterListLine', () => {
  it('returns empty when entry is undefined (code not on master list)', () => {
    expect(evaluateMasterListLine(line(), undefined)).toEqual([]);
  });

  it('flags PA + F2F + KX-missing for a typical Master List entry', () => {
    const out = evaluateMasterListLine(line(), entry());
    const kinds = out.map((i) => i.kind);
    expect(kinds).toContain('master_list_pa_required');
    expect(kinds).toContain('master_list_face_to_face_required');
    expect(kinds).toContain('kx_modifier_missing');
  });

  it('does not flag KX-missing when KX is present', () => {
    const out = evaluateMasterListLine(line({ modifiers: ['KX'] }), entry());
    expect(out.map((i) => i.kind)).not.toContain('kx_modifier_missing');
  });

  it('flags CMN required when entry.requires_cmn=true', () => {
    const out = evaluateMasterListLine(line(), entry({ requires_cmn: true }));
    expect(out.map((i) => i.kind)).toContain('master_list_cmn_required');
  });

  it('skips PA / F2F / KX when below the dollar threshold (only emits below_threshold)', () => {
    const out = evaluateMasterListLine(
      line({ billed_amount: 100 }),
      entry({ payment_threshold_dollar: 1500 }),
    );
    expect(out.map((i) => i.kind)).toEqual(['master_list_below_threshold']);
  });

  it('still flags PA / F2F when at or above threshold', () => {
    const out = evaluateMasterListLine(
      line({ billed_amount: 1600 }),
      entry({ payment_threshold_dollar: 1500 }),
    );
    expect(out.map((i) => i.kind)).toEqual(
      expect.arrayContaining(['master_list_pa_required', 'master_list_face_to_face_required']),
    );
    expect(out.map((i) => i.kind)).not.toContain('master_list_below_threshold');
  });

  it('flags rental/purchase modifier conflict when NU + RR are both present', () => {
    const out = evaluateMasterListLine(line({ modifiers: ['NU', 'RR'] }), entry());
    expect(out.map((i) => i.kind)).toContain('rental_purchase_modifier_conflict');
  });

  it('does not flag conflict when only RR is present', () => {
    const out = evaluateMasterListLine(line({ modifiers: ['RR', 'KX'] }), entry());
    expect(out.map((i) => i.kind)).not.toContain('rental_purchase_modifier_conflict');
  });

  it('does not require KX when entry only requires PA (no F2F, no CMN)', () => {
    const out = evaluateMasterListLine(
      line(),
      entry({ requires_face_to_face: false, requires_cmn: false }),
    );
    expect(out.map((i) => i.kind)).toContain('master_list_pa_required');
    expect(out.map((i) => i.kind)).not.toContain('kx_modifier_missing');
  });

  it('preserves source_url on every issue', () => {
    const out = evaluateMasterListLine(line(), entry());
    for (const issue of out.filter((i) => i.kind !== 'rental_purchase_modifier_conflict')) {
      expect(issue.source_url).toBe('https://example/master-list');
    }
  });

  it('treats unknown billed_amount as threshold-met (no below_threshold flag)', () => {
    const out = evaluateMasterListLine(line(), entry({ payment_threshold_dollar: 5000 }));
    expect(out.map((i) => i.kind)).not.toContain('master_list_below_threshold');
    expect(out.map((i) => i.kind)).toContain('master_list_pa_required');
  });
});
