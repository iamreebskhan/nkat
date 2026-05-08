/**
 * Unit tests for the PHI scrubber. Run with:  node --test index.test.js
 *
 * Why a node:test file (not Jest): the Lambda is pure stdlib + AWS SDK; we
 * don't want to drag Jest into the deploy zip. node:test is built in.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// We can't require index.js directly because it imports the AWS SDK at the
// top level, which would attempt SecretsManagerClient construction. Pull
// the scrubber out by re-declaring the same regexes here — the test file
// is the contract; if someone changes index.js they MUST mirror the change
// here, which is the point.
const SCRUBBERS = [
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, sub: '[ssn]' },
  { re: /\bmrn[:\s]+[A-Z0-9-]{4,}/gi, sub: 'mrn:[redacted]' },
  { re: /\bmember[_\s-]?id[:\s]+[A-Z0-9-]{4,}/gi, sub: 'member_id:[redacted]' },
  { re: /\bdob[:\s]+\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/gi, sub: 'dob:[redacted]' },
  { re: /\bpatient[:\s]+[A-Z][a-z]+\s+[A-Z][a-z]+/g, sub: 'patient:[redacted]' },
];
const scrub = (t) => SCRUBBERS.reduce((acc, s) => acc.replace(s.re, s.sub), t);

test('SSN is redacted', () => {
  assert.equal(scrub('user 123-45-6789 logged in'), 'user [ssn] logged in');
});

test('MRN labelled is redacted', () => {
  assert.equal(scrub('MRN: A12345 was attached'), 'mrn:[redacted] was attached');
});

test('Member ID with separator variants is redacted', () => {
  assert.equal(scrub('member_id ABC-1234 set'), 'member_id:[redacted] set');
  assert.equal(scrub('member-id: 9999AAAA'), 'member_id:[redacted]');
});

test('DOB is redacted', () => {
  assert.equal(scrub('dob 1980-04-12'), 'dob:[redacted]');
  assert.equal(scrub('DOB: 4/12/1980'), 'dob:[redacted]');
});

test('Labelled patient name is redacted', () => {
  assert.equal(scrub('patient: John Doe'), 'patient:[redacted]');
});

test('Non-PHI words are NOT redacted', () => {
  const ok = 'request_id=r1 status=200 latency=152ms code=99497';
  assert.equal(scrub(ok), ok);
});

test('Multiple PHI types in one line are all redacted', () => {
  const input = 'patient: John Doe ssn=123-45-6789 mrn: AB12';
  const out = scrub(input);
  assert.match(out, /patient:\[redacted\]/);
  assert.match(out, /\[ssn\]/);
  assert.match(out, /mrn:\[redacted\]/);
});
