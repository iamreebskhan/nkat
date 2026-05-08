import {
  applyPatchOps,
  fromScimCreate,
  parseScimFilter,
  toScimUser,
  type InternalUser,
} from '../scim-mapper';

const user: InternalUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alice@example.com',
  full_name: 'Alice Q. Smith',
  status: 'active',
  role: 'admin',
  created_at: new Date('2026-01-01T00:00:00Z'),
  last_login_at: new Date('2026-04-01T00:00:00Z'),
};

describe('toScimUser', () => {
  it('emits the SCIM core schema + meta', () => {
    const s = toScimUser(user);
    expect(s.schemas).toEqual(['urn:ietf:params:scim:schemas:core:2.0:User']);
    expect(s.id).toBe(user.id);
    expect(s.userName).toBe('alice@example.com');
    expect(s.emails[0]).toEqual({ value: 'alice@example.com', primary: true, type: 'work' });
    expect(s.active).toBe(true);
    expect(s.roles?.[0]).toEqual({ value: 'admin', primary: true });
    expect(s.meta.resourceType).toBe('User');
    expect(s.meta.created).toBe('2026-01-01T00:00:00.000Z');
  });

  it('emits given/family from a "First Last" full_name', () => {
    const s = toScimUser({ ...user, full_name: 'Alice Smith' });
    expect(s.name?.givenName).toBe('Alice');
    expect(s.name?.familyName).toBe('Smith');
    expect(s.name?.formatted).toBe('Alice Smith');
  });

  it('marks suspended/removed members inactive', () => {
    expect(toScimUser({ ...user, status: 'suspended' }).active).toBe(false);
    expect(toScimUser({ ...user, status: 'removed' }).active).toBe(false);
    expect(toScimUser({ ...user, status: 'invited' }).active).toBe(true);
  });

  it('attaches a location URL when baseUrl supplied', () => {
    const s = toScimUser(user, 'https://api.example.com');
    expect(s.meta.location).toBe(`https://api.example.com/scim/v2/Users/${user.id}`);
  });
});

describe('fromScimCreate', () => {
  it('extracts userName + name + role', () => {
    const r = fromScimCreate({
      userName: 'bob@example.com',
      name: { formatted: 'Bob Jones' },
      roles: [{ value: 'reviewer' }],
      active: true,
    });
    expect(r).toEqual({ email: 'bob@example.com', full_name: 'Bob Jones', active: true, role: 'reviewer' });
  });

  it('falls back to first email when userName missing', () => {
    const r = fromScimCreate({
      userName: '',
      emails: [{ value: 'eve@example.com', primary: true }],
    });
    expect(r?.email).toBe('eve@example.com');
  });

  it('rejects when no email anywhere', () => {
    expect(fromScimCreate({ userName: '' })).toBeNull();
  });

  it('coerces unknown roles to employee', () => {
    expect(fromScimCreate({ userName: 'x@y.com', roles: [{ value: 'hacker' }] })?.role)
      .toBe('employee');
  });

  it('treats active=false', () => {
    expect(fromScimCreate({ userName: 'x@y.com', active: false })?.active).toBe(false);
  });
});

describe('applyPatchOps', () => {
  it('toggles active via path=active', () => {
    expect(applyPatchOps([{ op: 'replace', path: 'active', value: false }])).toEqual({ active: false });
  });

  it('replaces userName + displayName', () => {
    const u = applyPatchOps([
      { op: 'replace', path: 'userName', value: 'new@x.com' },
      { op: 'replace', path: 'displayName', value: 'New Name' },
    ]);
    expect(u).toEqual({ email: 'new@x.com', full_name: 'New Name' });
  });

  it('handles bulk-replace value object (Okta style)', () => {
    const u = applyPatchOps([
      { op: 'replace', value: { active: false, userName: 'q@x.com' } },
    ]);
    expect(u).toEqual({ active: false, email: 'q@x.com' });
  });

  it('handles roles array path', () => {
    const u = applyPatchOps([
      { op: 'replace', path: 'roles[primary eq true].value', value: 'admin' },
    ]);
    expect(u).toEqual({ role: 'admin' });
  });

  it('ignores unknown paths', () => {
    expect(applyPatchOps([{ op: 'replace', path: 'unknown.thing', value: 'x' }])).toEqual({});
  });

  it('ignores non-replace/add ops', () => {
    expect(applyPatchOps([{ op: 'remove', path: 'active' }])).toEqual({});
  });
});

describe('parseScimFilter', () => {
  it('parses userName eq "x"', () => {
    expect(parseScimFilter('userName eq "alice@example.com"'))
      .toEqual({ field: 'userName', op: 'eq', value: 'alice@example.com' });
  });

  it('parses active eq true', () => {
    expect(parseScimFilter('active eq true')).toEqual({ field: 'active', op: 'eq', value: true });
    expect(parseScimFilter('active eq false')).toEqual({ field: 'active', op: 'eq', value: false });
  });

  it('returns null on unsupported filter', () => {
    expect(parseScimFilter('userName co "alice"')).toBeNull();
  });

  it('returns null on missing filter', () => {
    expect(parseScimFilter(undefined)).toBeNull();
  });
});
