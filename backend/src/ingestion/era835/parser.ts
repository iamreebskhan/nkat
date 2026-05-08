/**
 * X12 835 ERA parser. Pure function; no DB, no IO.
 *
 * Highlights:
 *   - Auto-detects element/sub-element/segment delimiters from the ISA header.
 *   - Tolerant of CR/LF whitespace between segments and missing trailing
 *     elements; a real payer's 835 is rarely byte-identical to the spec.
 *   - Returns typed Era835File with header + claims + unparsed_segments.
 *
 * The parser deliberately does NOT validate against the full X12 schema — its
 * only contract is "do not lose data the analytics layer needs": claim id,
 * billed/paid amounts, CARC/RARC, and per-line service codes/modifiers.
 */
import type { Era835Adjustment, Era835Claim, Era835File, Era835ServiceLine } from './types';

interface Delimiters {
  element: string;       // typically '*'
  subElement: string;    // typically ':' or ''
  segment: string;       // typically '~'
}

interface Segment {
  tag: string;
  fields: string[];      // 1-indexed in spec; we store 0-indexed for code clarity
  raw: string;
}

const DEFAULT_DELIMITERS: Delimiters = { element: '*', subElement: ':', segment: '~' };

function detectDelimiters(input: string): Delimiters {
  // ISA header is fixed-width. Element separator is at position 3, sub-element
  // at position 104, segment terminator at position 105 — but only when the
  // ISA segment itself is well-formed. Fall back to defaults otherwise.
  if (input.startsWith('ISA') && input.length >= 106) {
    return {
      element: input[3] ?? '*',
      subElement: input[104] ?? ':',
      segment: input[105] ?? '~',
    };
  }
  return DEFAULT_DELIMITERS;
}

function tokenize(input: string, delim: Delimiters): Segment[] {
  // Strip control chars + collapse newlines around segment terminator so a
  // file with `~\n` between segments parses identically to `~`.
  const cleaned = input.replace(/\r/g, '').replace(/\n/g, '');
  return cleaned
    .split(delim.segment)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((seg) => {
      const fields = seg.split(delim.element);
      const tag = fields[0] ?? '';
      return { tag, fields: fields.slice(1), raw: seg };
    });
}

function num(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseDtm(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  // DTM dates are CCYYMMDD or CCYYMMDD-CCYYMMDD (range). Take start.
  const start = value.split('-')[0] ?? '';
  if (start.length !== 8) return undefined;
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(4, 6));
  const d = Number(start.slice(6, 8));
  if (!y || !m || !d) return undefined;
  return new Date(Date.UTC(y, m - 1, d));
}

function parseCas(seg: Segment): Era835Adjustment[] {
  // CAS*<group>*<reason1>*<amount1>*<qty1>*<reason2>*<amount2>*<qty2>*…
  // Up to ~6 reason/amount/qty triplets per CAS.
  const out: Era835Adjustment[] = [];
  const groupRaw = seg.fields[0] ?? '';
  const group = (['CO', 'PR', 'OA', 'PI'] as const).find((g) => g === groupRaw);
  if (!group) return out;
  // Triplets start at index 1 (reason), 2 (amount), 3 (qty), then 4/5/6, etc.
  for (let i = 1; i + 1 < seg.fields.length; i += 3) {
    const reason = seg.fields[i];
    const amount = seg.fields[i + 1];
    const qty = seg.fields[i + 2];
    if (!reason) break;
    out.push({
      group_code: group,
      reason_code: reason,
      amount: num(amount),
      ...(qty !== undefined && qty !== '' ? { quantity: num(qty) } : {}),
    });
  }
  return out;
}

function parseLqRarc(seg: Segment): string | null {
  // LQ*HE*<RARC code>
  if (seg.fields[0] !== 'HE') return null;
  return seg.fields[1] ?? null;
}

function parseSvc(seg: Segment, delim: Delimiters): Pick<Era835ServiceLine, 'service_code' | 'modifiers' | 'billed_amount' | 'paid_amount' | 'units' | 'revenue_code'> {
  // SVC01 is composite: <qualifier>:<code>:<modifier1>:<modifier2>:<modifier3>:<modifier4>[:<description>][:<units>]
  const composite = (seg.fields[0] ?? '').split(delim.subElement);
  const code = composite[1] ?? '';
  const modifiers = composite.slice(2, 6).filter((m) => m && m.length > 0);
  const billed = num(seg.fields[1]);
  const paid = num(seg.fields[2]);
  const revenue = seg.fields[3]; // SVC04 — revenue code (institutional)
  const units = num(seg.fields[4] ?? '1') || 1;
  return {
    service_code: code,
    modifiers,
    billed_amount: billed,
    paid_amount: paid,
    units,
    ...(revenue && revenue !== '' ? { revenue_code: revenue } : {}),
  };
}

