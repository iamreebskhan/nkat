/**
 * X12 271 (Eligibility Response) parser. Pure function; no DB, no IO.
 *
 * Auto-detects element/segment delimiters from the ISA header (same approach
 * as the 835 parser). PHI-aware: only stores subscriber_id, never the
 * person's name from NM1 segments.
 */
import type {
  Edi271BenefitLine,
  Edi271File,
  Edi271SubscriberCoverage,
} from './types';

interface Delimiters {
  element: string;
  subElement: string;
  segment: string;
}

interface Segment {
  tag: string;
  fields: string[];
  raw: string;
}

const DEFAULT_DELIMITERS: Delimiters = { element: '*', subElement: ':', segment: '~' };

function detectDelimiters(input: string): Delimiters {
  if (input.startsWith('ISA') && input.length >= 106) {
    return {
      element: input[3] ?? '*',
      subElement: input[104] ?? ':',
      segment: input[105] ?? '~',
    };
  }
  return DEFAULT_DELIMITERS;
}

function tokenize(input: string, d: Delimiters): Segment[] {
  const cleaned = input.replace(/\r/g, '').replace(/\n/g, '');
  return cleaned
    .split(d.segment)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((seg) => {
      const fields = seg.split(d.element);
      const tag = fields[0] ?? '';
      return { tag, fields: fields.slice(1), raw: seg };
    });
}

function num(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function parseDtm(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const start = value.split('-')[0] ?? '';
  if (start.length !== 8) return undefined;
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(4, 6));
  const d = Number(start.slice(6, 8));
  if (!y || !m || !d) return undefined;
  return new Date(Date.UTC(y, m - 1, d));
}

export function parseEdi271(input: string): Edi271File {
  const delim = detectDelimiters(input);
  const segments = tokenize(input, delim);

  const file: Edi271File = {
    header: {},
    subscribers: [],
    unparsed_segments: [],
  };

  let currentSubscriber: Edi271SubscriberCoverage | null = null;
  let currentBenefit: Edi271BenefitLine | null = null;

  const closeBenefit = () => {
    if (!currentSubscriber || !currentBenefit) return;
    currentSubscriber.benefits.push(currentBenefit);
    currentBenefit = null;
  };
  const closeSubscriber = () => {
    if (!currentSubscriber) return;
    closeBenefit();
    file.subscribers.push(currentSubscriber);
    currentSubscriber = null;
  };

  for (const seg of segments) {
    switch (seg.tag) {
      case 'TRN':
        file.header.trace_number = seg.fields[1] ?? undefined;
        break;
      case 'NM1': {
        // X12 NM1 (0-indexed fields after the tag):
        //   [0] NM101 qualifier (PR=Payer, 1P=Provider, IL=Insured)
        //   [1] NM102 entity type (1=person, 2=non-person)
        //   [2] NM103 last name / org name
        //   [3] NM104 first name  ← PHI; NEVER stored
        //   [7] NM108 id qualifier (MI=Member Id)
        //   [8] NM109 id value
        const qualifier = seg.fields[0];
        const orgOrLastName = seg.fields[2];
        if (qualifier === 'PR' && orgOrLastName) file.header.payer_name = orgOrLastName;
        else if (qualifier === '1P' && orgOrLastName) file.header.provider_name = orgOrLastName;
        else if (qualifier === 'IL') {
          closeSubscriber();
          currentSubscriber = { benefits: [] };
          if (seg.fields[7] === 'MI' && seg.fields[8]) {
            currentSubscriber.subscriber_id = seg.fields[8];
          }
        }
        break;
      }
      case 'REF': {
        // REF*<qualifier>*<value>. 6P = Group # / Employer ref.
        if (!currentSubscriber) break;
        const qualifier = seg.fields[0];
        const value = seg.fields[1];
        if ((qualifier === '6P' || qualifier === '18') && value) {
          currentSubscriber.group_id = value;
        }
        break;
      }
      case 'DTP':
      case 'DTM': {
        // DTP*<qualifier>*<format>*<value>. 291 = Plan Begin, 292 = Plan End,
        // 307 = Eligibility, 346 = Plan Begin Period.
        if (!currentSubscriber) break;
        const qualifier = seg.fields[0];
        // For DTP the date is in fields[2]; for DTM it's fields[1].
        const raw = seg.tag === 'DTP' ? seg.fields[2] : seg.fields[1];
        const date = parseDtm(raw);
        if (!date) break;
        if (qualifier === '346' || qualifier === '291') currentSubscriber.coverage_start = date;
        else if (qualifier === '347' || qualifier === '292') currentSubscriber.coverage_end = date;
        break;
      }
      case 'EB': {
        if (!currentSubscriber) break;
        closeBenefit();
        // X12 EB (0-indexed fields after the tag):
        //   [0]  EB01 eligibility/benefit code
        //   [1]  EB02 coverage level
        //   [2]  EB03 service type code(s) — composite using `:` or `^` repetition
        //   [3]  EB04 insurance type code
        //   [4]  EB05 plan coverage description
        //   [5]  EB06 time period qualifier
        //   [6]  EB07 monetary amount
        //   [7]  EB08 percent
        //   [8]  EB09 quantity qualifier
        //   [9]  EB10 quantity
        //   [10] EB11 authorization indicator
        //   [11] EB12 in-plan network indicator
        const eligibility_code = seg.fields[0] ?? '';
        const coverage_level = seg.fields[1] || undefined;
        // Some payers use `^` (repetition separator) for compound service-type
        // codes; others use the sub-element delimiter `:`. Accept either.
        const serviceTypeRaw = seg.fields[2] ?? '';
        const service_type = serviceTypeRaw
          .split(/[\^:]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const insurance_type_code = seg.fields[3] || undefined;
        const time_period_qualifier = seg.fields[5] || undefined;
        const monetary_amount = num(seg.fields[6]);
        const percent = num(seg.fields[7]);
        const quantity = num(seg.fields[9]);
        const network = seg.fields[11];
        currentBenefit = {
          eligibility_code,
          ...(coverage_level !== undefined ? { coverage_level } : {}),
          service_type_codes: service_type,
          ...(insurance_type_code !== undefined ? { insurance_type_code } : {}),
          ...(time_period_qualifier !== undefined ? { time_period_qualifier } : {}),
          ...(monetary_amount !== undefined ? { monetary_amount } : {}),
          ...(percent !== undefined ? { percent } : {}),
          ...(quantity !== undefined ? { quantity } : {}),
          ...(network === 'Y' || network === 'N' ? { in_plan_network: network as 'Y' | 'N' } : {}),
          message_text: [],
        };
        break;
      }
      case 'MSG': {
        if (!currentBenefit) break;
        const text = seg.fields[0];
        if (text) currentBenefit.message_text!.push(text);
        break;
      }
      case 'SE':
      case 'GE':
      case 'IEA':
        closeSubscriber();
        break;
      case 'ISA':
      case 'GS':
      case 'ST':
      case 'BHT':
      case 'HL':
      case 'AAA':
      case 'EQ':
      case 'III':
      case 'PER':
        break;
      default:
        file.unparsed_segments.push(seg.raw);
    }
  }
  closeSubscriber();
  return file;
}
