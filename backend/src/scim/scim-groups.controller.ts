/**
 * SCIM 2.0 Groups resource (RFC 7644 § 3.5).
 *
 * SCIM "Groups" map to our `org_member.role` enum. We expose four
 * read-only groups per tenant — admin, reviewer, employee, consultant.
 * Members are the org_member rows whose role matches.
 *
 *   GET /scim/v2/Groups          — list all four groups
 *   GET /scim/v2/Groups/:id      — one group + its members
 *
 * We deliberately don't support POST/PATCH/DELETE on Groups: the role
 * set is fixed by our schema, not provisioned. Okta + Entra both
 * tolerate this — they detect via ServiceProviderConfig.
 */
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant } from '../database/rls-transaction';
import { ScimAuthGuard } from './scim-auth.guard';
import { SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA } from './scim-mapper';

const ROLES = ['admin', 'reviewer', 'employee', 'consultant'] as const;
type Role = (typeof ROLES)[number];

interface ScimGroupMember {
  value: string; // user id
  display?: string;
  type: 'User';
  $ref?: string;
}

interface ScimGroup {
  schemas: string[];
  id: string; // synthesized — `${role}@${orgId}` so it's stable
  displayName: string;
  members: ScimGroupMember[];
  meta: {
    resourceType: 'Group';
    location?: string;
  };
}

function groupId(orgId: string, role: Role): string {
  return `${role}@${orgId}`;
}

function parseGroupId(id: string): { orgId: string; role: Role } | null {
  const m = id.match(/^(admin|reviewer|employee|consultant)@([0-9a-f-]{36})$/i);
  if (!m) return null;
  return { role: m[1].toLowerCase() as Role, orgId: m[2].toLowerCase() };
}

@ApiExcludeController()
@Controller('scim/v2/Groups')
@UseGuards(ScimAuthGuard)
export class ScimGroupsController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  async list(@Req() req: Request, @Query('count') count?: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const limit = Math.min(200, Math.max(0, parseInt(count ?? '100', 10) || 100));
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      // One bulk query, then partition by role in JS.
      const rows = await tx
        .selectFrom('org_member as m')
        .innerJoin('app_user as u', 'u.id', 'm.user_id')
        .select(['u.id', 'u.email', 'u.full_name', 'm.role', 'm.status'])
        .where('m.org_id', '=', orgId)
        .where('m.status', 'in', ['active', 'invited'])
        .execute();
      const groups: ScimGroup[] = ROLES.map((role) => ({
        schemas: [SCIM_GROUP_SCHEMA],
        id: groupId(orgId, role),
        displayName: role,
        members: rows
          .filter((r) => r.role === role)
          .slice(0, limit)
          .map((r) => ({
            value: r.id,
            display: r.full_name ?? r.email,
            type: 'User',
          })),
        meta: { resourceType: 'Group' },
      }));
      return {
        schemas: [SCIM_LIST_SCHEMA],
        totalResults: groups.length,
        startIndex: 1,
        itemsPerPage: groups.length,
        Resources: groups,
      };
    });
  }

  @Get(':id')
  async one(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const parsed = parseGroupId(id);
    if (!parsed || parsed.orgId !== orgId.toLowerCase()) {
      throw new NotFoundException({ status: '404', detail: 'Group not found' });
    }
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const rows = await tx
        .selectFrom('org_member as m')
        .innerJoin('app_user as u', 'u.id', 'm.user_id')
        .select(['u.id', 'u.email', 'u.full_name', 'm.status'])
        .where('m.org_id', '=', orgId)
        .where('m.role', '=', parsed.role)
        .where('m.status', 'in', ['active', 'invited'])
        .execute();
      const group: ScimGroup = {
        schemas: [SCIM_GROUP_SCHEMA],
        id: groupId(orgId, parsed.role),
        displayName: parsed.role,
        members: rows.map((r) => ({
          value: r.id,
          display: r.full_name ?? r.email,
          type: 'User',
        })),
        meta: { resourceType: 'Group' },
      };
      return group;
    });
  }
}
