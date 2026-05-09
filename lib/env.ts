/**
 * Pallio environment variables — Zod-validated at startup.
 *
 * Importing this module at any boot path will throw early if a
 * required variable is missing. Lazy-evaluate inside helpers so
 * a missing var in one feature doesn't crash unrelated routes.
 *
 * Source: pallio_complete_vision_v3 §18.1.
 */
import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Database (Postgres + pgvector — carried over from billing-rules-platform).
  DATABASE_URL: z.string().min(1),

  // Auth — JWT signed with HS256 in dev, RS256 in prod (TODO when we add OIDC).
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  COOKIE_NAME: z.string().default("pallio_session"),

  // AI providers
  ANTHROPIC_API_KEY: z.string().optional(),  // Required for rule synthesis
  OPENAI_API_KEY: z.string().optional(),     // Required for embeddings only

  // Email
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM_ADDRESS: z.string().email().default("no-reply@pallio.local"),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Storage
  UPLOAD_DIR: z.string().default("./var/uploads"),
  MAX_FILE_SIZE_MB: z.coerce.number().default(2000),
  CHUNK_SIZE_MB: z.coerce.number().default(5),

  // App
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),

  // AMA license — when unset, CPT short_descriptors are gated.
  AMA_LICENSE_TOKEN: z.string().optional(),
});

let _env: z.infer<typeof Schema> | null = null;

export function env(): z.infer<typeof Schema> {
  if (_env) return _env;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  _env = parsed.data;
  return _env;
}
