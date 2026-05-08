import { AMA_PLACEHOLDER, gateAmaDescriptors } from '../code.service';

const cptRow = {
  code: '99213',
  code_system: 'CPT' as const,
  short_descriptor: 'Office visit, established patient, low MDM',
  category: 'E/M',
  effective_date: new Date('2026-01-01T00:00:00Z'),
  expiration_date: null,
};

const hcpcsRow = {
  code: 'G0299',
  code_system: 'HCPCS2' as const,
  short_descriptor: 'Direct skilled nursing services in home',
  category: 'Hospice',
  effective_date: new Date('2026-01-01T00:00:00Z'),
  expiration_date: null,
};

describe('gateAmaDescriptors', () => {
  it('passes CPT descriptors through when license is present', () => {
    const [v] = gateAmaDescriptors([cptRow], true);
    expect(v.short_descriptor).toBe(cptRow.short_descriptor);
    expect(v.ama_descriptor_redacted).toBe(false);
  });

  it('redacts CPT descriptors when license is absent', () => {
    const [v] = gateAmaDescriptors([cptRow], false);
    expect(v.short_descriptor).toBe(AMA_PLACEHOLDER);
    expect(v.ama_descriptor_redacted).toBe(true);
    // Code itself is still returned — downstream rule lookup keeps working.
    expect(v.code).toBe('99213');
  });

  it('NEVER redacts HCPCS Level II descriptors (CMS public domain)', () => {
    const [withLicense] = gateAmaDescriptors([hcpcsRow], true);
    const [withoutLicense] = gateAmaDescriptors([hcpcsRow], false);
    expect(withLicense.short_descriptor).toBe(hcpcsRow.short_descriptor);
    expect(withoutLicense.short_descriptor).toBe(hcpcsRow.short_descriptor);
    expect(withoutLicense.ama_descriptor_redacted).toBe(false);
  });

  it('serializes dates as ISO YYYY-MM-DD strings', () => {
    const [v] = gateAmaDescriptors([cptRow], true);
    expect(v.effective_date).toBe('2026-01-01');
    expect(v.expiration_date).toBeNull();
    const expired = { ...cptRow, expiration_date: new Date('2026-12-31T00:00:00Z') };
    const [v2] = gateAmaDescriptors([expired], true);
    expect(v2.expiration_date).toBe('2026-12-31');
  });

  it('handles an empty input', () => {
    expect(gateAmaDescriptors([], true)).toEqual([]);
    expect(gateAmaDescriptors([], false)).toEqual([]);
  });
});
