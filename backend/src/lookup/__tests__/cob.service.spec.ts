import { payerTypeToCoverageType } from '../services/cob.service';

describe('payerTypeToCoverageType', () => {
  it.each([
    ['medicare_mac', 'medicare'],
    ['medicare_advantage_org', 'medicare'],
    ['medicaid_state', 'medicaid'],
    ['medicaid_mco', 'medicaid'],
    ['commercial', 'commercial'],
    ['tpa', 'commercial'],
    ['workers_comp', 'workers_comp'],
    ['auto_no_fault', 'auto_no_fault'],
    ['tribal', 'tribal'],
    ['self_insured', 'self_insured'],
    ['other', null],
  ] as const)('maps payer_type %s to coverage type %s', (pt, expected) => {
    expect(payerTypeToCoverageType(pt)).toBe(expected);
  });
});
