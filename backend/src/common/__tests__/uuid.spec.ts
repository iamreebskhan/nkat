import { isUuid, assertUuid } from '../uuid';

describe('isUuid', () => {
  it.each([
    '11111111-1111-4111-8111-111111111111',
    '00000000-0000-1000-8000-000000000000',
    'A1B2C3D4-E5F6-1789-9ABC-DEF012345678',
  ])('accepts %s', (s) => {
    expect(isUuid(s)).toBe(true);
  });

  it.each([
    '',
    'not-a-uuid',
    '11111111111111111111111111111111',
    '11111111-1111-1111-1111-111111111111', // version 1 in v field is fine, but variant 1 not 8/9/a/b
    '11111111-1111-6111-8111-111111111111', // version 6 not in 1-5
    "1'; DROP TABLE org;--",
    null,
    undefined,
    42,
  ])('rejects %p', (s) => {
    expect(isUuid(s as unknown)).toBe(false);
  });

  it('assertUuid throws with name', () => {
    expect(() => assertUuid('nope', 'orgId')).toThrow(/orgId is not a valid UUID/);
  });
});
