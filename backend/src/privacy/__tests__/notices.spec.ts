import { noticesForState, NOTICES } from '../notices';

describe('noticesForState', () => {
  it('returns WMHMDA + general for WA', () => {
    const ns = noticesForState('WA');
    const regimes = ns.map((n) => n.regime);
    expect(regimes).toContain('wmhmda');
    expect(regimes).toContain('general');
  });

  it('returns CCPA + AB 3030 + general for CA', () => {
    const ns = noticesForState('CA');
    const regimes = ns.map((n) => n.regime);
    expect(regimes).toContain('ccpa');
    expect(regimes).toContain('ab3030_ai');
    expect(regimes).toContain('general');
  });

  it('returns CO CPA + Colorado AI for CO', () => {
    const ns = noticesForState('co'); // case-insensitive
    const regimes = ns.map((n) => n.regime);
    expect(regimes).toContain('cpa_co');
    expect(regimes).toContain('sb24_205_ai_co');
  });

  it('returns only general for an unrecognized state', () => {
    const ns = noticesForState('PR');
    expect(ns).toHaveLength(1);
    expect(ns[0].regime).toBe('general');
  });

  it('every notice has a non-empty body and a version', () => {
    for (const n of NOTICES) {
      expect(n.body.length).toBeGreaterThan(20);
      expect(n.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(n.title.length).toBeGreaterThan(5);
    }
  });
});
