/**
 * SCIM bearer-token guard. Validates the `Authorization: Bearer <token>`
 * header against `scim_token` (matched by SHA-256 hash) and attaches
 * `req.auth.orgId` so the controllers can scope queries via RLS.
 *
 * Distinct from AuthGuard — IdP SCIM clients can't carry our app JWT,
 * they negotiate an opaque secret at connector setup time.
 */
import { createHash } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { sql } from 'kysely';
import type { Request } from 'express';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';

@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException({ code: 'NO_BEARER' });
    }
    const token = header.slice(7).trim();
    if (token.length < 16) {
      throw new UnauthorizedException({ code: 'BEARER_TOO_SHORT' });
    }
    const hash = createHash('sha256').update(token).digest('hex');

    const r = await sql<{
      id: string;
      org_id: string;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>`SELECT id, org_id, expires_at, revoked_at
       FROM app.lookup_scim_token(${hash})`.execute(this.db);
    const row = r.rows[0];
    if (!row) throw new UnauthorizedException({ code: 'INVALID_BEARER' });
    if (row.revoked_at) throw new UnauthorizedException({ code: 'BEARER_REVOKED' });
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
      throw new UnauthorizedException({ code: 'BEARER_EXPIRED' });
    }

    // Best-effort last-used update — fire and forget.
    void sql`UPDATE scim_token SET last_used_at = now() WHERE id = ${row.id}`
      .execute(this.db)
      .catch(() => {});

    req.auth = {
      orgId: row.org_id,
      userId: null,
      role: 'system',
    };
    return true;
  }
}
