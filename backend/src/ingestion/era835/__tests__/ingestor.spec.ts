import { Era835Ingestor } from '../ingestor';
import type { Era835File } from '../types';
import type { Tx } from '../../../database/rls-transaction';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const PAYER_ID = '33333333-3333-4333-8333-333333333333';
const RULE_ID = '44444444-4444-4444-8444-444444444444';

interface TxScript {
  payerLookup: { id: string } | null;
  ruleLookup: { id: string } | null;
  duplicateRecord: boolean;
  inserted: number;
  inserts: Record<string, unknown>[];
}

function makeTx(script: TxScript): Tx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    selectFrom: (table: string): any => {
      // Build a query that responds to the right .executeTakeFirst() based
      // on table.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        where: () => chain,
        orderBy: () => chain,
        executeTakeFirst: async () => {
          if (table === 'payer') return script.payerLookup;
          if (table === 'payer_rule') return script.ruleLookup;
          if (table === 'era_835_record') return script.duplicateRecord ? { id: 'DUP' } : undefined;
          return undefined;
        },
      };
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insertInto: (table: string): any => ({
      values: (v: Record<string, unknown>) => ({
        execute: async () => {
          if (table === 'era_835_record') {
            script.inserts.push(v);
            script.inserted++;
          }
          return [];
        },
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const baseFile: Era835File = {
  header: {
    payer_name: 'MEDICARE PALMETTO GBA',
    trace_number: 'TRC-1',
    payment_date: new Date('2026-04-15'),
    total_paid: 200,
    payee_name: 'ACME HOSPICE',
  },
  claims: [
    {
      claim_id: 'C1',
      status_code: '1',
      billed_amount: 250,
      paid_amount: 200,
      patient_external_id: 'M-1',
      service_dos: new Date('2026-03-01'),
      adjustments: [{ group_code: 'CO', reason_code: '45', amount: 30 }],
      rarc_codes: ['MA01'],
      service_lines: [
        {
          service_code: '99497',
          modifiers: ['25'],
          billed_amount: 250,
          paid_amount: 200,
          units: 1,
          service_dos: new Date('2026-03-01'),
          adjustments: [
            { group_code: 'CO', reason_code: '45', amount: 30 },
            { group_code: 'PR', reason_code: '1', amount: 20 },
          ],
          rarc_codes: ['MA01', 'N115'],
        },
      ],
    },
    {
      claim_id: 'C2',
      status_code: '4',
      billed_amount: 150,
      paid_amount: 0,
      service_dos: new Date('2026-03-05'),
      adjustments: [{ group_code: 'CO', reason_code: '97', amount: 150 }],
      rarc_codes: [],
      service_lines: [
        {
          service_code: '36415',
          modifiers: [],
          billed_amount: 150,
          paid_amount: 0,
          units: 1,
          service_dos: new Date('2026-03-05'),
          adjustments: [{ group_code: 'CO', reason_code: '97', amount: 150 }],
          rarc_codes: ['N56'],
        },
      ],
    },
  ],
  unparsed_segments: [],
};

describe('Era835Ingestor.ingest', () => {
  it('persists 2 records when both claims are new', async () => {
    const tx = makeTx({
      payerLookup: { id: PAYER_ID },
      ruleLookup: { id: RULE_ID },
      duplicateRecord: false,
      inserted: 0,
      inserts: [],
    });
    const ingestor = new Era835Ingestor();
    const report = await ingestor.ingest(tx, baseFile, { org_id: ORG_ID, client_id: CLIENT_ID });

    expect(report.total_claims).toBe(2);
    expect(report.total_lines).toBe(2);
    expect(report.records_persisted).toBe(2);
    expect(report.records_skipped_duplicate).toBe(0);
    expect(report.preflight_matches).toBe(2);
    expect(report.preflight_warned).toBe(2);
    expect(report.errors).toEqual([]);
  });

  it('marks preflight_warned=false when no payer_rule existed for the code', async () => {
    const script = {
      payerLookup: { id: PAYER_ID },
      ruleLookup: null,
      duplicateRecord: false,
      inserted: 0,
      inserts: [] as Record<string, unknown>[],
    };
    const tx = makeTx(script);
    const ingestor = new Era835Ingestor();
    const report = await ingestor.ingest(tx, baseFile, { org_id: ORG_ID, client_id: CLIENT_ID });

    expect(report.preflight_warned).toBe(0);
    expect(script.inserts.every((v) => v.preflight_warned === false)).toBe(true);
    expect(script.inserts.every((v) => v.expected_rule_id === null)).toBe(true);
  });

  it('skips duplicate records', async () => {
    const tx = makeTx({
      payerLookup: { id: PAYER_ID },
      ruleLookup: { id: RULE_ID },
      duplicateRecord: true,
      inserted: 0,
      inserts: [],
    });
    const ingestor = new Era835Ingestor();
    const report = await ingestor.ingest(tx, baseFile, { org_id: ORG_ID, client_id: CLIENT_ID });

    expect(report.records_persisted).toBe(0);
    expect(report.records_skipped_duplicate).toBe(2);
  });

  it('handles unknown payer name gracefully', async () => {
    const script = {
      payerLookup: null,
      ruleLookup: null,
      duplicateRecord: false,
      inserted: 0,
      inserts: [] as Record<string, unknown>[],
    };
    const tx = makeTx(script);
    const ingestor = new Era835Ingestor();
    const report = await ingestor.ingest(tx, baseFile, { org_id: ORG_ID, client_id: CLIENT_ID });

    expect(report.records_persisted).toBe(2);
    expect(script.inserts.every((v) => v.payer_id === null)).toBe(true);
  });

  it('uses claim-level adjustments when line has none', async () => {
    const script = {
      payerLookup: { id: PAYER_ID },
      ruleLookup: { id: RULE_ID },
      duplicateRecord: false,
      inserted: 0,
      inserts: [] as Record<string, unknown>[],
    };
    const tx = makeTx(script);
    const fileNoLineAdj: Era835File = {
      ...baseFile,
      claims: [
        {
          ...baseFile.claims[0],
          service_lines: [
            { ...baseFile.claims[0].service_lines[0], adjustments: [] },
          ],
        },
      ],
    };
    const ingestor = new Era835Ingestor();
    await ingestor.ingest(tx, fileNoLineAdj, { org_id: ORG_ID, client_id: CLIENT_ID });
    expect(script.inserts[0].carc_codes).toEqual(['45']);
    expect(script.inserts[0].group_code).toBe('CO');
  });

  it('skips lines without a DOS', async () => {
    const script = {
      payerLookup: { id: PAYER_ID },
      ruleLookup: { id: RULE_ID },
      duplicateRecord: false,
      inserted: 0,
      inserts: [] as Record<string, unknown>[],
    };
    const tx = makeTx(script);
    const noDos: Era835File = {
      ...baseFile,
      claims: [
        {
          ...baseFile.claims[0],
          service_dos: undefined,
          service_lines: [{ ...baseFile.claims[0].service_lines[0], service_dos: undefined }],
        },
      ],
    };
    const ingestor = new Era835Ingestor();
    const report = await ingestor.ingest(tx, noDos, { org_id: ORG_ID, client_id: CLIENT_ID });
    expect(report.records_persisted).toBe(0);
  });

  it('records errors per claim without aborting the batch', async () => {
    // Force the second claim's insert to throw.
    let insertCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: Tx = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      selectFrom: (t: string): any => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {
          select: () => chain,
          where: () => chain,
          orderBy: () => chain,
          executeTakeFirst: async () =>
            t === 'payer' ? { id: PAYER_ID } : t === 'payer_rule' ? { id: RULE_ID } : undefined,
        };
        return chain;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      insertInto: (t: string): any => ({
        values: () => ({
          execute: async () => {
            if (t !== 'era_835_record') return [];
            insertCount++;
            if (insertCount === 2) throw new Error('db boom');
            return [];
          },
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const ingestor = new Era835Ingestor();
    const report = await ingestor.ingest(tx, baseFile, { org_id: ORG_ID, client_id: CLIENT_ID });
    expect(report.records_persisted).toBe(1);
    expect(report.errors).toEqual([
      { claim_id: 'C2', message: 'db boom' },
    ]);
  });
});
