/**
 * Mappers between our internal (`app_user`, `org_member`) shape and
 * the SCIM 2.0 `urn:ietf:params:scim:schemas:core:2.0:User` and
 * `Group` resource shapes (RFC 7643).
 *
 * Pure functions — DB I/O lives in the controller. Allows unit tests
 * to assert the SCIM JSON shape without touching Postgres.
 */
export type Role = 'employee' | 'reviewer' | 'admin' | 'consultant';
export type MemberStatus = 'invited' | 'active' | 'suspended' | 'removed';

export interface InternalUser {
  id: string;
  email: string;
  full_name: string | null;
  status: MemberStatus;
  role: Role;
  created_at: Date;
  last_login_at: Date | null;
}

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  emails: { value: string; primary: true; type: 'work' }[];
  active: boolean;
  meta: {
    resourceType: 'User';
    created: string;
    lastModified: string;
    location?: string;
  };
  // Custom enterprise extension — role.
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'?: {
    employeeNumber?: string;
    division?: string;
  };
  roles?: { value: Role; primary?: true }[];
}

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

/** Statuses that map to SCIM `active=true`. */
const ACTIVE_STATUSES: MemberStatus[] = ['invited', 'active'];

export function toScimUser(u: InternalUser, baseUrl?: string): ScimUser {
  const [givenName, ...rest] = (u.full_name ?? '').split(/\s+/);
  const familyName = rest.join(' ').trim();
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: u.id,
    userName: u.email,
    name: u.full_name
      ? {
          givenName: givenName || undefined,
          familyName: familyName || undefined,
          formatted: u.full_name,
        }
      : undefined,
    emails: [{ value: u.email, primary: true, type: 'work' }],
    active: ACTIVE_STATUSES.includes(u.status),
    roles: [{ value: u.role, primary: true }],
    meta: {
      resourceType: 'User',
      created: u.created_at.toISOString(),
      lastModified: (u.last_login_at ?? u.created_at).toISOString(),
      location: baseUrl ? `${baseUrl}/scim/v2/Users/${u.id}` : undefined,
    },
  };
}

export interface ScimUserCreate {
  userName: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  emails?: { value: string; primary?: boolean }[];
  active?: boolean;
  roles?: { value?: string }[];
}

/**
 * Map a SCIM POST/PUT body to our internal create-user input.
 * Returns null if the body is structurally invalid for SCIM.
 */
export interface CreateUserInput {
  email: string;
  full_name: string | null;
  active: boolean;
  role: Role;
}

export function fromScimCreate(body: ScimUserCreate): CreateUserInput | null {
  const email = body.userName?.trim() || body.emails?.[0]?.value?.trim();
  if (!email) return null;
  const full =
    body.name?.formatted?.trim() ||
    [body.name?.givenName, body.name?.familyName].filter(Boolean).join(' ').trim() ||
    null;
  const active = body.active !== false;
  const roleValue = (body.roles?.[0]?.value ?? 'employee').toLowerCase();
  const role = ['employee', 'reviewer', 'admin', 'consultant'].includes(roleValue)
    ? (roleValue as Role)
    : 'employee';
  return { email, full_name: full, active, role };
}

/**
 * Apply a SCIM PATCH operations list to an existing user — pure
 * function returning the updated state plus a list of side-effect
 * deltas the caller should persist.
 *
 * Supports the operation/path subset used by Okta + Entra:
 *   replace path=active        → toggle status
 *   replace path=name.formatted → full_name
 *   replace path=userName      → email
 *   replace path=roles[primary eq true].value → role
 */
export interface PatchOp {
  op: 'add' | 'replace' | 'remove' | string;
  path?: string;
  value?: unknown;
}

export interface UserUpdates {
  email?: string;
  full_name?: string | null;
  active?: boolean;
  role?: Role;
}

export function applyPatchOps(ops: PatchOp[]): UserUpdates {
  const u: UserUpdates = {};
  for (const op of ops) {
    if (op.op !== 'replace' && op.op !== 'add') continue;
    if (op.path === 'active' || op.path === 'urn:ietf:params:scim:schemas:core:2.0:User:active') {
      u.active = Boolean(op.value);
    } else if (op.path === 'userName') {
      if (typeof op.value === 'string') u.email = op.value.trim();
    } else if (op.path === 'name.formatted' || op.path === 'displayName') {
      u.full_name = typeof op.value === 'string' ? op.value : null;
    } else if (op.path === undefined && op.value && typeof op.value === 'object') {
      // Bulk-replace shape used by Okta: { op:'replace', value:{ active: true } }
      const v = op.value as Record<string, unknown>;
      if (typeof v.active === 'boolean') u.active = v.active;
      if (typeof v.userName === 'string') u.email = v.userName.trim();
      if (typeof v.displayName === 'string') u.full_name = v.displayName;
    } else if (op.path?.startsWith('roles')) {
      const v = (op.value as Array<{ value?: string }> | { value?: string } | string)
        ?? null;
      let role: string | undefined;
      if (typeof v === 'string') role = v;
      else if (Array.isArray(v)) role = v[0]?.value;
      else if (v && typeof v === 'object' && 'value' in v) role = (v as { value?: string }).value;
      if (role && ['employee', 'reviewer', 'admin', 'consultant'].includes(role.toLowerCase())) {
        u.role = role.toLowerCase() as Role;
      }
    }
  }
  return u;
}

/**
 * SCIM filter parsing. We only support the subset Okta + Entra ship:
 *   userName eq "alice@example.com"
 *   active eq true
 *   externalId eq "abc123"
 * Returns null when the filter shape is unsupported (caller returns 400).
 */
export interface ParsedFilter {
  field: 'userName' | 'active' | 'externalId';
  op: 'eq';
  value: string | boolean;
}

export function parseScimFilter(filter: string | undefined): ParsedFilter | null {
  if (!filter) return null;
  const m = filter.trim().match(/^(userName|active|externalId)\s+eq\s+(?:"([^"]*)"|(true|false))$/i);
  if (!m) return null;
  const field = m[1] as ParsedFilter['field'];
  const value = m[2] !== undefined ? m[2] : m[3] === 'true';
  return { field, op: 'eq', value };
}
