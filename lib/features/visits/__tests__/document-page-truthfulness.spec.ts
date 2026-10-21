/**
 * What /visits/[id]/document tells a clinician, held to what it does.
 *
 * Three things on that screen disagreed with the code under them:
 *
 *   1. An empty catch said "the panel says codes are unavailable rather than
 *      falling back to numbers baked into the client". There was no such
 *      message. `bands` stayed null, `suggestion` stayed null, and the render
 *      guard dropped the whole Suggested codes card — indistinguishable from a
 *      visit nobody has coded. The clinician's next signal was Sign refusing
 *      with "Need at least one CPT code before submitting", with nothing on
 *      screen joining the two. The message that closed it is addressed to
 *      someone who has not signed yet ("reload"; "tell your administrator
 *      before signing"), so the card is gated on the visit being open. Since
 *      then the whole live card is: a signed visit shows its signed codes
 *      instead (document-signed-visit.spec.ts), because the live suggestion
 *      re-ran on a signed visit and disagreed with what was signed.
 *
 *   2. `allCodes` fell back to the saved visit's codes when there was no
 *      suggestion; `allMods` had no fallback and sent `[]`. documentVisit binds
 *      `modifiers = COALESCE($1::text[], modifiers)`, and an empty array is NOT
 *      NULL — verified in Postgres: COALESCE(ARRAY[]::text[], ARRAY['95'])
 *      returns {}. So one "Save draft" while the ladders were unavailable wiped
 *      the 95 off a telehealth visit and kept its CPT codes, which is the worst
 *      possible shape for the loss: the bill still looks complete.
 *
 *   3. The Diagnosis card justified a required diagnosis by the bill. On a
 *      "Not billed" visit type no bill is ever built, and the same screen says
 *      so two cards away. The requirement is R13's (every signed encounter must
 *      say what it addressed) and is correct for every visit type; only the
 *      reason given was wrong.
 *
 * The page is a client component holding TipTap, a `use(params)` promise and
 * four fetches, and app/ is outside vitest's include globs, so this reads the
 * source. Ugly; less ugly than a claim nothing checks.
 *
 * Reading source is a weak oracle on its own — a test that looks for an
 * identifier passes against an expression that names it and does the wrong
 * thing anyway, which is how `(visit?.modifiers ? [] : [])` sailed through the
 * first version of this file. So the two expressions that carry the behaviour,
 * the render guard and `allMods`, are extracted and EVALUATED here rather than
 * pattern-matched. The assertions on lib/features/visits/visit.service.ts are
 * deliberately loose for the opposite reason: that file is not this screen's,
 * and a reflow or a reworded comment there is not a defect here.
 *
 * Since closed: the sign-off error for a missing diagnosis used to give the
 * justification this card dropped — "The bill is built from the diagnoses
 * recorded on this visit" — which is untrue on a "Not billed" visit type.
 * visit.service.ts now branches on coding_basis and tells a Not-billed visit
 * "A signed encounter has to say what it was for", the card's own reason. The
 * pair is pinned below so neither side can be reworded alone: the card's text,
 * and the phrase in the sign guard's code with its comments stripped. That the
 * Not-billed visit is the one that gets it is behaviour, run in
 * sign-requires-note.spec.ts. The amber line under the picker itself said the
 * same thing and is fixed in components/visits/diagnosis-picker.tsx, with its
 * own test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(process.cwd(), "app/(platform)/visits/[id]/document/page.tsx"),
  "utf8",
);
const SERVICE = readFileSync(join(process.cwd(), "lib/features/visits/visit.service.ts"), "utf8");

/**
 * The whole parenthesised expression opening at `open`, counted rather than
 * matched. `[^)]*` stops at the first inner ")", so it truncates any guard
 * that grows a nested term — and a truncated guard is one this file would
 * then evaluate as something the page does not contain. Used on the service
 * too, where `[^)]*` went red on a harmless nested paren.
 */
