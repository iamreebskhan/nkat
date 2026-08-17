/**
 * What counts as an acceptable password.
 *
 * Three places set passwords — signup, change-password and reset-confirm —
 * and each carried its own hardcoded `length < 12` and nothing else. So
 * "aaaaaaaaaaaa", "passwordpassword" and a password identical to the user's
 * own email address were all accepted for clinician accounts on a system
 * holding PHI. This is the one policy all three now share.
 *
 * LENGTH IS STILL THE PRIMARY CONTROL, and there are deliberately NO
 * composition rules — no "must contain a digit and a symbol". NIST SP 800-63B
 * recommends exactly that: composition rules push people toward Passw0rd! and
 * a sticky note, while length buys real entropy. What 800-63B also asks for,
 * and what was missing, is screening the chosen secret against values known
 * to be common. That is what the rest of this does.
 *
 * The screening is deliberately narrow. It rejects passwords that are obviously
 * guessable, not passwords that merely look unusual — a nurse locked out of a
 * password manager at a bedside is a real cost, and an over-eager rule that
 * refuses a perfectly good passphrase is how that happens.
 *
 * Offline by design: no call to a breach API on the signup path. A network
 * dependency in the middle of account creation fails at the worst moment, and
 * the list below covers the passwords that actually get chosen. Adding a
 * k-anonymity HIBP lookup later is a strict improvement and does not change
 * this shape.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Bases that show up at the top of every breach corpus. Compared after
 * stripping padding, so "password", "password123" and "p@ssword!!" collapse
 * to the same base and are all refused.
 */
const COMMON_BASES = new Set([
  "password", "passwd", "pass", "letmein", "welcome", "admin", "administrator",
  "qwerty", "qwertyuiop", "asdfgh", "zxcvbn", "iloveyou", "princess", "dragon",
  "monkey", "sunshine", "football", "baseball", "superman", "batman", "trustno",
  "master", "shadow", "michael", "jennifer", "jordan", "harley", "ranger",
  "hunter", "buster", "soccer", "hockey", "killer", "george", "andrew",
  "charlie", "thomas", "robert", "changeme", "secret", "login", "abc",
  "test", "temp", "default", "starwars", "whatever", "freedom", "computer",
  // Ones that only appear once a 12-character floor is in place.
  "passwordpassword", "password1234", "qwerty123456", "iloveyou1234",
  "welcome123456", "letmein123456", "trustno1", "pallio", "medical", "nurse",
  "hospital", "patient", "clinic", "health", "healthcare",
]);

const LEET = new Map<string, string>([
  ["0", "o"], ["1", "i"], ["3", "e"], ["4", "a"], ["5", "s"], ["7", "t"],
  ["@", "a"], ["$", "s"], ["!", "i"], ["|", "l"],
]);

/**
 * The forms a password might be a padded common word in.
 *
 * ORDER MATTERS HERE, and getting it wrong is why the first version of this
 * let "password1234" through: folding leet BEFORE dropping padding turns the
 * 1, 3 and 4 into letters, so the base came out "passwordiea" and matched
 * nothing. Padding comes off first; folding is a separate candidate.
 */
function baseCandidates(raw: string): string[] {
  const lower = raw.toLowerCase();
  const alnum = lower.replace(/[^a-z0-9]/g, "");
  const fold = (s: string): string =>
    [...s].map((ch) => LEET.get(ch) ?? ch).join("").replace(/[^a-z]/g, "");

  // Padding trimmed off the END first — trailing symbols, then trailing
  // digits — and only then folded. Doing it the other way round loses the
  // symbol: "@" is stripped as non-alphanumeric before it can fold to "a",
  // so "p@ssw0rd1234" came out as "psswordiea" and matched nothing.
  const detrailed = lower.replace(/[^a-z0-9]+$/, "").replace(/\d+$/, "");

  const out = new Set<string>([
    lower.replace(/[^a-z]/g, ""),        // letters only:      "P@ssw0rd!!!!" -> "psswrd"
    alnum.replace(/\d+$/, ""),           // trailing digits:   "password1234" -> "password"
    alnum.replace(/^\d+/, ""),           // leading digits:    "1234password" -> "password"
    fold(alnum),                         // leet folded:       "passw0rd"     -> "password"
    fold(alnum.replace(/\d+$/, "")),     // both:              "passw0rd12"   -> "password"
    fold(detrailed),                     // padding + leet:    "p@ssw0rd!!!!" -> "password"
  ]);
  return [...out].filter((s) => s.length >= 3);
}

/** A password made only of digits is a date, a phone number or a PIN. */
function isAllDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

/** "aaaaaaaaaaaa", "abababababab" — one short unit repeated to length. */
function isRepeatedUnit(s: string): boolean {
  for (let unit = 1; unit <= 4; unit++) {
    if (s.length % unit !== 0) continue;
    const head = s.slice(0, unit);
    if (head.repeat(s.length / unit) === s) return true;
  }
  return false;
}

/** "123456789012", "abcdefghijkl", and their reverses. */
function isSequential(s: string): boolean {
  if (s.length < 4) return false;
  const step = (a: string, b: string): number => b.charCodeAt(0) - a.charCodeAt(0);
  const first = step(s[0]!, s[1]!);
  if (first !== 1 && first !== -1) return false;
  for (let i = 1; i < s.length - 1; i++) {
    if (step(s[i]!, s[i + 1]!) !== first) return false;
  }
  return true;
}

export interface PasswordContext {
  /** The address the password protects — a password must not just be it. */
  email?: string | null;
  /** Org name, for the same reason. */
  orgName?: string | null;
  /** Person's own name. */
  fullName?: string | null;
}

export type PasswordVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export function checkPassword(
  password: string,
  ctx: PasswordContext = {},
): PasswordVerdict {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  }

  const lower = password.toLowerCase();
  const bases = baseCandidates(password);

  if (isRepeatedUnit(lower)) {
    return { ok: false, reason: "Password is a repeated character or pattern — pick something less predictable." };
  }
  if (isSequential(lower)) {
    return { ok: false, reason: "Password is a simple sequence — pick something less predictable." };
  }
  if (isAllDigits(password)) {
    return { ok: false, reason: "Password is all digits — add words or letters." };
  }
  // EQUALITY against a candidate, never containment: "medicalrecords-2026" is
  // a fine password that merely starts with a listed word, and refusing it
  // would be the over-eager rule this policy is trying not to be.
  for (const base of bases) {
    if (COMMON_BASES.has(base)) {
      return { ok: false, reason: "Password is too common — pick something less predictable." };
    }
  }

  // The password must not simply BE the identifiers it protects.
  const localPart = (ctx.email ?? "").split("@")[0] ?? "";
  const identifiers = [localPart, ctx.email ?? "", ctx.orgName ?? "", ctx.fullName ?? ""]
    .flatMap((v) => baseCandidates(v))
    .filter((v) => v.length >= 4);
  for (const base of bases) {
    if (identifiers.includes(base)) {
      return { ok: false, reason: "Password must not be your name, email or organisation name." };
    }
  }

  return { ok: true };
}
