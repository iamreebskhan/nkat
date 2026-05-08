/**
 * k6 load test for POST /v1/synthesis — the LLM-backed endpoint.
 *
 *   k6 run --vus 20 --duration 5m -e BASE_URL=http://localhost:3000 \
 *     -e ORG_ID=<uuid> loadtest/synthesis.k6.js
 *
 * Synthesis is bursty (LLM latency dominates) and cache-sensitive
 * (we want the synthesis_cache hit rate to climb as the test runs).
 * SLO: p95 < 8s, p99 < 15s, error rate < 0.5%. Lower throughput than
 * lookup because each request potentially burns LLM tokens.
 *
 * The test runs in three stages:
 *   1. cold — 1 minute @ 2 RPS to seed the cache.
 *   2. warm — 3 minutes @ 10 RPS to exercise cache hits.
 *   3. mixed — 1 minute @ 5 RPS with random nonces to force cache misses.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const ORG_ID = __ENV.ORG_ID || '11111111-1111-4111-8111-111111111111';

const cacheHits = new Counter('synthesis_cache_hits');
const cacheMisses = new Counter('synthesis_cache_misses');
const synthLatency = new Trend('synthesis_latency_ms', true);
const errs = new Rate('synthesis_errors');

export const options = {
  scenarios: {
    cold: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 5,
      maxVUs: 20,
      startTime: '0s',
      exec: 'coldStage',
    },
    warm: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 20,
      maxVUs: 80,
      startTime: '1m',
      exec: 'warmStage',
    },
    mixed: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 10,
      maxVUs: 40,
      startTime: '4m',
      exec: 'mixedStage',
    },
  },
  thresholds: {
    'http_req_failed{stage:warm}': ['rate<0.005'],
    'http_req_duration{stage:warm}': ['p(95)<8000', 'p(99)<15000'],
    synthesis_errors: ['rate<0.01'],
  },
};

const TOPICS = [
  'modifier 25 with E/M and procedure',
  'CCM 99490 documentation requirements',
  'RPM 99453 16-day rule',
  'NCCI PTP modifier indicator',
  'palliative care 99497 ACP requirements',
];

function randomFrom(a) {
  return a[Math.floor(Math.random() * a.length)];
}

function payload(topic, nonce) {
  return JSON.stringify({
    topic: nonce ? `${topic} ${nonce}` : topic,
    state: 'OH',
    payer_slug: 'aetna',
    product_line: 'medicare_ffs',
  });
}

function fire(topic, nonce, stage) {
  const t0 = Date.now();
  const res = http.post(`${BASE_URL}/v1/synthesis`, payload(topic, nonce), {
    headers: {
      'Content-Type': 'application/json',
      'X-Org-Id': ORG_ID,
    },
    tags: { stage },
  });
  synthLatency.add(Date.now() - t0, { stage });
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has answer': (r) => {
      try {
        return typeof r.json().answer === 'string';
      } catch {
        return false;
      }
    },
  });
  errs.add(!ok);
  // Cache hit signal — service emits an `x-synthesis-cache: hit|miss` header.
  const cacheHdr = res.headers['x-synthesis-cache'] || res.headers['X-Synthesis-Cache'];
  if (cacheHdr === 'hit') cacheHits.add(1);
  else if (cacheHdr === 'miss') cacheMisses.add(1);
}

export function coldStage() {
  fire(randomFrom(TOPICS), null, 'cold');
  sleep(0.05);
}

export function warmStage() {
  fire(randomFrom(TOPICS), null, 'warm');
  sleep(0.05);
}

export function mixedStage() {
  // 50% nonces force cache miss
  const useNonce = Math.random() < 0.5;
  fire(randomFrom(TOPICS), useNonce ? `${Date.now()}` : null, 'mixed');
  sleep(0.05);
}
