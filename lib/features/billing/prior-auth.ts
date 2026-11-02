/**
 * Whether a prior authorization on the chart covers a claim (0124): the same
 * payer, the date of service inside its dates, and a code it names (an
 * authorization naming no codes covers every service under the plan). Pure.
 *
 * A claim carries one authorization number (box 23, REF*G1), so when two cover
 * it, the one covering more of its codes goes, then the one that began later.
 */
export interface PriorAuth {
  id: string;
  payerId: string;
  authNumber: string;
  codes: string[];
  /** YYYY-MM-DD */
  validFrom: string;
  validTo: string;
  visitsAuthorized: number | null;
  status: "active" | "withdrawn";
}

export type AuthRange = Pick<PriorAuth, "payerId" | "codes" | "validFrom" | "validTo" | "status">;

/** The auth is in force for this payer on this day; codes are a separate question. */
const inForce = (a: AuthRange, payerId: string | null, dos: string) =>
  a.status === "active" && a.payerId === payerId && a.validFrom <= dos && dos <= a.validTo;

const coversCode = (a: Pick<PriorAuth, "codes">, code: string) => a.codes.length === 0 || a.codes.includes(code);

/** The authorization that goes on a claim, or null. */
export function coveringAuth<T extends AuthRange>(auths: T[], c: { payerId: string | null; codes: string[]; dos: string }): T | null {
  const scored = auths
    .filter((a) => inForce(a, c.payerId, c.dos))
    .map((a) => ({ a, covered: c.codes.filter((code) => coversCode(a, code)).length }))
    .filter((x) => x.covered > 0)
    .sort((x, y) => y.covered - x.covered || (x.a.validFrom < y.a.validFrom ? 1 : x.a.validFrom > y.a.validFrom ? -1 : 0));
  return scored[0]?.a ?? null;
}

/** The codes on a claim no authorization covers. */
export function uncoveredCodes(auths: AuthRange[], c: { payerId: string | null; codes: string[]; dos: string }): string[] {
  const live = auths.filter((a) => inForce(a, c.payerId, c.dos));
  return c.codes.filter((code) => !live.some((a) => coversCode(a, code)));
}

/**
 * Said when booking a visit: the patient has authorizations on file and none
 * runs on that day. Null with none on file, which is not a gap (most visits
 * need none) and when one covers the day. Visits are booked before they have
 * codes, so this looks at the dates alone.
 */
export function authGapOn(auths: Pick<PriorAuth, "authNumber" | "validFrom" | "validTo" | "status">[], day: string): string | null {
  const live = auths.filter((a) => a.status === "active");
  if (live.length === 0 || live.some((a) => a.validFrom <= day && day <= a.validTo)) return null;
  const last = [...live].sort((x, y) => (x.validTo < y.validTo ? 1 : -1))[0]!;
  return last.validTo < day
    ? `The prior authorization on file (${last.authNumber}) ended on ${last.validTo}, before this visit.`
    : `The prior authorization on file (${last.authNumber}) starts on ${[...live].sort((x, y) => (x.validFrom > y.validFrom ? 1 : -1))[0]!.validFrom}, after this visit.`;
}
