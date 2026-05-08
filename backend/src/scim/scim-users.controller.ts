/**
 * SCIM 2.0 Users resource (RFC 7644 § 3.4).
 *
 *   GET    /scim/v2/Users
 *   GET    /scim/v2/Users/:id
 *   POST   /scim/v2/Users
 *   PATCH  /scim/v2/Users/:id
 *   PUT    /scim/v2/Users/:id
 *   DELETE /scim/v2/Users/:id
 *
 * Notes:
 * - Users are app_user rows joined to org_member for the calling
 *   tenant. A user may belong to multiple orgs; via SCIM each tenant
 *   sees only its own membership.
 * - DELETE deactivates (status='removed' on org_member); the
 *   underlying app_user row survives for cross-tenant integrity.
 * - PUT replaces the SCIM-mutable subset; non-SCIM fields (mfa, etc.)
 *   are untouched.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { sql } from 'kysely';
import { ApiExcludeController } from '@nestjs/swagger';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';
import { assertUuid } from '../common/uuid';
import { ScimAuthGuard } from './scim-auth.guard';
import {
  applyPatchOps,
  fromScimCreate,
  parseScimFilter,
  SCIM_LIST_SCHEMA,
  toScimUser,
  type InternalUser,
  type Role,
} from './scim-mapper';

interface ListQuery {
  startIndex?: string;
  count?: string;
  filter?: string;
}

@ApiExcludeController()
@Controller('scim/v2/Users')
@UseGuards(ScimAuthGuard)
export class ScimUsersController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  async list(@Req() req: Request, @Query() q: ListQuery) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const startIndex = Math.max(1, parseInt(q.startIndex ?? '1', 10) || 1);
    const count = Math.min(200, Math.max(0, parseInt(q.count ?? '100', 10) || 100));
    const parsed = parseScimFilter(q.filter);
    if (q.filter && !parsed) {
      throw new BadRequestException({ scimType: 'invalidFilter' });
    }
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      let baseQ = tx
        .selectFrom('org_member as m')
        .innerJoin('app_user as u', 'u.id', 'm.user_id')
        .select([
          'u.id', 'u.email', 'u.full_name', 'u.created_at', 'u.last_login_at',
          'm.role', 'm.status',
        ])
        .where('m.org_id', '=', orgId);

      if (parsed) {
        if (parsed.field === 'userName' && typeof parsed.value === 'string') {
          baseQ = baseQ.where('u.email', '=', parsed.value);
        } else if (parsed.field === 'active' && typeof parsed.value === 'boolean') {
          if (parsed.value) {
            baseQ = baseQ.where('m.status', 'in', ['active', 'invited']);
          } else {
            baseQ = baseQ.where('m.status', 'in', ['suspended', 'removed']);
          }
        } else if (parsed.field === 'externalId' && typeof parsed.value === 'string') {
          // We don't store externalId; treat as userName fallback.
          baseQ = baseQ.where('u.email', '=', parsed.value);
        }
      }

      const total = await baseQ
        .clearSelect()
        .select(({ fn }) => fn.count<number>('u.id').as('n'))
        .executeTakeFirst();
      const rows = await baseQ
        .orderBy('u.created_at', 'asc')
        .limit(count)
        .offset(startIndex - 1)
        .execute();

      return {
        schemas: [SCIM_LIST_SCHEMA],
        totalResults: Number(total?.n ?? 0),
        startIndex,
        itemsPerPage: rows.length,
        Resources: rows.map((r) => toScimUser(asInternalUser(r))),
      };
    });
  }

  @Get(':id')
  async one(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(id, 'id');
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const r = await tx
        .selectFrom('org_member as m')
        .innerJoin('app_user as u', 'u.id', 'm.user_id')
        .select([
          'u.id', 'u.email', 'u.full_name', 'u.created_at', 'u.last_login_at',
          'm.role', 'm.status',
        ])
        .where('m.org_id', '=', orgId)
        .where('u.id', '=', id)
        .executeTakeFirst();
      if (!r) throw new NotFoundException({ status: '404', detail: 'User not found' });
      return toScimUser(asInternalUser(r));
    });
  }

  @Post()
  @HttpCode(201)
  async create(@Req() req: Request, @Body() body: unknown) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const parsed = fromScimCreate(body as Parameters<typeof fromScimCreate>[0]);
    if (!parsed) throw new BadRequestException({ scimType: 'invalidValue' });

    return runWithTenant(this.db, orgId, async (tx) => {
      // Reuse an existing app_user if email matches; otherwise create.
      let user = await tx
        .selectFrom('app_user')
        .select(['id', 'email', 'full_name', 'created_at', 'last_login_at'])
        .where('email', '=', parsed.email)
        .executeTakeFirst();
      if (!user) {
        user = await tx
          .insertInto('app_user')
          .values({
            email: parsed.email,
            full_name: parsed.full_name,
            password_hash: null,
            mfa_secret: null,
            mfa_enrolled_at: null,
            status: 'active',
          })
          .returning(['id', 'email', 'full_name', 'created_at', 'last_login_at'])
          .executeTakeFirstOrThrow();
      }

      // Refuse if already a member of this org.
      const existing = await tx
        .selectFrom('org_member')
        .select('user_id')
        .where('org_id', '=', orgId)
        .where('user_id', '=', user.id)
        .executeTakeFirst();
      if (existing) {
        throw new BadRequestException({ scimType: 'uniqueness', detail: 'already a member' });
      }

      await tx
        .insertInto('org_member')
        .values({
          org_id: orgId,
          user_id: user.id,
          role: parsed.role,
          status: parsed.active ? 'active' : 'suspended',
        })
        .execute();

      return toScimUser({
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        status: parsed.active ? 'active' : 'suspended',
        role: parsed.role,
        created_at: user.created_at,
        last_login_at: user.last_login_at,
      });
    });
  }

  @Patch(':id')
  async patch(@Req() req: Request, @Param('id') id: string, @Body() body: { Operations?: unknown[] }) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(id, 'id');
    const ops = Array.isArray(body?.Operations) ? body.Operations : [];
    const updates = applyPatchOps(ops as Parameters<typeof applyPatchOps>[0]);
    return this.applyUpdates(orgId, id, updates);
  }

  @Put(':id')
  async put(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(id, 'id');
    const parsed = fromScimCreate(body as Parameters<typeof fromScimCreate>[0]);
    if (!parsed) throw new BadRequestException({ scimType: 'invalidValue' });
    return this.applyUpdates(orgId, id, {
      email: parsed.email,
      full_name: parsed.full_name,
      active: parsed.active,
      role: parsed.role,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    assertUuid(id, 'id');
    return runWithTenant(this.db, orgId, async (tx) => {
      const r = await tx
        .updateTable('org_member')
        .set({ status: 'removed' })
        .where('org_id', '=', orgId)
        .where('user_id', '=', id)
        .returning('user_id')
        .executeTakeFirst();
      if (!r) throw new NotFoundException({ status: '404', detail: 'User not found' });
      return undefined as unknown as void;
    });
  }

  private async applyUpdates(
    orgId: string,
    userId: string,
    u: { email?: string; full_name?: string | null; active?: boolean; role?: Role },
  ) {
    return runWithTenant(this.db, orgId, async (tx) => {
      const existing = await tx
        .selectFrom('org_member as m')
        .innerJoin('app_user as a', 'a.id', 'm.user_id')
        .select([
          'a.id', 'a.email', 'a.full_name', 'a.created_at', 'a.last_login_at',
          'm.role', 'm.status',
        ])
        .where('m.org_id', '=', orgId)
        .where('a.id', '=', userId)
        .executeTakeFirst();
      if (!existing) throw new NotFoundException({ status: '404' });

      // Update app_user fields (email, full_name) when provided.
      const userUpdates: Record<string, unknown> = {};
      if (u.email && u.email !== existing.email) userUpdates.email = u.email;
      if (u.full_name !== undefined && u.full_name !== existing.full_name) {
        userUpdates.full_name = u.full_name;
      }
      if (Object.keys(userUpdates).length > 0) {
        await tx.updateTable('app_user').set(userUpdates).where('id', '=', userId).execute();
      }

      // Update org_member fields (role, status).
      const memberUpdates: Record<string, unknown> = {};
      if (u.role && u.role !== existing.role) memberUpdates.role = u.role;
      if (u.active !== undefined) {
        const newStatus = u.active ? 'active' : 'suspended';
        if (newStatus !== existing.status) memberUpdates.status = newStatus;
      }
      if (Object.keys(memberUpdates).length > 0) {
        await tx
          .updateTable('org_member')
          .set(memberUpdates)
          .where('org_id', '=', orgId)
          .where('user_id', '=', userId)
          .execute();
      }

      const fresh = await tx
        .selectFrom('org_member as m')
        .innerJoin('app_user as a', 'a.id', 'm.user_id')
        .select([
          'a.id', 'a.email', 'a.full_name', 'a.created_at', 'a.last_login_at',
          'm.role', 'm.status',
        ])
        .where('m.org_id', '=', orgId)
        .where('a.id', '=', userId)
        .executeTakeFirstOrThrow();
      return toScimUser(asInternalUser(fresh));
    });
  }
}

// avoid 'sql' unused warning; reserved for future filter rewrites.
void sql;

function asInternalUser(row: {
  id: string;
  email: string;
  full_name: string | null;
  status: string;
  role: string;
  created_at: Date;
  last_login_at: Date | null;
}): InternalUser {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    status: row.status as InternalUser['status'],
    role: row.role as Role,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}
