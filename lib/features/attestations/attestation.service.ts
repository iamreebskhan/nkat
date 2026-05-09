/**
 * Attestation service — Prisma I/O for analyst_attestation +
 * analyst_attestation_request.
 *
 * Multi-tenant via withOrgContext.
 */
import { withOrgContext } from "@/lib/db";
import { defaultExpiry } from "./attestation-pure";
import type {
  AttestationLifecycle,
  AttestationRequestView,
  AttestationView,
  CreateAttestation,
  RequestStatus,
} from "./attestation.types";

interface AttRow {
  id: string;
  payer_id: string;
  state: string;
  cpt_code: string;
  attribute: string;
  rule_value: Record<string, unknown>;
  coverage_status: AttestationView["coverageStatus"];
  payer_rep_name: string;
  payer_rep_id: string | null;
  call_date: Date;
  call_time: string | null;
  call_phone_number: string | null;
  call_notes: string | null;
  confirmed_quote: string | null;
  expires_at: Date;
  status: AttestationLifecycle;
  supersedes_id: string | null;
  attested_by_user_id: string;
  voided_by_user_id: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToView(r: AttRow): AttestationView {
  return {
    id: r.id,
    payerId: r.payer_id,
    state: r.state,
    cptCode: r.cpt_code,
    attribute: r.attribute,
    ruleValue: r.rule_value,
    coverageStatus: r.coverage_status,
    payerRepName: r.payer_rep_name,
    payerRepId: r.payer_rep_id,
    callDate: r.call_date.toISOString().slice(0, 10),
    callTime: r.call_time,
    callPhoneNumber: r.call_phone_number,
    callNotes: r.call_notes,
    confirmedQuote: r.confirmed_quote,
    expiresAt: r.expires_at.toISOString().slice(0, 10),
    status: r.status,
    supersedesId: r.supersedes_id,
    attestedByUserId: r.attested_by_user_id,
    voidedByUserId: r.voided_by_user_id,
    voidedAt: r.voided_at?.toISOString() ?? null,
    voidReason: r.void_reason,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * Create a new attestation. If `supersedesId` is set, this transactionally
 * marks the old row as `re_verified` so the unique-active index doesn't
 * collide.
 */
export async function createAttestation(args: {
  orgId: string;
  attestedByUserId: string;
  payload: CreateAttestation;
}): Promise<{ id: string }> {
  const { orgId, attestedByUserId, payload } = args;
  const expiresAt =
    payload.expiresAt ??
    defaultExpiry(payload.callDate).toISOString().slice(0, 10);

  return withOrgContext(orgId, async (tx) => {
    if (payload.supersedesId) {
      await tx.$executeRaw`
        UPDATE analyst_attestation
           SET status = 're_verified', updated_at = now()
         WHERE id = ${payload.supersedesId}::uuid
           AND status = 'active'
      `;
    }

    // Same-cell active row should be auto-superseded if the analyst
    // didn't explicitly reference it.
    if (!payload.supersedesId) {
      await tx.$executeRaw`
        UPDATE analyst_attestation
           SET status = 're_verified', updated_at = now()
         WHERE org_id    = ${orgId}::uuid
           AND payer_id  = ${payload.payerId}::uuid
           AND state     = ${payload.state}
           AND cpt_code  = ${payload.cptCode}
           AND attribute = ${payload.attribute}
           AND status    = 'active'
      `;
    }

    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO analyst_attestation (
        org_id, payer_id, state, cpt_code, attribute,
        rule_value, coverage_status,
        payer_rep_name, payer_rep_id,
        call_date, call_time, call_phone_number,
        call_notes, confirmed_quote,
        expires_at, status, supersedes_id, attested_by_user_id
      ) VALUES (
        ${orgId}::uuid, ${payload.payerId}::uuid, ${payload.state}, ${payload.cptCode},
        ${payload.attribute},
        ${JSON.stringify(payload.ruleValue ?? {})}::jsonb, ${payload.coverageStatus},
        ${payload.payerRepName}, ${payload.payerRepId ?? null},
        ${payload.callDate}::date, ${payload.callTime ?? null}, ${payload.callPhoneNumber ?? null},
        ${payload.callNotes ?? null}, ${payload.confirmedQuote ?? null},
        ${expiresAt}::date, 'active',
        ${payload.supersedesId ?? null}::uuid, ${attestedByUserId}::uuid
      )
      RETURNING id
    `;
    return { id: rows[0]!.id };
  });
}

export async function getAttestation(args: {
  orgId: string;
  id: string;
}): Promise<AttestationView | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<AttRow[]>`
      SELECT * FROM analyst_attestation WHERE id = ${args.id}::uuid LIMIT 1
    `;
    return rows[0] ? rowToView(rows[0]) : null;
  });
}

export async function listAttestations(args: {
  orgId: string;
  status?: AttestationLifecycle;
  payerId?: string;
  cptCode?: string;
  limit?: number;
}): Promise<AttestationView[]> {
  const limit = Math.min(500, args.limit ?? 200);
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<AttRow[]>`
      SELECT * FROM analyst_attestation
      WHERE
        (${args.status ?? null}::text IS NULL OR status = ${args.status ?? null})
        AND (${args.payerId ?? null}::uuid IS NULL OR payer_id = ${args.payerId ?? null}::uuid)
        AND (${args.cptCode ?? null}::text IS NULL OR cpt_code = ${args.cptCode ?? null})
      ORDER BY expires_at ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToView);
  });
}

export async function voidAttestation(args: {
  orgId: string;
  id: string;
  byUserId: string;
  reason: string;
}): Promise<void> {
  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      UPDATE analyst_attestation
         SET status = 'voided',
             voided_at = now(),
             voided_by_user_id = ${args.byUserId}::uuid,
             void_reason = ${args.reason},
             updated_at = now()
       WHERE id = ${args.id}::uuid
         AND status = 'active'
    `;
  });
}

/**
 * Sweep: flip any active row past its expires_at to `expired`. Called
 * by the daily cron + opportunistically by listAttestations callers
 * that want the freshness counts to be accurate.
 */
export async function sweepExpired(args: {
  orgId: string;
}): Promise<{ swept: number }> {
  return withOrgContext(args.orgId, async (tx) => {
    const r = await tx.$queryRaw<{ id: string }[]>`
      UPDATE analyst_attestation
         SET status = 'expired', updated_at = now()
       WHERE status = 'active'
         AND expires_at < now()::date
       RETURNING id
    `;
    return { swept: r.length };
  });
}

// ---------------------------------------------------------------------------
// Attestation requests (the queue analysts work)
// ---------------------------------------------------------------------------

interface ReqRow {
  id: string;
  payer_id: string | null;
  state: string | null;
  cpt_code: string;
  attribute: string;
  source_query: string | null;
  status: RequestStatus;
  resolved_attestation_id: string | null;
  claimed_by_user_id: string | null;
  claimed_at: Date | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
}

function reqToView(r: ReqRow): AttestationRequestView {
  return {
    id: r.id,
    payerId: r.payer_id,
    state: r.state,
    cptCode: r.cpt_code,
    attribute: r.attribute,
    sourceQuery: r.source_query,
    status: r.status,
    resolvedAttestationId: r.resolved_attestation_id,
    claimedByUserId: r.claimed_by_user_id,
    claimedAt: r.claimed_at?.toISOString() ?? null,
    resolvedAt: r.resolved_at?.toISOString() ?? null,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at.toISOString(),
  };
}

/** Push a new gap into the analyst queue (called by rule lookup on miss). */
export async function pushAttestationRequest(args: {
  orgId: string;
  payerId: string | null;
  state: string | null;
  cptCode: string;
  attribute: string;
  sourceQuery?: string;
}): Promise<{ id: string }> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO analyst_attestation_request (
        org_id, payer_id, state, cpt_code, attribute, source_query
      ) VALUES (
        ${args.orgId}::uuid, ${args.payerId ?? null}::uuid, ${args.state ?? null},
        ${args.cptCode}, ${args.attribute}, ${args.sourceQuery ?? null}
      )
      RETURNING id
    `;
    return { id: rows[0]!.id };
  });
}

