/**
 * Brute-force throttling for POST /api/auth/login.
 *
 * A live audit of production sent 14 wrong passwords for the same address and
 * got 14 × 401 with nothing in the way — no delay, no lockout, no 429. bcrypt
 * costs an attacker ~700ms per guess, which is a speed bump and not a defence:
 * it parallelises, and the address of a clinician at a named practice is not
 * a secret. This is the gate.
 *
 * THROTTLED BY IP, AND DELIBERATELY NOT BY EMAIL ALONE.
 * The obvious extra rule — "lock an account after N failures" — hands anybody
 * who knows a clinician's work address a button that locks them out of the
 * chart at the bedside. Availability IS a safety property here. A per-address
 * counter is therefore only ever kept per-IP, so one attacker cannot spend
 * someone else's budget, and a legitimate user with the right password is
 * never turned away because of what a stranger typed.
 *
 * The window self-heals: no administrator has to unlock anything, ever.
 *
 * SCOPE, STATED PLAINLY. This is per-process memory. The app runs as a single
 * PM2 process today, so it holds for the whole service; if it is ever scaled
 * to cluster mode or a second host, each worker keeps its own count and the
 * effective limit multiplies by the worker count. It also resets on deploy.
 * Both are acceptable for stopping a password-guessing run and both stop
 * being true the day this scales out — at which point this belongs in
 * Postgres or Redis, and the shape of the code below does not change.
 */

/** Failures allowed from one IP before it is refused, per window. */
const MAX_FAILURES_PER_IP = 10;
/** Failures allowed for one (IP, email) pair — tighter than the IP total. */
const MAX_FAILURES_PER_IP_EMAIL = 5;
/** How long a run of failures is remembered, and so how long a refusal lasts. */
export const WINDOW_MS = 15 * 60 * 1000;

type Bucket = { count: number; firstAt: number };

const buckets = new Map<string, Bucket>();

/** Drop expired buckets so a long-running process cannot grow without bound. */
function sweep(now: number): void {
  if (buckets.size < 512) return;
  for (const [k, b] of buckets) if (now - b.firstAt >= WINDOW_MS) buckets.delete(k);
}

function bump(key: string, now: number): Bucket {
  const existing = buckets.get(key);
  if (!existing || now - existing.firstAt >= WINDOW_MS) {
    const fresh = { count: 1, firstAt: now };
    buckets.set(key, fresh);
    return fresh;
  }
  existing.count += 1;
  return existing;
}

function peek(key: string, now: number): number {
  const b = buckets.get(key);
  if (!b || now - b.firstAt >= WINDOW_MS) return 0;
  return b.count;
}

function retryAfterSec(keys: string[], now: number): number {
  let latestExpiry = now;
  for (const k of keys) {
    const b = buckets.get(k);
    if (b && now - b.firstAt < WINDOW_MS) {
      latestExpiry = Math.max(latestExpiry, b.firstAt + WINDOW_MS);
    }
  }
  return Math.max(1, Math.ceil((latestExpiry - now) / 1000));
}

const ipKey = (ip: string): string => `ip:${ip}`;
const pairKey = (ip: string, email: string): string =>
  `pair:${ip}:${email.trim().toLowerCase()}`;

/**
 * Called BEFORE the password is checked. When this refuses, no bcrypt work is
 * done at all, which is the other half of the point: an attacker cannot use
 * the login endpoint as a CPU sink either.
 */
export function checkLoginAllowed(
  ip: string | null,
  email: string,
  now: number = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  // No usable client address means no per-IP budget to spend. Fail OPEN: a
  // clinician who cannot sign in is a worse outcome than a guess that is not
  // counted, and every other control still applies.
  if (!ip) return { allowed: true };
  sweep(now);
  const keys = [ipKey(ip), pairKey(ip, email)];
  if (
    peek(keys[0]!, now) >= MAX_FAILURES_PER_IP ||
    peek(keys[1]!, now) >= MAX_FAILURES_PER_IP_EMAIL
  ) {
    return { allowed: false, retryAfterSec: retryAfterSec(keys, now) };
  }
  return { allowed: true };
}

/** Called after a rejected password, an unknown address, or a bad MFA code. */
export function recordLoginFailure(
  ip: string | null,
  email: string,
  now: number = Date.now(),
): void {
  if (!ip) return;
  bump(ipKey(ip), now);
  bump(pairKey(ip, email), now);
}

/**
 * Called after a session is issued. Clears this address's own budget so a
 * clinician who fat-fingers a password four times and then gets it right
 * starts clean, rather than carrying four strikes for the next quarter hour.
 * The IP total is cleared too: a correct password is proof this is not a
 * guessing run.
 */
export function recordLoginSuccess(ip: string | null, email: string): void {
  if (!ip) return;
  buckets.delete(ipKey(ip));
  buckets.delete(pairKey(ip, email));
}

// ---------------------------------------------------------------------------
// signup
// ---------------------------------------------------------------------------

/**
 * Signup attempts allowed from one IP per window, successful or not.
 *
 * SIGNUP TELLS YOU WHETHER AN ADDRESS IS REGISTERED — "An account with that
 * email already exists." That is enumeration, and the usual cure is to answer
 * vaguely and send an email instead. Not done here on purpose: a person who
 * mistypes their own address would be left staring at a form that claims
 * success and does nothing, and the email path is not something this codebase
 * can currently prove works.
 *
 * The property that actually makes enumeration useful is SCALE — an address
 * at a time is a curiosity, ten thousand is a mailing list. So the answer
 * stays honest and the volume gets capped. A real person signs up once; this
 * allows ten tries in a quarter hour and then stops answering. It also blunts
 * signup spam, which a public form invites regardless.
 *
 * Login is unaffected and still refuses to say which half was wrong — that is
 * where credential stuffing happens, and it remains silent.
 */
const MAX_SIGNUPS_PER_IP = 10;

const signupKey = (ip: string): string => `signup:${ip}`;

export function checkSignupAllowed(
  ip: string | null,
  now: number = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  // Same reasoning as login: no address, no budget to spend. Fail open rather
  // than turn away a real customer we cannot identify.
  if (!ip) return { allowed: true };
  sweep(now);
  const key = signupKey(ip);
  if (peek(key, now) >= MAX_SIGNUPS_PER_IP) {
    return { allowed: false, retryAfterSec: retryAfterSec([key], now) };
  }
  return { allowed: true };
}

/** Counts EVERY attempt, not just failures — enumeration probes look valid. */
export function recordSignupAttempt(ip: string | null, now: number = Date.now()): void {
  if (!ip) return;
  bump(signupKey(ip), now);
}

/** Test seam. */
export function __resetThrottle(): void {
  buckets.clear();
}