function balanced(src: string, open: number, where = "the document page"): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced expression in ${where}`);
}

/**
 * Whole-line `//` comments removed. A phrase pinned in visit.service.ts has to
 * be in the code, because that file's comments repeat the phrases it is
 * pinned on: "say what it was for" sits in the sign guard's comment, so
 * matching the raw file stayed green with the refusal itself reverted.
 */
const withoutLineComments = (src: string): string => src.replace(/^[ \t]*\/\/.*$/gm, "");

describe("the Suggested codes panel when the code ladders fail to load", () => {
  const open = SRC.indexOf("{(!locked && (suggestion");
  const guardSrc = open > 0 ? balanced(SRC, open + 1) : "";
  /** The shipped render guard, run for real. */
  const shows =
    guardSrc === ""
      ? null
      : (new Function(
          "suggestion",
          "nonBillable",
          "bandsUnavailable",
          "locked",
          `return Boolean(${guardSrc});`,
        ) as (
          suggestion: unknown,
          nonBillable: boolean,
          bandsUnavailable: boolean,
          locked: boolean,
        ) => boolean);

  it("keeps the card on screen instead of dropping it", () => {
    expect(shows, "could not find the Suggested codes render guard").toBeTruthy();
    // The defect: the fetch fails, `bands` stays null, so `suggestion` stays
    // null and the card vanished — a failed request wearing the face of a
    // visit nobody has coded.
    expect(shows!(null, false, true, false)).toBe(true);
    // Unchanged for the two cases that always showed it.
    expect(shows!({ base: [] }, false, false, false)).toBe(true);
    expect(shows!(null, true, false, false)).toBe(true);
  });

  it("stays off a signed visit, which cannot act on what it says", () => {
    // The card's failure message tells the reader to reload the page and to
    // tell an administrator "before signing". A signed visit is signed: the
    // banner above says it is locked, both buttons below are disabled, and it
    // carries the codes it was attested with. Saying it "cannot be signed for
    // billing yet" there is a new false sentence on the screen this card was
    // fixed to stop lying on, so on a locked visit it drops — which is what
    // it did before the failure was given a message at all.
    expect(shows, "could not find the Suggested codes render guard").toBeTruthy();
    expect(shows!(null, false, true, true)).toBe(false);
  });

  it("stays off a signed visit with a suggestion too, which showed codes it was not signed with", () => {
    // On localhost a visit signed with one G0318 unit showed G0318 ×3 here.
    expect(shows, "could not find the Suggested codes render guard").toBeTruthy();
    expect(shows!({ base: [] }, false, false, true)).toBe(false);
    expect(shows!(null, true, false, true)).toBe(false);
  });

  it("says codes are unavailable, which is what the catch promises", () => {
    expect(SRC).toMatch(/Codes are unavailable/);
    // Not a silent amber note: it is the only warning before Sign refuses.
    expect(SRC).toMatch(/Codes are unavailable[\s\S]{0,400}?cannot be signed/);
  });

  it("raises the flag on a refused response as well as a thrown one", () => {
    const fetchBlock = SRC.slice(
      SRC.indexOf('fetch("/api/billing/code-bands")'),
      SRC.indexOf("/api/auth/me"),
    );
    expect(fetchBlock, "could not find the code-bands fetch").not.toBe("");
    // `{ success: false }` never throws, so a catch alone would leave a
    // refused request looking like a visit with no codes.
    expect(fetchBlock.match(/setBandsUnavailable\(true\)/g)?.length).toBe(2);
  });
});

