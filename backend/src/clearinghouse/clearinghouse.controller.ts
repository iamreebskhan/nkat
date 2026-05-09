/**
 * Per-tenant clearinghouse credential admin surface.
 *
 *   GET    /v1/admin/clearinghouse/credentials             — list (no plaintext)
 *   PUT    /v1/admin/clearinghouse/credentials/:clearinghouse  — upsert
 *   DELETE /v1/admin/clearinghouse/credentials/:id         — remove
 *   POST   /v1/admin/clearinghouse/credentials/:id/test    — verify the
 *                                                            credentials work
 *                                                            (mints a token)
 *
 * The list endpoint NEVER returns the plaintext credentials. Only the
 * display_suffix (last 4 chars of clientId / username) and metadata.
 *
 * The PUT body shape varies by clearinghouse — the controller doesn't
 * validate beyond a record-of-strings check; the AvailityClient (etc.)
 * will throw at first use if the shape is wrong.
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
  Post,
  Put,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid, isUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant } from '../database/rls-transaction';
import type { Clearinghouse } from '../database/schema.types';
import { AvailityClient, AvailityError } from './availity.client';
import { ChangeHealthcareClient, ClearinghouseError } from './change-healthcare.client';
import { WaystarClient } from './waystar.client';
import { ClearinghouseCredentialService } from './credential.service';

const CLEARINGHOUSES = ['availity', 'change_healthcare', 'waystar'] as const;

class UpsertDto {
  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

class ClearinghouseParam {
  @IsIn(CLEARINGHOUSES as unknown as string[])
  clearinghouse!: Clearinghouse;
}

@ApiTags('admin')
@Controller('v1/admin/clearinghouse/credentials')
@UseGuards(AuthGuard)
export class ClearinghouseCredentialController {
  constructor(
    private readonly svc: ClearinghouseCredentialService,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the calling tenant's clearinghouse credentials (no plaintext)" })
  async list(@Req() req: Request) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    if (!this.svc.isReady()) {
      throw new ServiceUnavailableException({ code: 'CRED_SERVICE_NOT_CONFIGURED' });
    }
    return { items: await this.svc.list(orgId) };
  }

  @Put(':clearinghouse')
  @ApiOperation({
    summary:
      'Upsert credentials for one clearinghouse. Plaintext is encrypted at rest with AES-256-GCM.',
  })
  async upsert(@Req() req: Request, @Param() params: ClearinghouseParam, @Body() body: UpsertDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = req.auth?.userId ?? null;
    if (!this.svc.isReady()) {
      throw new ServiceUnavailableException({ code: 'CRED_SERVICE_NOT_CONFIGURED' });
    }
    if (!isPlainPayload(body.payload)) {
      throw new BadRequestException({ code: 'PAYLOAD_MUST_BE_FLAT_STRINGS' });
    }
    return this.svc.set({
      orgId,
      userId,
      clearinghouse: params.clearinghouse,
      payload: body.payload,
      label: body.label ?? null,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a credential row.' })
  async remove(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const userId = req.auth?.userId ?? null;
    if (!isUuid(id)) throw new BadRequestException({ code: 'INVALID_ID' });
    const removed = await this.svc.remove(orgId, id, userId);
    if (!removed) throw new NotFoundException({ code: 'CREDENTIAL_NOT_FOUND' });
    return undefined as unknown as void;
  }

  @Post(':id/test')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Test credentials by minting an access token. Updates last_verified_at on success/failure.',
  })
  async test(@Req() req: Request, @Param('id') id: string) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    if (!isUuid(id)) throw new BadRequestException({ code: 'INVALID_ID' });
    if (!this.svc.isReady()) {
      throw new ServiceUnavailableException({ code: 'CRED_SERVICE_NOT_CONFIGURED' });
    }

    // Resolve the clearinghouse name from the row (we got an id, not
    // a clearinghouse, in the URL). RLS makes this safe — only the
    // tenant's own credentials are visible.
    const row = await runReadOnlyWithTenant(this.db, orgId, async (tx) =>
      tx
        .selectFrom('tenant_clearinghouse_credential')
        .select(['id', 'clearinghouse'])
        .where('id', '=', id)
        .where('org_id', '=', orgId)
        .executeTakeFirst(),
    );
    if (!row) throw new NotFoundException({ code: 'CREDENTIAL_NOT_FOUND' });

    const creds = await this.svc.get(orgId, row.clearinghouse);
    if (!creds) throw new NotFoundException({ code: 'CREDENTIAL_NOT_FOUND' });

    try {
      const clientId = String(creds.clientId ?? creds.client_id ?? '');
      const clientSecret = String(creds.clientSecret ?? creds.client_secret ?? '');
      let expiresInSec = 0;

      if (row.clearinghouse === 'availity') {
        const r = await new AvailityClient({ clientId, clientSecret }).ping();
        expiresInSec = r.expires_in_sec;
      } else if (row.clearinghouse === 'change_healthcare') {
        const r = await new ChangeHealthcareClient({ clientId, clientSecret }).ping();
        expiresInSec = r.expires_in_sec;
      } else if (row.clearinghouse === 'waystar') {
        const r = await new WaystarClient({ clientId, clientSecret }).ping();
        expiresInSec = r.expires_in_sec;
      } else {
        throw new ServiceUnavailableException({
          code: 'CLEARINGHOUSE_NOT_IMPLEMENTED',
          clearinghouse: row.clearinghouse,
        });
      }

      await this.svc.recordVerification({ orgId, id, status: 'ok', error: null });
      await sql`
        INSERT INTO audit_log (org_id, user_id, action, target_type, target_id, payload, ip_address, user_agent)
        VALUES (${orgId}, ${req.auth?.userId ?? null}, 'clearinghouse_credential.verify_ok',
                'tenant_clearinghouse_credential', ${id},
                ${JSON.stringify({ clearinghouse: row.clearinghouse, expires_in_sec: expiresInSec })}::jsonb,
                NULL, NULL)
      `.execute(this.db);
      return { ok: true, expires_in_sec: expiresInSec };
    } catch (e) {
      const msg =
        e instanceof AvailityError
          ? `${e.code}/${e.status}: ${e.detail}`
          : e instanceof ClearinghouseError
            ? `${e.code}/${e.status}: ${e.detail}`
            : e instanceof Error
              ? e.message
              : String(e);
      await this.svc.recordVerification({
        orgId,
        id,
        status: 'failed',
        error: msg.slice(0, 500),
      });
      // Re-throw as 400 — the credentials don't work, that's a client problem.
      throw new BadRequestException({ code: 'CREDENTIAL_VERIFICATION_FAILED', detail: msg });
    }
  }
}

/**
 * Lightweight payload guard: every value must be a string (or an
 * object whose values are strings — Availity uses flat shapes only).
 * Refuses arrays, nested objects, numbers, booleans to keep the
 * encrypted payload predictable.
 */
function isPlainPayload(p: unknown): p is Record<string, string> {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  for (const [, v] of Object.entries(p)) {
    if (typeof v !== 'string' || v.length === 0 || v.length > 1024) return false;
  }
  return true;
}
