import { NcdLcdIngestor } from '../ncd-lcd.ingestor';
import type { CmsCoverageApiClient, CmsLcdSummary, CmsLcdDetail } from '../cms-coverage-api.client';
import type { Db } from '../../database/db';

const PAYER_ID = '11111111-1111-4111-8111-111111111111';

function makeClient(opts: {
  summaries?: CmsLcdSummary[];
  detail?: CmsLcdDetail;
  failGet?: boolean;
}): CmsCoverageApiClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    listLcds: jest.fn().mockResolvedValue(opts.summaries ?? []),
    getLcd: jest.fn().mockImplementation(async () => {
      if (opts.failGet) throw new Error('boom');
      return opts.detail!;
    }),
  } as any;
}

interface DbCallLog {
  selects: { table: string }[];
  insertedDocs: number;
  insertedRules: number;
  existingDocId: string | null;
}

function makeDb(log: DbCallLog): Db {
  // Minimal Kysely-shaped mock just for the calls the ingestor makes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fluent = (table: string): any => {
    if (table === 'source_document_select') {
      // SELECT ... FROM source_document
      return {
        select: () => ({
          where: () => ({
            where: () => ({
              executeTakeFirst: async () =>
                log.existingDocId ? { id: log.existingDocId } : undefined,
            }),
          }),
        }),
      };
    }
    return {};
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertInto = (table: string): any => {
    if (table === 'source_document') {
      return {
        values: () => ({
          returning: () => ({
            executeTakeFirstOrThrow: async () => {
              log.insertedDocs++;
              return { id: 'NEW_DOC_ID' };
            },
          }),
        }),
      };
    }
    if (table === 'payer_rule') {
      return {
        values: () => ({
          execute: async () => {
            log.insertedRules++;
            return { numInsertedOrUpdatedRows: BigInt(1) };
          },
        }),
      };
    }
    throw new Error(`unexpected insertInto ${table}`);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    selectFrom: (t: string) => {
      log.selects.push({ table: t });
      if (t === 'source_document') return fluent('source_document_select');
      throw new Error(`unexpected selectFrom ${t}`);
    },
    insertInto,
  } as any;
}

const targetBase = {
  payer_id: PAYER_ID,
  payer_name: 'Medicare FFS - JM',
  state: 'NC',
  product_line: 'medicare_ffs' as const,
  codes: ['99497', '99498'],
};

const detail: CmsLcdDetail = {
  lcd_id: 'L33834',
  title: 'ACP',
  contractor: 'Palmetto',
  effective_date: '2024-04-01',
  url: 'https://cms/lcd/L33834',
  body_html:
    '<p>Voluntary advance care planning discussion is covered when reasonable and necessary.</p>',
  cpt_codes: ['99497', '99498'],
  hcpcs_codes: [],
  icd10_covered: ['Z51.5', 'Z66'],
};

describe('NcdLcdIngestor', () => {
  it('persists a new source_document and 4 payer_rule rows for two matching codes', async () => {
    const log: DbCallLog = { selects: [], insertedDocs: 0, insertedRules: 0, existingDocId: null };
    const client = makeClient({
      summaries: [
        { lcd_id: 'L33834', title: 'ACP', contractor: 'Palmetto', effective_date: '2024-04-01' },
      ],
      detail,
    });
    const ingestor = new NcdLcdIngestor(makeDb(log), client);
    const report = await ingestor.ingest(targetBase);

    expect(report.lcds_seen).toBe(1);
    expect(report.documents_persisted).toBe(1);
    // 2 codes × (covered + medical_necessity_icd10) = 4
    expect(report.rules_persisted).toBe(4);
    expect(report.errors).toEqual([]);
  });

  it('is idempotent on content_hash — skips doc insert when hash already present', async () => {
    const log: DbCallLog = {
      selects: [],
      insertedDocs: 0,
      insertedRules: 0,
      existingDocId: 'EXISTING_DOC_ID',
    };
    const client = makeClient({
      summaries: [
        { lcd_id: 'L33834', title: 'ACP', contractor: 'P', effective_date: '2024-04-01' },
      ],
      detail,
    });
    const ingestor = new NcdLcdIngestor(makeDb(log), client);
    const report = await ingestor.ingest(targetBase);

    expect(log.insertedDocs).toBe(0);
    expect(report.documents_persisted).toBe(0);
    // rules still inserted (we skip the doc, not the rules)
    expect(report.rules_persisted).toBe(4);
  });

  it('records errors per LCD without aborting the whole run', async () => {
    const log: DbCallLog = { selects: [], insertedDocs: 0, insertedRules: 0, existingDocId: null };
    const client = makeClient({
      summaries: [
        { lcd_id: 'L_GOOD', title: 'g', contractor: 'P', effective_date: '2024-01-01' },
        { lcd_id: 'L_BAD', title: 'b', contractor: 'P', effective_date: '2024-01-01' },
      ],
      failGet: true,
    });
    const ingestor = new NcdLcdIngestor(makeDb(log), client);
    const report = await ingestor.ingest(targetBase);
    expect(report.lcds_seen).toBe(2);
    expect(report.errors).toHaveLength(2);
    expect(report.documents_persisted).toBe(0);
  });

  it('deduplicates LCDs across multiple code queries', async () => {
    const log: DbCallLog = { selects: [], insertedDocs: 0, insertedRules: 0, existingDocId: null };
    // Same LCD returned for both codes
    const client = makeClient({
      summaries: [
        { lcd_id: 'L33834', title: 'ACP', contractor: 'P', effective_date: '2024-04-01' },
      ],
      detail,
    });
    const ingestor = new NcdLcdIngestor(makeDb(log), client);
    const report = await ingestor.ingest(targetBase);
    expect(report.lcds_seen).toBe(1); // not 2
  });

  it('skips medical_necessity_icd10 row when LCD has no covered ICD-10s', async () => {
    const log: DbCallLog = { selects: [], insertedDocs: 0, insertedRules: 0, existingDocId: null };
    const client = makeClient({
      summaries: [{ lcd_id: 'L', title: 't', contractor: 'p', effective_date: '2024-01-01' }],
      detail: { ...detail, icd10_covered: [] },
    });
    const ingestor = new NcdLcdIngestor(makeDb(log), client);
    const report = await ingestor.ingest({ ...targetBase, codes: ['99497'] });
    // 1 covered row, 0 med_nec rows
    expect(report.rules_persisted).toBe(1);
  });
});