describe("Save draft with no suggestion", () => {
  // No `\n` anchor: the page is CRLF and `;\n` matched nothing at all, which
  // would have skipped every assertion below on a pass that looked green.
  const found = SRC.match(/const allMods =([\s\S]*?);/);
  /** The shipped fallback expression, run for real. */
  const allMods = found
    ? (new Function("suggestion", "visit", `return (${found[1]});`) as (
        suggestion: unknown,
        visit: unknown,
      ) => string[])
    : null;

  it("falls back to the saved modifiers, as the codes beside it already did", () => {
    expect(allMods, "could not find allMods").toBeTruthy();
    // The exact shape that caused the wipe: no suggestion → [] → COALESCE
    // overwrites, because an empty array is a value and not a NULL. Asserted
    // by running the expression, because merely requiring it to NAME
    // `visit?.modifiers` is satisfied by `(visit?.modifiers ? [] : [])`,
    // which sends the empty array and loses the 95 exactly as before.
    expect(allMods!(null, { modifiers: ["95"] })).toEqual(["95"]);
    // A visit that never carried one sends an empty array, not undefined —
    // the PATCH body is typed and `undefined` would drop the field.
    expect(allMods!(null, { modifiers: null })).toEqual([]);
    // A live suggestion still wins in both directions, so a modifier the
    // suggester has dropped is still cleared on save.
    expect(allMods!({ modifiers: [{ modifier: "95" }] }, { modifiers: ["93"] })).toEqual(["95"]);
    expect(allMods!({ modifiers: [] }, { modifiers: ["95"] })).toEqual([]);
    // And the literal that was there when the 95 went missing.
    expect(found![0]).not.toMatch(/\(suggestion\?\.modifiers \?\? \[\]\)/);
  });

  it("still sends the field, so documentVisit's COALESCE is what it was", () => {
    // If the page stopped sending modifiers entirely the fallback would be
    // moot, but so would every deliberate clearing of a modifier. Both sides
    // of the contract are asserted so neither can drift alone — loosely on
    // the service side, which another package owns: a Prettier reflow of that
    // UPDATE is not a defect on this screen.
    expect(SRC).toMatch(/modifiers: allMods/);
    // Read to the matching ")" with balanced(), not `[^)]*`: that stopped at
    // the first inner ")" and failed on `COALESCE((${…})::text[], modifiers)`,
    // which changes nothing. A red with no defect teaches people to skip this
    // file. What has to hold is only that the column falls back to itself.
    const at = SERVICE.search(/\bmodifiers\s*=\s*COALESCE\s*\(/);
    expect(at, "documentVisit no longer COALESCEs modifiers").toBeGreaterThan(-1);
    const coalesce = balanced(SERVICE, SERVICE.indexOf("(", at), "visit.service.ts");
    expect(coalesce).toMatch(/,\s*(?:\w+\.)?modifiers\s*\)$/);
  });
});

/**
 * The add-on's count reaches the visit (0106). The suggester counted G0318,
 * 99417 and 99498 units but the page saved `.code` alone, so every add-on was
 * billed as one unit. Now the codes and their units travel as one assignment,
 * and the fallback is the same one the modifiers needed: with no suggestion
 * the page sends what the visit already holds, because `cpt_units` is written
 * with a COALESCE and '{}'::jsonb is a value, not a NULL.
 */
