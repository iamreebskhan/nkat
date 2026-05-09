import { CandidateNotInQueueError, ExtractionQueueService } from '../extraction-queue.service';
import type { Db } from '../../database/db';

interface DbScript {
  candidate?: {
    id: string;
    status: string;
    payer_id: string;
    state: string;
    product_line: string;
    code: string;
    attribute: string;
    proposed_value: Record<string, unknown>;
    proposed_coverage_status: string;
    proposed_confidence: string;
    proposed_effective_date: Date;
    proposed_expiration_date: Date | null;
    proposed_provider_taxonomy_allowed: string[];
    proposed_timely_filing_days: number | null;
    proposed_mhpaea_paired_code: string | null;
    source_doc_id: string;
    source_quote: string | null;
    source_page: number | null;
  };
  numUpdatedRows: number;
  inserted: { table: string; values: Record<string, unknown> }[];
}

function makeDb(script: DbScript): Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const passthrough = (table: string): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      values: (v: Record<string, unknown>) => ({
        returning: () => ({
          executeTakeFirstOrThrow: async () => {
            script.inserted.push({ table, values: v });
            return { id: `NEW-${table}-${script.inserted.length}` };
          },
        }),
        execute: async () => {
          script.inserted.push({ table, values: v });
          return [];
        },
      }),
      set: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      executeTakeFirst: async () => ({ numUpdatedRows: BigInt(script.numUpdatedRows) }),
      execute: async () => [],
    };
    return chain;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    selectFrom: (table: string) => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () =>
            table === 'extraction_candidate' ? script.candidate : undefined,
        }),
      }),
      select: () => ({ where: () => ({ executeTakeFirst: async () => undefined }) }),
    }),
    updateTable: passthrough,
    insertInto: passthrough,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    selectFrom: (_table: string) => ({
      where: () => ({
        select: () => ({
          orderBy: () => ({
            orderBy: () => ({
              limit: () => ({ execute: async () => [] }),
            }),
          }),
        }),
      }),
    }),
    insertInto: passthrough,
    updateTable: passthrough,
    transaction: () => ({
      execute: <T>(work: (t: typeof tx) => Promise<T>) => work(tx),
    }),
  } as any;
}

describe('ExtractionQueueService.claim', () => {
  it('returns true when one row was updated', async () => {
    const script: DbScript = { numUpdatedRows: 1, inserted: [] };
    const svc = new ExtractionQueueService(makeDb(script));
    expect(await svc.claim('11111111-1111-4111-8111-111111111111', 'analyst@x.co')).toBe(true);
  });

  it('returns false when zero rows were updated (already claimed)', async () => {
    const script: DbScript = { numUpdatedRows: 0, inserted: [] };
    const svc = new ExtractionQueueService(makeDb(script));
    expect(await svc.claim('11111111-1111-4111-8111-111111111111', 'analyst@x.co')).toBe(false);
  });
});

describe('ExtractionQueueService.accept', () => {
  const baseCand = (status = 'queued') => ({
    id: '11111111-1111-4111-8111-111111111111',
    status,
    payer_id: '22222222-2222-4222-8222-222222222222',
    state: 'OH',
    product_line: 'medicare_ffs',
    code: '99497',
    attribute: 'covered',
    proposed_value: { covered: true },
    proposed_coverage_status: 'covered',
    proposed_confidence: '1.00',
    proposed_effective_date: new Date('2026-01-01'),
    proposed_expiration_date: null,
    proposed_provider_taxonomy_allowed: [],
    proposed_timely_filing_days: null,
    proposed_mhpaea_paired_code: null,
    source_doc_id: '33333333-3333-4333-8333-333333333333',
    source_quote: 'covered',
    source_page: 1,
  });

  it('inserts payer_rule + decision row when candidate is queued', async () => {
    const script: DbScript = { candidate: baseCand('queued'), numUpdatedRows: 1, inserted: [] };
    const svc = new ExtractionQueueService(makeDb(script));
    const ruleId = await svc.accept(
      '11111111-1111-4111-8111-111111111111',
      'analyst@x.co',
      'verified with payer rep',
    );
    expect(ruleId).toMatch(/^NEW-payer_rule-/);
    // INSERTs: payer_rule + extraction_decision (extraction_candidate is UPDATEd, not INSERTed).
    expect(script.inserted.map((i) => i.table)).toEqual(
      expect.arrayContaining(['payer_rule', 'extraction_decision']),
    );
    const decisionInsert = script.inserted.find((i) => i.table === 'extraction_decision')!;
    expect(decisionInsert.values.decision).toBe('accept');
    expect(decisionInsert.values.decided_by).toBe('analyst@x.co');
  });

  it('throws CandidateNotInQueueError on missing candidate', async () => {
    const script: DbScript = { numUpdatedRows: 0, inserted: [] };
    const svc = new ExtractionQueueService(makeDb(script));
    await expect(
      svc.accept('11111111-1111-4111-8111-111111111111', 'analyst@x.co'),
    ).rejects.toBeInstanceOf(CandidateNotInQueueError);
  });

  it('throws CandidateNotInQueueError when candidate already accepted', async () => {
    const script: DbScript = { candidate: baseCand('accepted'), numUpdatedRows: 0, inserted: [] };
    const svc = new ExtractionQueueService(makeDb(script));
    await expect(
      svc.accept('11111111-1111-4111-8111-111111111111', 'analyst@x.co'),
    ).rejects.toBeInstanceOf(CandidateNotInQueueError);
  });
});

describe('CandidateNotInQueueError', () => {
  it('extends Error and includes the candidate id', () => {
    const e = new CandidateNotInQueueError('xyz');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain('xyz');
    expect(e.name).toBe('CandidateNotInQueueError');
  });
});
