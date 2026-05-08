import { isSelfServeTier, resolvePriceId, SELF_SERVE_TIERS } from '../price-catalog';

describe('price-catalog', () => {
  it('returns the env-mapped price id per tier', () => {
    const env = {
      STRIPE_PRICE_SOLO: 'price_solo',
      STRIPE_PRICE_TEAM: 'price_team',
      STRIPE_PRICE_ORG: 'price_org',
      STRIPE_PRICE_ENTERPRISE: 'price_ent',
    } as unknown as NodeJS.ProcessEnv;
    expect(resolvePriceId('solo', env)).toBe('price_solo');
    expect(resolvePriceId('team', env)).toBe('price_team');
    expect(resolvePriceId('org', env)).toBe('price_org');
    expect(resolvePriceId('enterprise', env)).toBe('price_ent');
  });

  it('returns null when the env var is unset', () => {
    expect(resolvePriceId('team', {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('Enterprise is not self-serve checkoutable', () => {
    expect(SELF_SERVE_TIERS).toEqual(['solo', 'team', 'org']);
    expect(isSelfServeTier('enterprise')).toBe(false);
    expect(isSelfServeTier('org')).toBe(true);
  });
});