function parseClp(seg: Segment): Pick<Era835Claim, 'claim_id' | 'status_code' | 'billed_amount' | 'paid_amount' | 'patient_responsibility' | 'payer_claim_control_number'> {
  return {
    claim_id: seg.fields[0] ?? '',
    status_code: seg.fields[1] ?? '',
    billed_amount: num(seg.fields[2]),
    paid_amount: num(seg.fields[3]),
    ...(seg.fields[4] ? { patient_responsibility: num(seg.fields[4]) } : {}),
    ...(seg.fields[6] ? { payer_claim_control_number: seg.fields[6] } : {}),
  };
}

export function parseEra835(input: string): Era835File {
  const delim = detectDelimiters(input);
  const segments = tokenize(input, delim);

  const file: Era835File = {
    header: {},
    claims: [],
    unparsed_segments: [],
  };

  let currentClaim: Era835Claim | null = null;
  let currentLine: Era835ServiceLine | null = null;

  const closeClaim = () => {
    if (!currentClaim) return;
    if (currentLine) {
      currentClaim.service_lines.push(currentLine);
      currentLine = null;
    }
    file.claims.push(currentClaim);
    currentClaim = null;
  };

  const closeLine = () => {
    if (!currentClaim || !currentLine) return;
    currentClaim.service_lines.push(currentLine);
    currentLine = null;
  };

  for (const seg of segments) {
    switch (seg.tag) {
      case 'BPR':
        file.header.total_paid = num(seg.fields[1]);
        file.header.payment_date = parseDtm(seg.fields[15]);
        break;
      case 'TRN':
        // TRN*1*<trace#>*<originating company>
        file.header.trace_number = seg.fields[1] ?? undefined;
        break;
      case 'N1': {
        // N1*<entity qualifier>*<name>
        const qualifier = seg.fields[0];
        const name = seg.fields[1];
        if (qualifier === 'PR' && name) file.header.payer_name = name;
        else if (qualifier === 'PE' && name) file.header.payee_name = name;
        break;
      }
      case 'CLP': {
        closeClaim();
        currentClaim = {
          ...parseClp(seg),
          adjustments: [],
          rarc_codes: [],
          service_lines: [],
        };
        break;
      }
      case 'CAS': {
        const adjustments = parseCas(seg);
        if (currentLine) currentLine.adjustments.push(...adjustments);
        else if (currentClaim) currentClaim.adjustments.push(...adjustments);
        break;
      }
      case 'NM1': {
        // NM1*QC*<…>*<last>*<first>*…*<id qualifier>*<id>
        // QC = patient. We DON'T store name; just a synthesized hashed id if
        // the upstream hasn't already provided one.
        const qualifier = seg.fields[0];
        if (qualifier === 'QC' && currentClaim && !currentClaim.patient_external_id) {
          // Use member id (field 8) if present; never the name.
          const memberId = seg.fields[8];
          if (memberId) currentClaim.patient_external_id = memberId;
        }
        break;
      }
      case 'DTM': {
        // DTM*<qualifier>*<CCYYMMDD>
        const qualifier = seg.fields[0];
        const date = parseDtm(seg.fields[1]);
        if (!date) break;
        if (qualifier === '472') {
          // Service date
          if (currentLine) currentLine.service_dos = date;
          else if (currentClaim && !currentClaim.service_dos) currentClaim.service_dos = date;
        }
        break;
      }
      case 'SVC': {
        if (!currentClaim) break;
        closeLine();
        currentLine = {
          ...parseSvc(seg, delim),
          adjustments: [],
          rarc_codes: [],
        };
        break;
      }
      case 'LQ': {
        const rarc = parseLqRarc(seg);
        if (!rarc) break;
        if (currentLine) currentLine.rarc_codes.push(rarc);
        else if (currentClaim) currentClaim.rarc_codes.push(rarc);
        break;
      }
      case 'SE':
      case 'GE':
      case 'IEA':
        closeClaim();
        break;
      // Ignored / not relevant to denial intelligence
      case 'ISA':
      case 'GS':
      case 'ST':
      case 'REF':
      case 'PER':
      case 'AMT':
      case 'QTY':
      case 'MIA':
      case 'MOA':
      case 'PLB':
        break;
      default:
        file.unparsed_segments.push(seg.raw);
    }
  }
  // Make sure we don't drop the last claim if the file ended without IEA.
  closeClaim();

  return file;
}