export async function listAttestationRequests(args: {
  orgId: string;
  status?: RequestStatus;
  limit?: number;
}): Promise<AttestationRequestView[]> {
  const limit = Math.min(200, args.limit ?? 100);
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<ReqRow[]>`
      SELECT * FROM analyst_attestation_request
      WHERE (${args.status ?? null}::text IS NULL OR status = ${args.status ?? null})
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(reqToView);
  });
}

export async function claimRequest(args: {
  orgId: string;
  id: string;
  byUserId: string;
}): Promise<void> {
  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      UPDATE analyst_attestation_request
         SET status = 'in_progress',
             claimed_by_user_id = ${args.byUserId}::uuid,
             claimed_at = now(),
             updated_at = now()
       WHERE id = ${args.id}::uuid
         AND status = 'open'
    `;
  });
}

export async function resolveRequest(args: {
  orgId: string;
  id: string;
  attestationId: string;
  note?: string;
}): Promise<void> {
  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      UPDATE analyst_attestation_request
         SET status = 'resolved',
             resolved_attestation_id = ${args.attestationId}::uuid,
             resolved_at = now(),
             resolution_note = COALESCE(${args.note ?? null}, resolution_note),
             updated_at = now()
       WHERE id = ${args.id}::uuid
    `;
  });
}
