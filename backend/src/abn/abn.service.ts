/**
 * ABN service — record-keeping + PDF generation for Advance Beneficiary
 * Notices of Noncoverage (CMS-R-131).
 *
 *   create(orgId, body)            — insert abn_record row
 *   getPdf(orgId, id)              — render the form as PDF bytes
 *   list(orgId, ...filters)        — list per tenant
 *
 * 5-year retention enforced by `retain_until` defaulting to signed_at + 5y.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';
import { buildAbnPdf, type AbnFormData } from './abn-pdf';

export interface CreateAbnInput {
  orgId: string;
  clientId: string;
  patientExternalId: string;
  formVersion: string;
  signedAt: Date;
  serviceCodes: string[];
  reasonCode: string | null;
  estimatedCost: string | null;
  notes: string | null;
}

export interface AbnPdfContext {
  notifierName: string;
  notifierAddress: string;
  patientName: string;
  serviceDescription: string;
  reasonForNoncoverage: string;
  optionSelected: 'OPTION_1' | 'OPTION_2' | 'OPTION_3' | null;
}

@Injectable()
export class AbnService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async create(input: CreateAbnInput) {
    return runWithTenant(this.db, input.orgId, async (tx) => {
      // retain_until = signed_at + 5 years (CMS retention floor).
      const retainUntil = new Date(input.signedAt);
      retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 5);
      const r = await tx
        .insertInto('abn_record')
        .values({
          org_id: input.orgId,
          client_id: input.clientId,
          patient_external_id: input.patientExternalId,
          form_version: input.formVersion,
          signed_at: input.signedAt,
          service_codes: input.serviceCodes,
          reason_code: input.reasonCode,
          estimated_cost: input.estimatedCost,
          retain_until: retainUntil,
          notes: input.notes,
          document_uri: null,
        })
        .returning(['id', 'retain_until', 'created_at'])
        .executeTakeFirstOrThrow();
      return r;
    });
  }

  async list(orgId: string, args: { client_id?: string; limit?: number }) {
    const limit = Math.min(500, Math.max(1, args.limit ?? 100));
    return runReadOnlyWithTenant(this.db, orgId, async (tx) => {
      let q = tx
        .selectFrom('abn_record')
        .selectAll()
        .where('org_id', '=', orgId)
        .orderBy('signed_at', 'desc')
        .limit(limit);
      if (args.client_id) q = q.where('client_id', '=', args.client_id);
      return q.execute();
    });
  }

  async getPdf(orgId: string, id: string, ctx: AbnPdfContext): Promise<Buffer> {
    const row = await runReadOnlyWithTenant(this.db, orgId, async (tx) =>
      tx
        .selectFrom('abn_record')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    if (!row) throw new NotFoundException({ code: 'ABN_NOT_FOUND' });

    const pdfData: AbnFormData = {
      formVersion: row.form_version,
      notifierName: ctx.notifierName,
      notifierAddress: ctx.notifierAddress,
      patientName: ctx.patientName,
      patientId: row.patient_external_id,
      serviceDescription: ctx.serviceDescription || row.service_codes.join(', '),
      reasonForNoncoverage: ctx.reasonForNoncoverage || row.reason_code || 'See notes.',
      estimatedCost: row.estimated_cost ?? '$ ____',
      optionSelected: ctx.optionSelected,
      signedAt: row.signed_at,
      signaturePresent: true,
    };
    return buildAbnPdf(pdfData);
  }
}
