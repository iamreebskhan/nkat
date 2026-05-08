/**
 * Environment validation. Fails fast at startup if anything is missing or
 * malformed. Single source of truth for all process.env access.
 */
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Postgres
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().positive().default(5432),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PGSSLMODE: z.enum(['disable', 'require', 'verify-ca', 'verify-full']).default('disable'),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5_000),

  // External APIs (placeholders for Phase 1; real tokens applied in Phase 0 manual work)
  CMS_COVERAGE_API_TOKEN: z.string().optional(),
  CMS_COVERAGE_API_BASE_URL: z.string().url().default('https://api.coverage.cms.gov'),

  // Bedrock (LLM synthesis lands later in Phase 1)
  BEDROCK_REGION: z.string().default('us-east-1'),
  BEDROCK_MODEL_SYNTHESIS: z.string().default('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  BEDROCK_MODEL_PARSER: z.string().default('anthropic.claude-3-5-haiku-20241022-v1:0'),

  // Auth (dev mode: trust X-Org-Id header; production: JWT verification)
  AUTH_MODE: z.enum(['dev_header', 'jwt']).default('dev_header'),
  JWT_PUBLIC_KEY: z.string().optional(),
  /** IdP JWKS endpoint (preferred over JWT_PUBLIC_KEY). e.g. https://idp/.well-known/jwks.json */
  JWT_JWKS_URL: z.string().url().optional(),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),

  // OIDC SSO (optional). When set, /v1/auth/sso/start kicks off the
  // authorization-code flow. Until then the endpoint returns 503 and
  // the frontend hides its SSO button (via /v1/auth/mode).
  OIDC_AUTHORIZATION_URL: z.string().url().optional(),
  OIDC_TOKEN_URL: z.string().url().optional(),
  OIDC_JWKS_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_SCOPE: z.string().optional(),

  // Frontend URL the SSO callback redirects to after a successful code
  // exchange. The session token is appended as a URL fragment
  // (`#token=...&next=...`) so it never lands in server logs. Defaults
  // to APP_BASE_URL when unset.
  SSO_FRONTEND_REDIRECT: z.string().url().optional(),

  // RSA private key (PEM, pkcs8) for signing our own session JWTs after
  // an OIDC code exchange. The corresponding PUBLIC key MUST be set in
  // JWT_PUBLIC_KEY so AuthGuard can verify what we sign. Generate with:
  //   node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('rsa',{modulusLength:2048});console.log(privateKey.export({type:'pkcs8',format:'pem'}));console.log(publicKey.export({type:'spki',format:'pem'}))"
  SESSION_SIGNING_PRIVATE_KEY: z.string().optional(),
  SESSION_TTL_SEC: z.coerce.number().int().positive().default(3600),

  // AES-256 master key (base64) for tenant clearinghouse credential
  // encryption-at-rest. 32 bytes after decode. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  // Production reads it from Secrets Manager. Optional in dev — when
  // unset, the credential feature is disabled but the app boots.
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),

  // AMA CPT license token. When set, CPT short_descriptors flow
  // through code-lookup endpoints unchanged. When unset, CPT
  // descriptors are replaced with "[AMA license required]" — the
  // codes themselves still work for downstream rule lookup.
  // HCPCS Level II (G/J/A codes) is CMS public domain; never gated.
  AMA_LICENSE_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const formatted = parsed.error.errors
      .map((e) => `  ${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }
  return parsed.data;
}
