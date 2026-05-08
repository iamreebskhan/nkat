/**
 * Datadog forwarder Lambda. Receives a CloudWatch Logs subscription event,
 * gunzips the payload, applies a defense-in-depth PHI scrubber, batches
 * records, and POSTs to Datadog's HTTP intake.
 *
 * Runtime: nodejs20.x. Pure stdlib — no bundler, no node_modules. Keeps
 * the deploy zip small and the cold-start fast.
 */

'use strict';

const https = require('node:https');
const zlib = require('node:zlib');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const DD_SITE = process.env.DD_SITE || 'datadoghq.com';
const DD_HOST = `http-intake.logs.${DD_SITE}`;
const DD_SERVICE = process.env.DD_SERVICE || 'billing-rules';
const DD_ENV = process.env.DD_ENV || 'unknown';
const DD_KEY_ARN = process.env.DD_API_KEY_SECRET_ARN;

let cachedKey = null;
const sm = new SecretsManagerClient({});

async function getApiKey() {
  if (cachedKey) return cachedKey;
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: DD_KEY_ARN }));
  cachedKey = resp.SecretString;
  return cachedKey;
}

// PHI scrubber — defense in depth. Production logger middleware redacts
// before write; this is a second pass before egress.
const SCRUBBERS = [
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, sub: '[ssn]' },                // SSN xxx-xx-xxxx
  { re: /\bmrn[:\s]+[A-Z0-9-]{4,}/gi, sub: 'mrn:[redacted]' },
  { re: /\bmember[_\s-]?id[:\s]+[A-Z0-9-]{4,}/gi, sub: 'member_id:[redacted]' },
  { re: /\bdob[:\s]+\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/gi, sub: 'dob:[redacted]' },
  { re: /\bpatient[:\s]+[A-Z][a-z]+\s+[A-Z][a-z]+/g, sub: 'patient:[redacted]' },
];

function scrub(text) {
  let out = text;
  for (const s of SCRUBBERS) out = out.replace(s.re, s.sub);
  return out;
}

function postBatch(apiKey, lines) {
  return new Promise((resolve, reject) => {
    const body = lines.map((l) => JSON.stringify(l)).join('\n');
    const req = https.request(
      {
        host: DD_HOST,
        path: '/api/v2/logs',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'dd-api-key': apiKey,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Datadog ${res.statusCode}: ${Buffer.concat(chunks)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const apiKey = await getApiKey();
  // CloudWatch Logs subscription payload is gzip+base64 in event.awslogs.data.
  const compressed = Buffer.from(event.awslogs.data, 'base64');
  const json = zlib.gunzipSync(compressed).toString('utf8');
  const payload = JSON.parse(json);

  const records = (payload.logEvents || []).map((e) => ({
    timestamp: e.timestamp,
    message: scrub(e.message),
    service: DD_SERVICE,
    env: DD_ENV,
    ddtags: `log_group:${payload.logGroup},log_stream:${payload.logStream}`,
    ddsource: 'cloudwatch',
  }));

  // Datadog accepts up to 5MB / 1000 entries per request; chunk to be safe.
  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    await postBatch(apiKey, records.slice(i, i + CHUNK));
  }
};
