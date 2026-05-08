import { Kysely } from 'kysely';
import { runWithTenant } from '../rls-transaction';
import type { Database } from '../schema.types';

describe('runWithTenant', () => {
  // We don't need a live DB for the input-validation behaviour. We pass a stub
  // Kysely whose .transaction() short-circuits — the call should never reach
  // it because the UUID guard fires first.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stubDb = {} as Kysely<Database>;

  it('rejects non-UUID org id without opening a transaction', async () => {
    await expect(
      runWithTenant(stubDb, 'not-a-uuid', async () => {
        throw new Error('should never run');
      }),
    ).rejects.toThrow(/orgId must be a UUID/);
  });

  it('rejects empty string', async () => {
    await expect(
      runWithTenant(stubDb, '', async () => {
        throw new Error('should never run');
      }),
    ).rejects.toThrow(/orgId must be a UUID/);
  });

  it('rejects SQL-injection-shaped strings', async () => {
    await expect(
      runWithTenant(stubDb, "11111111-1111-1111-1111-111111111111'; DROP TABLE org;--", async () => {
        throw new Error('should never run');
      }),
    ).rejects.toThrow(/orgId must be a UUID/);
  });
});