describe("Save draft carries the units beside the codes", () => {
  // Up to the first ";" — the expression holds none, and there is no `\n`
  // anchor because this page is CRLF.
  const found = SRC.match(/const assignment =([\s\S]*?);/);
  /** The shipped expression, run for real. */
  const assignment = found
    ? (new Function("suggestion", "visit", "assignmentFromSuggestion", `return (${found[1]});`) as (
        suggestion: unknown,
        visit: unknown,
        assignmentFromSuggestion: (s: unknown) => unknown,
      ) => { codes: string[]; units: Record<string, number> })
    : null;
  const never = () => {
    throw new Error("no suggestion, so the suggester must not be asked");
  };

  it("CONTROL: with no suggestion, sends the visit's own codes AND units", () => {
    expect(assignment, "could not find `const assignment =` on the document page").toBeTruthy();
    expect(
      assignment!(null, { cptCodesAssigned: ["99350", "G0318"], cptUnits: { G0318: 3 } }, never),
    ).toEqual({ codes: ["99350", "G0318"], units: { G0318: 3 } });
    // A visit read with no units sends {} — one unit per code — not undefined,
    // which the PATCH would drop along with the codes' count.
    expect(assignment!(null, { cptCodesAssigned: ["99350"], cptUnits: null }, never)).toEqual({
      codes: ["99350"],
      units: {},
    });
  });

  it("a live suggestion wins, through the suggester's own assignment", () => {
    expect(assignment, "could not find `const assignment =` on the document page").toBeTruthy();
    const fromSuggestion = { codes: ["99350", "G0318"], units: { G0318: 4 } };
    expect(
      assignment!({ base: [] }, { cptCodesAssigned: ["99349"], cptUnits: {} }, () => fromSuggestion),
    ).toBe(fromSuggestion);
  });

  it("sends both halves of the assignment", () => {
    expect(SRC).toMatch(/cptCodesAssigned: assignment\.codes/);
    expect(SRC).toMatch(/cptUnits: assignment\.units/);
    // Loosely on the service side, as for the modifiers: the column falls
    // back to itself, so a save without codes leaves the count alone.
    const at = SERVICE.search(/\bcpt_units\s*=\s*COALESCE\s*\(/);
    expect(at, "documentVisit no longer COALESCEs cpt_units").toBeGreaterThan(-1);
    const coalesce = balanced(SERVICE, SERVICE.indexOf("(", at), "visit.service.ts");
    expect(coalesce).toMatch(/,\s*(?:\w+\.)?cpt_units\s*\)$/);
  });
});

describe("the Diagnosis card", () => {
  it("no longer justifies the requirement by a bill that may never exist", () => {
    expect(SRC).not.toMatch(/The bill is built from it, so/);
  });

  it("gives the clinical reason the sign guard actually gives", () => {
    const card = SRC.slice(SRC.indexOf("<CardTitle>Diagnosis</CardTitle>"));
    const description = card.slice(0, card.indexOf("</CardDescription>"));
    // The JSX wraps, so every phrase is matched across whitespace.
    expect(description).toMatch(/required\s+to\s+sign/);
    expect(description).toMatch(/say\s+what\s+it\s+was\s+for/);
    // The guard it is describing: visit.service.ts refuses any sign-off with
    // no diagnosis, on a "Not billed" visit type as much as a billed one. The
    // window is wide enough to hold the guard's own comment, so explaining WHY
    // in that file is not a failure here.
    expect(SERVICE).toMatch(
      /dx_count[\s\S]{0,40}?===\s*0\)\s*\{[\s\S]{0,800}?throw new ValidationError/,
    );
    // The message has since been corrected, so the pair can be pinned: on a
    // Not-billed visit the refusal gives this card's clinical reason rather
    // than naming a bill that visit type never drafts. If either side is
    // reworded alone, the screen and the refusal disagree again.
    //
    // Pinned in the guard's code, from its `if` to the refusal's closing ")",
    // with comments stripped. Matching the whole file could not fail: the
    // guard's comment says "must say what it was for", so reverting the
    // Not-billed refusal to blame the bill left this green. Which visit type
    // gets which sentence is behaviour, and is run in sign-requires-note.spec.ts.
    const guardAt = SERVICE.search(/dx_count[\s\S]{0,40}?===\s*0\)\s*\{/);
    expect(guardAt, "could not find the diagnosis sign guard").toBeGreaterThan(-1);
    const throwAt = SERVICE.indexOf("throw new ValidationError(", guardAt);
    expect(throwAt, "the diagnosis sign guard no longer refuses").toBeGreaterThan(guardAt);
    const open = SERVICE.indexOf("(", throwAt);
    const guard = withoutLineComments(
      SERVICE.slice(guardAt, open) + balanced(SERVICE, open, "visit.service.ts"),
    );
    expect(guard).toMatch(/non_billable/);
    expect(guard).toMatch(/say what it was for/);
  });
});
