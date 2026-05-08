import { FeatureFlagService } from '../feature-flag.service';
import type { Db } from '../../database/db';

interface ScriptRow { enabled: boolean; config: Record<string, unknown> }
interface Script {
  tenantHit?: ScriptRow;
  globalHit?: ScriptRow;
}

function makeDb(script: Script): Db {
  // Two-stage select: first call is tenant lookup, second is global. We toggle
  // between them based on the .where('org_id', '=', X) vs ('is', null) call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    selectFrom: (_t: string) => {
      let mode: 'tenant' | 'global' = 'global';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        where: (col: string, op: string, _val: unknown) => {
          if (col === 'org_id' && op === '=') mode = 'tenant';
          if (col === 'org_id' && op === 'is') mode = 'global';
          return chain;
        },
        executeTakeFirst: async () =>
          mode === 'tenant' ? script.tenantHit : script.globalHit,
      };
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const ORG = '11111111-1111-4111-8111-111111111111';

describe('FeatureFlagService.resolve', () => {
  it('returns tenant override when present, even if global says false', async () => {
    const svc = new FeatureFlagService(
      makeDb({
        tenantHit: { enabled: true, config: { provider: 'bedrock' } },
        globalHit: { enabled: false, config: { provider: 'deterministic' } },
      }),
    );
    const r = await svc.resolve('synthesis.enabled', ORG);
    expect(r.enabled).toBe(true);
    expect(r.origin).toBe('tenant');
    expect(r.config).toEqual({ provider: 'bedrock' });
  });

  it('falls back to global default when tenant has no row', async () => {
    const svc = new FeatureFlagService(
      makeDb({ globalHit: { enabled: true, config: { x: 1 } } }),
    );
    const r = await svc.resolve('flag.x', ORG);
    expect(r.origin).toBe('global');
    expect(r.enabled).toBe(true);
  });

  it('returns disabled-default when neither tenant nor global has a row', async () => {
    const svc = new FeatureFlagService(makeDb({}));
    const r = await svc.resolve('flag.unknown');
    expect(r.enabled).toBe(false);
    expect(r.origin).toBe('default');
    expect(r.config).toEqual({});
  });

  it('isEnabled is a thin wrapper', async () => {
    const svc = new FeatureFlagService(makeDb({ globalHit: { enabled: true, config: {} } }));
    expect(await svc.isEnabled('flag.x')).toBe(true);
  });

  it('getConfig returns the config blob, defaulting to {} when missing', async () => {
    const svc = new FeatureFlagService(makeDb({}));
    expect(await svc.getConfig('flag.absent')).toEqual({});
  });

  it('treats missing tenant row + present global as global origin', async () => {
    const svc = new FeatureFlagService(
      makeDb({ globalHit: { enabled: false, config: { foo: 'bar' } } }),
    );
    const r = await svc.resolve('flag.x', ORG);
    expect(r.origin).toBe('global');
    expect(r.enabled).toBe(false);
    expect(r.config).toEqual({ foo: 'bar' });
  });
});
