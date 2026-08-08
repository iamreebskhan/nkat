/**
 * Verify round 2 of the denial-rule extraction through the real lookup
 * path, not by re-reading the rows we just wrote.
 *
 * Checking that a SELECT returns the row we INSERTed proves nothing. What
 * matters is what lookupRule() hands a nurse practitioner at the point of
 * billing, so this drives that function and asserts on its output.
 *
 *   npx tsx scripts/verify-denial-rules-round2.ts
 */
import { lookupRule } from '../lib/features/billing/rule-lookup.service';

const UHC = 'a0000000-0000-4000-8000-000000000302';
const ANTHEM = 'a0000000-0000-4000-8000-000000000303';
const DOS = '2026-06-15';

type Check = {
  what: string;
  payerId: string;
  code: string;
  attribute: string;
  /** Substrings the answer must contain — the substance, not the phrasing. */
  must: string[];
  /** Substrings that must NOT appear: the wrong-mapping failures. */
  mustNot?: string[];
};

const CHECKS: Check[] = [
  {
    what: 'UHC OH — who may bill a home visit (the E/M provider-type edit)',
    payerId: UHC, code: '99349', attribute: 'provider_taxonomy_allowed',
    must: ['nurse practitioner', 'physician assistant', 'own individual or group TIN'],
    mustNot: ['home health visits require prior authorization'],
  },
  {
    what: 'UHC OH — 99348 answered with the payer\'s own worked example',
    payerId: UHC, code: '99348', attribute: 'provider_taxonomy_allowed',
    must: ['99348', 'home health specialty'],
  },
  {
    what: 'UHC OH — telehealth practitioner list must not be read as E/M eligibility',
    payerId: UHC, code: '99350', attribute: 'provider_taxonomy_allowed',
    must: ['clinical social worker', 'NOT a list of who may report an E/M code'],
  },
  {
    what: 'UHC OH — G0180 is outside the E/M policy, and says so',
    payerId: UHC, code: 'G0180', attribute: 'provider_taxonomy_allowed',
    must: ['screened, enrolled and credentialed', 'outside those ranges'],
    mustNot: ['may not report this code because it is an E/M code'],
  },
  {
    what: 'UHC OH — prior auth turns on network status, not on the service',
    payerId: UHC, code: '99349', attribute: 'prior_auth_required',
    must: ['OUT-OF-NETWORK', 'emergency or urgent care'],
    mustNot: ['after five visits'],
  },
  {
    what: 'UHC OH — the home health G-code row must not leak onto physician visits',
    payerId: UHC, code: '99341', attribute: 'prior_auth_required',
    must: ['does NOT govern physician home-visit E/M'],
  },
  {
    what: 'UHC OH — documentation covers the visit note and the telehealth addition',
    payerId: UHC, code: '99347', attribute: 'documentation_required',
    must: ['chief complaint', 'audio-video telecommunications'],
  },
  {
    what: 'UHC OH — frequency limit is admitted as unpublished, not invented',
    payerId: UHC, code: '99350', attribute: 'frequency_limit',
    must: ['does NOT publish the numeric limit', 'medical records justifying medical necessity'],
  },
  {
    what: 'Anthem OH — MH/SUD home and prolonged visits are exempt',
    payerId: ANTHEM, code: '99349', attribute: 'prior_auth_required',
    must: ['mental health', 'home and prolonged visits', 'secondary payer'],
    mustNot: ['after 18 combined visits require prior authorization for this code'],
  },
  {
    what: 'Anthem OH — home health agency PA rule recorded as OUT of scope',
    payerId: ANTHEM, code: '99348', attribute: 'prior_auth_required',
    must: ['home health agency benefits', 'not listed'],
  },
  {
    what: 'Anthem OH — 99499 is an unlisted code and needs prior auth',
    payerId: ANTHEM, code: '99499', attribute: 'prior_auth_required',
    must: ['unlisted', 'codes ending in 99'],
  },
  {
    what: 'Anthem OH — care management gets the network rule, not the MH/SUD carve-out',
    payerId: ANTHEM, code: '99490', attribute: 'prior_auth_required',
    must: ['OUT-OF-NETWORK'],
    mustNot: ['including home and prolonged visits, so no prior authorization is required'],
  },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

async function main() {
  let passed = 0;
  const failures: string[] = [];

  for (const c of CHECKS) {
    let answer = '';
    let scope = '';
    let quote = '';
    let failNote = '';
    try {
      const res = await lookupRule({
        payerId: c.payerId, state: 'OH', cptCode: c.code,
        attribute: c.attribute, dos: DOS,
      } as Parameters<typeof lookupRule>[0]);
      answer = res.answer ?? '';
      scope = res.source;
      quote = res.citation?.verbatimQuote ?? '';
      if (res.status !== 'ok') failNote = `status=${res.status}`;
      // A rule the biller cannot trace back to a sentence in the payer's
      // own document is not usable evidence in an appeal.
      if (!quote) failNote = 'no verbatim citation attached';
      if (!res.citation?.documentUrl) failNote = 'citation has no document URL';
    } catch (err) {
      failures.push(`${c.what}\n    threw: ${(err as Error).message}`);
      console.log(`FAIL  ${c.what}\n        threw: ${(err as Error).message}`);
      continue;
    }

    const hay = norm(answer);
    const missing = c.must.filter((m) => !hay.includes(norm(m)));
    const present = (c.mustNot ?? []).filter((m) => hay.includes(norm(m)));
    // A rule this seed wrote must be answered from the structured library.
    // 'ai_synthesized' or 'unknown' would mean the row is unreachable and
    // the biller is getting a guess instead of the payer's own document.
    const wrongScope =
      scope === 'structured_rule' ? [] : [`answered from '${scope}', not the payer's own rule`];
    if (failNote) wrongScope.push(failNote);

    if (!missing.length && !present.length && !wrongScope.length) {
      passed++;
      console.log(`OK    ${c.what}`);
      if (quote) console.log(`        cites: "${quote.slice(0, 88)}…"`);
    } else {
      const why = [
        ...missing.map((m) => `missing "${m}"`),
        ...present.map((m) => `must not contain "${m}"`),
        ...wrongScope,
      ].join('; ');
      failures.push(`${c.what}\n    ${why}`);
      console.log(`FAIL  ${c.what}\n        ${why}`);
    }
  }

  console.log(`\n${passed}/${CHECKS.length} passed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log('  ' + f);
    process.exit(1);
  }
}

main().then(() => process.exit(0));
