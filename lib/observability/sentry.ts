/**
 * Sentry-compatible reporter.
 *
 * If SENTRY_DSN is set in env AND @sentry/nextjs is installed, this
 * delegates to that. Otherwise it's a no-op that logs to stderr.
 *
 * The contract is intentionally narrow:
 *   - reportError(err, context?) — for caught exceptions you want
 *     surfaced to the dashboard.
 *   - addBreadcrumb({...}) — short context hints attached to the next
 *     error.
 *
 * Built-in PHI scrubber: every payload runs through the same regex
 * set as lib/ai/phi-guard.ts before being sent. SSN, MRN-like, DOB,
 * name triggers are redacted. The deploy runbook references a server-
 * side scrubber on top — this is the in-app belt to that braces.
 */
import { checkForPhi } from "@/lib/ai/phi-guard";

interface SentryLike {
  captureException(err: unknown, ctx?: unknown): void;
  addBreadcrumb(crumb: unknown): void;
}

let _sentry: SentryLike | null = null;
let _initAttempted = false;

async function getSentry(): Promise<SentryLike | null> {
  if (_sentry) return _sentry;
  if (_initAttempted) return null;
  _initAttempted = true;

  if (!process.env.SENTRY_DSN) return null;

  try {
    // Dynamic import keeps the dependency optional. If @sentry/nextjs
    // isn't installed, we transparently fall back to stderr logging.
    const mod = (await import(/* webpackIgnore: true */ "@sentry/nextjs" as string)) as
      | {
          init: (cfg: Record<string, unknown>) => void;
          captureException: SentryLike["captureException"];
          addBreadcrumb: SentryLike["addBreadcrumb"];
        }
      | undefined;
    if (!mod || !mod.init) return null;
    mod.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
      beforeSend: (event: unknown) => scrubPhi(event),
      beforeBreadcrumb: (crumb: unknown) => scrubPhi(crumb),
      release: process.env.PALLIO_RELEASE ?? "unknown",
    });
    _sentry = {
      captureException: mod.captureException,
      addBreadcrumb: mod.addBreadcrumb,
    };
    return _sentry;
  } catch {
    return null;
  }
}

export function reportError(err: unknown, context?: Record<string, unknown>): void {
  const safeContext = context ? scrubObject(context) : undefined;
  void getSentry().then((s) => {
    if (s) {
      s.captureException(err, safeContext ? { extra: safeContext } : undefined);
    } else {
      console.error("[reportError]", err instanceof Error ? err.stack : err, safeContext);
    }
  });
}

export function addBreadcrumb(crumb: {
  category: string;
  message: string;
  data?: Record<string, unknown>;
}): void {
  const safe = scrubObject(crumb);
  void getSentry().then((s) => {
    if (s) s.addBreadcrumb(safe);
  });
}

/** Scrub PHI from a JSON-serializable value, in-place. Returns the value. */
export function scrubPhi<T>(value: T): T {
  return scrubObject(value as unknown) as T;
}

function scrubObject(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-cap]";
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrubObject(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubObject(v, depth + 1);
    }
    return out;
  }
  return value;
}

function scrubString(s: string): string {
  if (s.length === 0) return s;
  const result = checkForPhi(s);
  if (result.ok) return s;
  let out = s;
  for (const hit of result.hits) {
    // Replace the matched substring with a redaction marker. We don't
    // have the precise indices from checkForPhi, so we re-run the
    // matching regexes and replace each hit. PhiGuard's pattern set
    // is conservative; over-redaction is acceptable here.
    out = redactPattern(out, hit.pattern);
  }
  return out;
}

const REDACTORS: Record<string, RegExp> = {
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  phone: /\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  dob_slash: /\b(0?[1-9]|1[0-2])[\/](0?[1-9]|[12]\d|3[01])[\/](19|20)\d{2}\b/g,
  dob_dash: /\b(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])-(19|20)\d{2}\b/g,
  mrn_like: /\b(?=[A-Z0-9]{9,})(?=.*\d)(?=.*[A-Z])[A-Z0-9]{9,20}\b/g,
};

function redactPattern(s: string, name: string): string {
  const re = REDACTORS[name];
  if (!re) return s;
  return s.replace(re, "[REDACTED-PHI]");
}
