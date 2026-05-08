/**
 * Admin surface for SCIM bearer-token lifecycle.
 *
 *   GET    /v1/admin/scim/tokens         — list this tenant's tokens
 *   POST   /v1/admin/scim/tokens         — create (returns plaintext ONCE)
 *   DELETE /v1/admin/scim/tokens/:id     — revoke
 */
import { randomBytes, createHash } from 'node:crypto';
import {
  Body, Controller, Delete, Get, Inject, NotFoundException, Param,
  Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';

class CreateTokenDto {
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsDateString() expires_at?: string;
}

@ApiTags('admin')
@Controller('v1/admin/scim/tokens')
@UseGuards(AuthGuard)
export class ScimTokenController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: 'List SCIM bearer tokens for the calling tenant (no plaintext).' })
  async list(@Req() req: Request) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      const rows = await tx
        .selectFrom('scim_token')
        .select([
          'id', 'display_suffix', 'description', 'expires_at',
          'revoked_at', 'last_used_at', 'created_at',
        ])
        .where('org_id', '=', orgId)
        .orderBy('created_at', 'desc')
        .execute();
      return { items: rows };
    });
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new SCIM bearer token. The plaintext is returned ONCE; store it now.',
  })
  async create(@Req() req: Request, @Body() body: CreateTokenDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = assertUuid(req.auth?.userId, 'userId');

    // 32 random bytes → 64 hex chars. Plenty of entropy.
    const plaintext = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(plaintext).digest('hex');
    const suffix = plaintext.slice(-8);

    return runWithTenant(this.db, orgId, async (tx) => {
      const inserted = await tx
        .insertInto('scim_token')
        .values({
          org_id: orgId,
          token_hash: hash,
          display_suffix: suffix,
          description: body.description ?? null,
          created_by_user_id: userId,
          expires_at: body.expires_at ? new Date(body.expires_at) : null,
        })
        .returning(['id', 'display_suffix', 'created_at', 'expires_at'])
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'scim_token.create',
          target_type: 'scim_token',
          target_id: inserted.id,
          payload: { display_suffix: suffix },
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();

      return {
        id: inserted.id,
        token: plaintext, // ← shown ONCE
        display_suffix: suffix,
        created_at: inserted.created_at,
        expires_at: inserted.expires_at,
      };
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke a SCIM bearer token.' })
  async revoke(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = assertUuid(req.auth?.userId, 'userId');
    assertUuid(id, 'id');
    return runWithTenant(this.db, orgId, async (tx) => {
      const r = await tx
        .updateTable('scim_token')
        .set({ revoked_at: sql`now()` })
        .where('id', '=', id)
        .where('org_id', '=', orgId)
        .where('revoked_at', 'is', null)
        .returning(['id', 'display_suffix'])
        .executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'TOKEN_NOT_FOUND' });
      await tx
        .insertInto('audit_log')
        .values({
          org_id: orgId,
          user_id: userId,
          action: 'scim_token.revoke',
          target_type: 'scim_token',
          target_id: id,
          payload: { display_suffix: r.display_suffix },
          ip_address: (req.ip ?? null) as string | null,
          user_agent: (req.headers['user-agent'] as string | undefined) ?? null,
        })
        .execute();
      return { ok: true };
    });
  }
}
