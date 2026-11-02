/**
 * Finding a drug in RxNorm through NLM's RxNav (0128): the coded medication and
 * drug-allergy lists ONC's certification asks for.
 *
 * Only the words typed into a medication or allergy field go to NLM, from the
 * server, and the RXCUIs NLM answered with; never a patient's name or anything
 * else about them. RxNav is free and needs no key. If it is slow or down the
 * search says so and the chart keeps working: a medication can always be saved
 * as free text, and coded later.
 */

const RXNAV = "https://rxnav.nlm.nih.gov/REST";
const TIMEOUT_MS = 5_000;
const MAX_ROWS = 15;
/** RxNav asks for at most 20 requests a second from one address: a search names at most this many. */
const MAX_NAME_LOOKUPS = 5;

export interface RxnormConcept {
  rxcui: string;
  name: string;
}

export type RxnormUse = "medication" | "allergy";

interface ApproximateAnswer {
  approximateGroup?: { candidate?: { rxcui?: string; name?: string; source?: string }[] };
}

interface DrugsAnswer {
  drugGroup?: { conceptGroup?: { tty?: string; conceptProperties?: { rxcui?: string; name?: string }[] }[] };
}

interface PropertiesAnswer {
  properties?: { rxcui?: string; name?: string };
}

async function ask<T>(path: string): Promise<T> {
  const res = await fetch(`${RXNAV}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`RxNav answered ${res.status}.`);
  return (await res.json()) as T;
}

/**
 * The concepts RxNav matched, best first, once each. Asked with option=1, every
 * candidate is an active RxNorm concept, whichever source's string matched: a
 * search with a strength in it, "lisinopril 10 mg tablet", matches VA's
 * "LISINOPRIL 10MG TAB", and its RXCUI is RxNorm's 314076. Only a candidate from
 * RxNorm itself carries RxNorm's name; the rest are named by searchRxnorm.
 * Keeping RxNorm's strings only used to answer that search "No match".
 */
export function candidatesFrom(a: ApproximateAnswer): { rxcui: string; name: string | null }[] {
  const byRxcui = new Map<string, { rxcui: string; name: string | null }>();
  for (const c of a.approximateGroup?.candidate ?? []) {
    if (!c.rxcui) continue;
    const own = c.source === "RXNORM" && c.name ? c.name : null;
    const had = byRxcui.get(c.rxcui);
    if (!had) byRxcui.set(c.rxcui, { rxcui: c.rxcui, name: own });
    else if (!had.name) had.name = own;
  }
  return [...byRxcui.values()];
}

/** RxNorm's name for a concept, or null when RxNav has none or does not answer. */
async function rxnormName(rxcui: string): Promise<string | null> {
  try {
    const p = await ask<PropertiesAnswer>(`/rxcui/${encodeURIComponent(rxcui)}/properties.json`);
    return p.properties?.name || null;
  } catch {
    return null;
  }
}

/** The clinical drugs of a name: the strength and form a medication list wants. */
export function clinicalDrugsFrom(a: DrugsAnswer): RxnormConcept[] {
  return (a.drugGroup?.conceptGroup ?? [])
    .filter((g) => g.tty === "SCD")
    .flatMap((g) => g.conceptProperties ?? [])
    .flatMap((c) => (c.rxcui && c.name ? [{ rxcui: c.rxcui, name: c.name }] : []));
}

export async function searchRxnorm(q: string, use: RxnormUse): Promise<{ rows: RxnormConcept[]; unavailable: boolean }> {
  const term = encodeURIComponent(q.trim());
  // Asked apart: the list of strengths is slow for some drugs, and losing it
  // should not lose the match.
  const [near, drugs] = await Promise.allSettled([
    ask<ApproximateAnswer>(`/approximateTerm.json?term=${term}&maxEntries=25&option=1`),
    // An allergy is to a substance, not to a strength of a tablet.
    use === "medication" ? ask<DrugsAnswer>(`/drugs.json?name=${term}`) : Promise.resolve<DrugsAnswer>({}),
  ]);
  if (near.status === "rejected") return { rows: [], unavailable: true };
  // A match through another source's string is shown by RxNorm's name for it,
  // and left out when there is none.
  let lookups = 0;
  const named = await Promise.all(
    candidatesFrom(near.value)
      .slice(0, MAX_ROWS)
      .map(async (c) => {
        if (c.name) return { rxcui: c.rxcui, name: c.name };
        if (++lookups > MAX_NAME_LOOKUPS) return null;
        const name = await rxnormName(c.rxcui);
        return name ? { rxcui: c.rxcui, name } : null;
      }),
  );
  const first = named.filter((c): c is RxnormConcept => c !== null);
  const known = new Set(first.map((c) => c.rxcui));
  const strengths = drugs.status === "fulfilled" ? clinicalDrugsFrom(drugs.value) : [];
  return { rows: [...first, ...strengths.filter((c) => !known.has(c.rxcui))].slice(0, MAX_ROWS), unavailable: false };
}
