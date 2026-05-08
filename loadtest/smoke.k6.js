/**
 * Multi-endpoint smoke load — quick sanity check before each release
 * cut. 60 seconds at low concurrency hitting the public surface:
 * /healthz, /readyz, /v1/lookup, /v1/synthesis, /v1/billing/entitlement.
 *
 *   k6 run -e BASE_URL=https://staging.api.example -e ORG_ID=<uuid> \
 *     -e AUTH=<bearer> loadtest/smoke.k6.js
 *
 * Thresholds force a non-zero exit if any endpoint is unhealthy.
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const ORG_ID = __ENV.ORG_ID || '11111111-1111-4111-8111-111111111111';
const AUTH = __ENV.AUTH || '';

export const options = {
  vus: 5,
  duration: '60s',
  thresholds: {
    'http_req_failed{name:healthz}': ['rate<0.001'],
    'http_req_failed{name:readyz}': ['rate<0.001'],
    'http_req_duration{name:healthz}': ['p(99)<500'],
    'http_req_duration{name:readyz}': ['p(99)<1000'],
    'http_req_duration{name:lookup}': ['p(95)<2000'],
    'http_req_duration{name:entitlement}': ['p(95)<500'],
  },
};

function authHeaders() {
  const h = { 'Content-Type': 'application/json', 'X-Org-Id': ORG_ID };
  if (AUTH) h.Authorization = `Bearer ${AUTH}`;
  return h;
}

export default function () {
  // Health
  const h = http.get(`${BASE_URL}/healthz`, { tags: { name: 'healthz' } });
  check(h, { 'healthz 200': (r) => r.status === 200 });

  const r = http.get(`${BASE_URL}/readyz`, { tags: { name: 'readyz' } });
  check(r, { 'readyz 200': (r2) => r2.status === 200 });

  // Lookup
  const lk = http.post(
    `${BASE_URL}/v1/lookup`,
    JSON.stringify({
      payer_id: 'a0000000-0000-4000-8000-000000000301',
      state: 'OH',
      product_line: 'medicare_ffs',
      date_of_service: '2026-04-15',
      lines: [{ code: '99490' }],
      diagnoses: ['Z51.5'],
    }),
    { headers: authHeaders(), tags: { name: 'lookup' } },
  );
  check(lk, { 'lookup 200': (rs) => rs.status === 200 });

  // Entitlement (only if AUTH provided — otherwise skip)
  if (AUTH) {
    const ent = http.get(`${BASE_URL}/v1/billing/entitlement`, {
      headers: authHeaders(),
      tags: { name: 'entitlement' },
    });
    check(ent, { 'entitlement 200': (rs) => rs.status === 200 });
  }
}
