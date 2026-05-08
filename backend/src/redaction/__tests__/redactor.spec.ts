import { redactPhi } from '../redactor';

describe('redactPhi — SSN', () => {
  it('redacts dashed SSNs', () => {
    const r = redactPhi('Patient SSN 123-45-6789 on file.');
    expect(r.redacted).toContain('[REDACTED:SSN]');
    expect(r.redacted).not.toContain('123-45-6789');
    expect(r.category_counts.ssn).toBe(1);
  });

  it('redacts space-separated SSNs', () => {
    const r = redactPhi('SSN 123 45 6789');
    expect(r.category_counts.ssn).toBe(1);
  });

  it('redacts unspaced 9-digit SSN', () => {
    const r = redactPhi('SSN 123456789');
    expect(r.category_counts.ssn).toBe(1);
  });

  it('does not redact obviously invalid SSNs (000, 666, 9XX area)', () => {
    const r = redactPhi('IDs: 000-12-3456 666-12-3456 900-12-3456');
    expect(r.category_counts.ssn).toBe(0);
  });
});

describe('redactPhi — MRN/Member ID/ICN', () => {
  it('redacts MRN with various label forms', () => {
    const r = redactPhi('MRN: ABC-12345\nMedical Record Number: 9876543\nChart # 0001234');
    expect(r.category_counts.mrn).toBe(3);
    expect(r.redacted).not.toContain('ABC-12345');
    expect(r.redacted).not.toContain('9876543');
  });

  it('redacts member ID forms', () => {
    const r = redactPhi('Member ID: W12345678\nSubscriber: Z-998877\nPatient ID 1234567');
    expect(r.category_counts.member_id).toBe(3);
  });

  it('redacts ICN when labelled', () => {
    const r = redactPhi('Claim # 1234567890123 was denied. ICN 9876543210987.');
    expect(r.category_counts.icn).toBeGreaterThanOrEqual(2);
  });

  it('does NOT redact unlabelled long digit runs (avoids false positives on CPT/HCPCS)', () => {
    const r = redactPhi('CPT 99497 has revenue code 0651 mapped.');
    expect(r.category_counts.member_id).toBe(0);
    expect(r.category_counts.mrn).toBe(0);
    expect(r.category_counts.icn).toBe(0);
  });
});

describe('redactPhi — DOB / dates', () => {
  it('redacts DOB in DOB:MM/DD/YYYY form', () => {
    const r = redactPhi('Patient seen for ACP. DOB: 4/12/1950.');
    expect(r.category_counts.dob).toBe(1);
    expect(r.redacted).not.toContain('4/12/1950');
  });

  it('redacts DOB in DOB MM-DD-YY form', () => {
    const r = redactPhi('DOB 04-12-50.');
    expect(r.category_counts.dob).toBe(1);
  });

  it('redacts DOB in ISO form when labelled', () => {
    const r = redactPhi('d.o.b. 1950-04-12');
    expect(r.category_counts.dob).toBe(1);
  });

  it('does not redact DOS (date of service) when written as ISO', () => {
    const r = redactPhi('DOS 2026-04-15. Service performed.');
    expect(r.category_counts.dob).toBe(0);
  });
});

describe('redactPhi — phone, email, name', () => {
  it('redacts phone numbers in several formats', () => {
    const r = redactPhi('Call (614) 555-1212 or 614.555.1213 or +1-614-555-1214.');
    expect(r.category_counts.phone).toBe(3);
  });

  it('redacts emails', () => {
    const r = redactPhi('Send to biller@example.com or jane.doe+filter@hospital.org');
    expect(r.category_counts.email).toBe(2);
  });

  it('redacts patient names following an explicit label', () => {
    const r = redactPhi('Patient: John A Smith, hospice eligible.');
    expect(r.category_counts.name_titled).toBe(1);
    expect(r.redacted).not.toContain('John A Smith');
  });

  it('does not redact ordinary capitalized phrases without "Patient" label', () => {
    const r = redactPhi('Medicare Final Rule from CMS Headquarters in Baltimore.');
    expect(r.category_counts.name_titled).toBe(0);
  });
});

describe('redactPhi — totals + idempotency', () => {
  it('sums total_redactions across categories', () => {
    const r = redactPhi('SSN 123-45-6789 DOB: 4/12/1950 phone (614) 555-1212');
    expect(r.total_redactions).toBe(r.category_counts.ssn + r.category_counts.dob + r.category_counts.phone);
    expect(r.total_redactions).toBe(3);
  });

  it('returns the same redacted text on second pass (idempotent)', () => {
    const r1 = redactPhi('SSN 123-45-6789');
    const r2 = redactPhi(r1.redacted);
    expect(r1.redacted).toBe(r2.redacted);
    expect(r2.total_redactions).toBe(0);
  });

  it('returns counts of 0 for clean text', () => {
    const r = redactPhi('Aetna covers 99497 in Ohio when Z51.5 is on the claim.');
    expect(r.total_redactions).toBe(0);
    expect(r.redacted).toBe('Aetna covers 99497 in Ohio when Z51.5 is on the claim.');
  });

  it('does not throw on empty input', () => {
    const r = redactPhi('');
    expect(r.redacted).toBe('');
    expect(r.total_redactions).toBe(0);
  });
});

describe('redactPhi — address/zip/npi/account', () => {
  it('redacts a US street address', () => {
    const r = redactPhi('Lives at 123 Oak Street.');
    expect(r.category_counts.address).toBe(1);
    expect(r.redacted).toContain('[REDACTED:ADDRESS]');
  });

  it('redacts ZIP only in city/state context', () => {
    const r = redactPhi('Cleveland, OH 44109');
    expect(r.category_counts.zip).toBe(1);
    expect(r.redacted).toContain('[REDACTED:ZIP]');
    // Bare 5-digit code with no city/state context is left alone.
    const r2 = redactPhi('Order count: 44109 units shipped.');
    expect(r2.category_counts.zip).toBe(0);
  });

  it('redacts a labelled NPI', () => {
    const r = redactPhi('NPI 1234567893 on the claim.');
    expect(r.category_counts.npi).toBe(1);
    expect(r.redacted).toContain('NPI: [REDACTED:NPI]');
  });

  it('does NOT redact bare 10-digit run', () => {
    const r = redactPhi('reference 1234567893');
    expect(r.category_counts.npi).toBe(0);
  });

  it('redacts a labelled account number', () => {
    const r = redactPhi('Account: ACCT-9988 on file.');
    expect(r.category_counts.account).toBe(1);
  });
});
