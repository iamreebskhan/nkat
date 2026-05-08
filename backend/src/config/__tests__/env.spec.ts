import { loadEnv } from '../env';

const baseEnv = {
  PGHOST: 'localhost',
  PGPORT: '5432',
  PGDATABASE: 'billing_rules',
  PGUSER: 'app',
  PGPASSWORD: 'pw',
};

describe('loadEnv', () => {
  it('parses a valid environment with sensible defaults', () => {
    const env = loadEnv(baseEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.PGSSLMODE).toBe('disable');
    expect(env.PG_POOL_MAX).toBe(10);
    expect(env.AUTH_MODE).toBe('dev_header');
  });

  it('coerces numeric strings', () => {
    const env = loadEnv({ ...baseEnv, PORT: '8080', PG_POOL_MAX: '25' });
    expect(env.PORT).toBe(8080);
    expect(env.PG_POOL_MAX).toBe(25);
  });

  it('rejects invalid NODE_ENV', () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'staging' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects missing required vars', () => {
    expect(() => loadEnv({})).toThrow(/PGHOST/);
  });

  it('rejects invalid LOG_LEVEL', () => {
    expect(() => loadEnv({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('accepts optional CMS license token', () => {
    const env = loadEnv({ ...baseEnv, CMS_COVERAGE_API_TOKEN: 'tok_abc123' });
    expect(env.CMS_COVERAGE_API_TOKEN).toBe('tok_abc123');
  });
});
