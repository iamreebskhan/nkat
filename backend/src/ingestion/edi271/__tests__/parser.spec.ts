import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEdi271 } from '../parser';

const FIXTURE = readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'sample-271.txt'),
  'utf8',
);

describe('parseEdi271 — fixture', () => {
  it('parses header (payer + provider + trace)', () => {
    const out = parseEdi271(FIXTURE);
    expect(out.header.payer_name).toBe('MEDICARE PALMETTO GBA');
    expect(out.header.provider_name).toBe('ACME HOSPICE LLC');
    // The fixture's TRN is at the BHT level; the parser only stores TRN
    // segments. Our fixture has BHT (no TRN), so trace_number is undefined.
    expect(out.header.trace_number).toBeUndefined();
  });

  it('parses one subscriber', () => {
    const out = parseEdi271(FIXTURE);
    expect(out.subscribers).toHaveLength(1);
  });

  it('captures subscriber id (member id) but never the name', () => {
    const out = parseEdi271(FIXTURE);
    const s = out.subscribers[0];
    expect(s.subscriber_id).toBe('MEMBER-HASH-1');
    const json = JSON.stringify(out);
    expect(json).not.toContain('PATIENT');
    expect(json).not.toContain('ANONYMIZED');
  });

  it('captures group id from REF*6P', () => {
    const out = parseEdi271(FIXTURE);
    expect(out.subscribers[0].group_id).toBe('GROUP-XYZ');
  });

  it('captures coverage start + end dates', () => {
    const out = parseEdi271(FIXTURE);
    const s = out.subscribers[0];
    expect(s.coverage_start).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(s.coverage_end).toEqual(new Date(Date.UTC(2026, 11, 31)));
  });

  it('parses Active Coverage benefit (EB*1)', () => {
    const out = parseEdi271(FIXTURE);
    const benefits = out.subscribers[0].benefits;
    const active = benefits[0];
    expect(active.eligibility_code).toBe('1');
    expect(active.service_type_codes).toEqual(['30', 'MH', 'AL']);
    expect(active.insurance_type_code).toBe('HM');
    expect(active.message_text).toEqual(['Active coverage for medical / mental health / SUD']);
  });

  it('parses copay benefit (EB*B with monetary amount)', () => {
    const out = parseEdi271(FIXTURE);
    const copay = out.subscribers[0].benefits[1];
    expect(copay.eligibility_code).toBe('B');
    expect(copay.service_type_codes).toEqual(['MH']);
    expect(copay.monetary_amount).toBe(30);
  });

  it('parses out-of-pocket max benefit (EB*C with monetary amount)', () => {
    const out = parseEdi271(FIXTURE);
    const oop = out.subscribers[0].benefits[2];
    expect(oop.eligibility_code).toBe('C');
    expect(oop.monetary_amount).toBe(1500);
  });

  it('parses Inactive benefit for SUD (EB*6)', () => {
    const out = parseEdi271(FIXTURE);
    const sud = out.subscribers[0].benefits[3];
    expect(sud.eligibility_code).toBe('6');
    expect(sud.service_type_codes).toEqual(['AL']);
  });
});

describe('parseEdi271 — edge cases', () => {
  it('handles empty input', () => {
    const out = parseEdi271('');
    expect(out.subscribers).toHaveLength(0);
  });

  it('handles file without IEA (still returns last subscriber)', () => {
    const out = parseEdi271('NM1*IL*1*X*Y****MI*M-1~EB*1**30****0***Y~');
    expect(out.subscribers).toHaveLength(1);
    expect(out.subscribers[0].subscriber_id).toBe('M-1');
    expect(out.subscribers[0].benefits).toHaveLength(1);
  });

  it('respects custom delimiters', () => {
    const isa =
      'ISA|00|          |00|          |ZZ|P              |ZZ|R              |260415|1234|^|00501|000000001|0|P|:#';
    const body = 'NM1|IL|1|X|Y||||MI|M-9#EB|1||30||||0|||Y#';
    const out = parseEdi271(isa + body);
    expect(out.subscribers[0].subscriber_id).toBe('M-9');
    expect(out.subscribers[0].benefits[0].eligibility_code).toBe('1');
  });

  it('does not throw on multiple subscribers in one file', () => {
    const out = parseEdi271(
      'NM1*IL*1*X*Y****MI*M-1~EB*1**30****0***Y~NM1*IL*1*X*Y****MI*M-2~EB*1**30****0***Y~',
    );
    expect(out.subscribers).toHaveLength(2);
    expect(out.subscribers[0].subscriber_id).toBe('M-1');
    expect(out.subscribers[1].subscriber_id).toBe('M-2');
  });

  it('treats non-Y/N network indicator as undefined', () => {
    const out = parseEdi271('NM1*IL*1*X*Y****MI*M-1~EB*1**30****0***W~');
    expect(out.subscribers[0].benefits[0].in_plan_network).toBeUndefined();
  });

  it('does not lose unparsed segments', () => {
    const out = parseEdi271('FOO*1*2*3~NM1*IL*1*X*Y****MI*M-1~');
    expect(out.unparsed_segments).toEqual(['FOO*1*2*3']);
  });
});
