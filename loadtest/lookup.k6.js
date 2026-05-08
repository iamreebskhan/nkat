/**
 * k6 load test for POST /v1/lookup.
 *
 *   k6 run --vus 50 --duration 5m -e BASE_URL=http://localhost:3000 -e ORG_ID=<uuid> loadtest/lookup.k6.js
 *
 * Phase 1 SLO target: p95 < 2s, error rate < 0.1%. Thresholds below enforce
 * those — k6 exits non-zero if either is violated.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const ORG_ID = __ENV.ORG_ID || '11111111-1111-4111-8111-111111111111';
const PAYER_ID = __ENV.PAYER_ID || 'a0000000-0000-4000-8000-000000000301'; // Aetna seed
const STATE = __ENV.STATE || 'OH';
const PRODUCT_LINE = __ENV.PRODUCT_LINE || 'medicare_ffs';

const lookupLatency = new Trend('lookup_latency_ms', true);
const refusalRate = new Rate('lookup_refusals');

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RPS || 25),
      timeUnit: '1s',
      duration: __ENV.DURATION || '5m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],         // <0.1% error rate
    http_req_duration: ['p(95)<2000'],       // p95 < 2s
    'lookup_latency_ms{tag:full}': ['p(95)<2000'],
  },
};

const PALLIATIVE_CODES = [
  '99497', '99498', '99347', '99348', '99349', '99350', 'G0318',
];

function randomFrom(a) {
  return a[Math.floor(Math.random() * a.length)];
}

export default function () {
  const code = randomFrom(PALLIATIVE_CODES);
  const body = {
    payer_id: PAYER_ID,
    state: STATE,
    product_line: PRODUCT_LINE,
    date_of_service: '2026-04-15',
    lines: [{ code }],
    diagnoses: ['Z51.5'],
  };

  const t0 = Date.now();
  const res = http.post(`${BASE_URL}/v1/lookup`, JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'X-Org-Id': ORG_ID,
    },
    tags: { tag: 'full' },
  });
  lookupLatency.add(Date.now() - t0, { tag: 'full' });

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has overall_severity': (r) => {
      try {
        const j = r.json();
        return ['critical', 'warning', 'info', 'ok'].includes(j.overall_severity);
      } catch (_e) {
        return false;
      }
    },
  });
  refusalRate.add(!ok);

  sleep(0.05); // 50ms think-time per VU
}
