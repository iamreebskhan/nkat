/**
 * Tenant client_company surface — read-only for now.
 *
 *   GET /v1/clients   — list this tenant's clients (id + display fields only)
 *
 * Used by the Reconciliation page's client picker. Doesn't expose the
 * `metadata` blob or `created_at` precise timestamp — keep the response
 * small and deterministic so the UI dropdown stays cheap to render.
 *
 * Tenant-scoped via runReadOnlyWithTenant. RLS hides cross-tenant rows.
 */
import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant } from '../database/rls-transaction';

interface ClientView {
  id: string;
  name: string;
  npi: string | null;
  primary_state: string | null;
  specialties: string[];
}

@ApiTags('clients')
@Controller('v1/clients')
@UseGuards(AuthGuard)
export class ClientsController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: "List the calling tenant's client companies (id + display fields)" })
  async list(@Req() req: Request): Promise<{ items: ClientView[] }> {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const rows = await tx
        .selectFrom('client_company')
        .select(['id', 'name', 'npi', 'primary_state', 'specialties'])
        .where('org_id', '=', orgId)
        .orderBy('name', 'asc')
        .execute();
      return { items: rows };
    });
  }
}
