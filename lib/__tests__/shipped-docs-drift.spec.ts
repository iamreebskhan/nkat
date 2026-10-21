/**
 * The documents a person acts on, held to the code and the schema they
 * describe.
 *
 * These are not internal notes. `docs/RUNBOOKS/demo-tenant.md` is followed
 * command by command on a production VPS; `docs/open-questions-for-mark.md`
 * may be SENT to Mark Hendrix, and every question in it asks him to spend his
 * attention on something. Each had gone stale in the same way — the code moved
 * and the sentence did not — and nothing checked:
 *
 *   * The runbook's migration floor said 0099 and its pre-flight query counted
 *     two columns. The seed needs 0103's three tables. An operator on 0100,
 *     0101 or 0102 passed both gates and then hit `relation "patient_contact"
 *     does not exist`, an error the runbook does not list.
 *   * The open questions said only HPI and Assessment & Plan block signing.
 *     Five sections do.
 *   * §1 asked Mark to decide whether to model external clinicians, calling
 *     them "clinicians we do not model at all". Migration 0103 had already
 *     modelled them, and his answer could only have been wasted.
 *   * db/seed/MANIFEST accounted for 45 of the 46 seeds beside it. A seed that
 *     is neither listed nor explained is indistinguishable from one somebody
 *     forgot.
 *
 * Both document assertions below are scoped deliberately narrowly, because the
 * first version of this file was not and passed against the very sentences it
 * exists to keep out. The runbook's prose names the three tables in a sentence
 * of its own, so asserting on the whole pre-flight step stayed green with the
 * old two-column query back in the command box — and the operator runs the
 * command, not the paragraph. The open questions quote Mark's [05:55] call
 * transcript four lines above the paragraph that was fixed, and that quote
 * says "HPI", "social history" and "physical exam" all by itself, so four of
 * five section assertions were satisfied by text that predated the fix. Match
 * the line or the paragraph that carries the claim, never the file around it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_NOTE_SECTIONS } from "@/lib/features/visits/note-template";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const RUNBOOK = read("docs/RUNBOOKS/demo-tenant.md");
const QUESTIONS = read("docs/open-questions-for-mark.md");
const MANIFEST = read("db/seed/MANIFEST");
const DEMO_SEED = read("db/seed/tenant-demo-palliative.sql");
const SEED_DIR = join(process.cwd(), "db/seed");
const MIGRATIONS = readdirSync(join(process.cwd(), "db/migrations"));

/** The three tables migration 0103 creates, which the demo seed fills. */
const TABLES_0103 = ["patient_contact", "external_provider", "patient_external_provider"];

describe("docs/RUNBOOKS/demo-tenant.md", () => {
  it("states a migration floor at least as high as the seed's own header", () => {
    const stated = RUNBOOK.match(/Migrations through (\d{4}) are applied/);
    expect(stated, "the runbook no longer states a migration floor").toBeTruthy();
    const required = DEMO_SEED.match(/REQUIRES migrations through (\d{4})/);
    expect(required, "the seed no longer states what it requires").toBeTruthy();
    expect(Number(stated![1])).toBeGreaterThanOrEqual(Number(required![1]));
  });

  it("pre-flights the 0103 tables in the query, not only in the prose beside it", () => {
    const step = RUNBOOK.slice(
      RUNBOOK.indexOf("Migrations through"),
      RUNBOOK.indexOf("## Create it"),
    );
    expect(step, "could not find the migration pre-flight step").not.toBe("");
    // The command is the gate; the paragraph is not. The step's own prose
    // names all three tables in a sentence, so asserting on the step as a
    // whole passes with the old two-column query back in the command box —
    // and that query is exactly what let an operator on 0100-0102 through.
    const query = step
      .split("\n")
      .find((line) => /^\s*sudo -u postgres psql .*information_schema/.test(line));
    expect(query, "the pre-flight step no longer runs a schema query").toBeTruthy();
    expect(query).toContain("signer_credential");
    expect(query).toContain("is_telehealth");
    for (const table of TABLES_0103) {
      expect(query, `the pre-flight query does not detect ${table}`).toContain(table);
    }
    // And the number the operator compares the output against has to be the
    // number of things the query counts. Drop a subquery and leave the "5"
    // standing and the gate is worse than none: a short migration prints a
    // total the runbook still calls correct.
    const stated = step.match(/should\s+print (\d+)/);
    expect(stated, "the step no longer says what the query should print").toBeTruthy();
    const columnPairs = query!.match(/\('[a-z_]+', '[a-z_]+'\)/g) ?? [];
    expect(
      Number(stated![1]),
      "the expected count no longer matches what the query counts",
    ).toBe(columnPairs.length + TABLES_0103.length);
  });

  it("names the error an operator short of the floor actually sees", () => {
    expect(RUNBOOK).toMatch(/relation "patient_contact" does not exist/);
  });
});

describe("docs/open-questions-for-mark.md", () => {
  it("names every section that blocks signing, not two of the five", () => {
    const required = DEFAULT_NOTE_SECTIONS.filter((s) => s.isRequired);
    // Guards the spec itself: if the template changes, this list changes with
    // it and the assertions below are re-pointed rather than quietly passing.
    expect(required.map((s) => s.sectionKey)).toEqual([
      "hpi",
      "social_history",
      "vitals",
      "physical_exam",
      "assessment_and_plan",
    ]);
    const prose: Record<string, RegExp> = {
      hpi: /HPI/,
      social_history: /social history/i,
      vitals: /vitals/i,
      physical_exam: /physical exam/i,
      assessment_and_plan: /assessment and plan/i,
    };
    // Only the paragraph that makes the claim may satisfy this. Slicing to
    // everything above "**Codes are selected" passed against the original
    // false sentence, because the [05:55] and [06:29] transcript quotes four
    // lines higher already contain "HPI", "social history", "physical exam"
    // and "vitals" — four of these five matched the document whatever the
    // paragraph beneath them claimed.
    const anchor = QUESTIONS.indexOf("`DEFAULT_NOTE_SECTIONS`");
    expect(
      anchor,
      "the blocking list is no longer sourced to DEFAULT_NOTE_SECTIONS",
    ).toBeGreaterThan(0);
    const paragraph = QUESTIONS.slice(
      QUESTIONS.lastIndexOf("\n\n", anchor) + 2,
      QUESTIONS.indexOf("\n\n", anchor),
    );
    const listed = paragraph.match(/\*\*([\s\S]+?)\*\*/);
    expect(
      listed,
      "that paragraph no longer enumerates the sections it says block signing",
    ).toBeTruthy();
    for (const s of required) {
      expect(listed![1], `${s.sectionKey} is not named as blocking signing`).toMatch(
        prose[s.sectionKey],
      );
    }
    // Exact in both directions. Naming a section that does not block a
    // sign-off sends a clinician hunting for a field the server never asks
    // for, which is the same defect pointing the other way.
    for (const s of DEFAULT_NOTE_SECTIONS.filter((x) => !x.isRequired)) {
      expect(
        listed![1].toLowerCase(),
        `${s.sectionKey} does not block signing but is listed as if it does`,
      ).not.toContain(s.label.toLowerCase());
    }
    // The claim it replaced, which named two and implied the rest were free.
    expect(QUESTIONS).not.toMatch(/only \*\*HPI and Assessment & Plan\*\* hard blocks/);
  });

  it("does not ask Mark to decide something migration 0103 already shipped", () => {
    expect(
      MIGRATIONS.some((f) => f.startsWith("0103_")),
      "0103 is gone; §1 of the doc needs re-reading",
    ).toBe(true);
    // Scoped to §1, and to what §1 asks him. Matching the whole document
    // passes against a re-ask that keeps the table names — they are quoted in
    // §1's prose either way — so the assertion that does the work is on the
    // Ask itself: the only thing separating "we modelled this, here is what
    // shipped" from "should we model this?" is the question at the end.
    const start = QUESTIONS.indexOf("## 1. The referring physician");
    expect(start, "§1 is no longer the referring-physician question").toBeGreaterThan(-1);
    const section = QUESTIONS.slice(start, QUESTIONS.indexOf("## 2."));
    expect(section).not.toMatch(/clinicians we do not model at all/);
    // What shipped has to be visible to him, or he cannot tell an answered
    // question from an unasked one.
    expect(section, "§1 no longer says which migration shipped it").toMatch(/[Mm]igration 0103/);
    for (const table of TABLES_0103) {
      expect(section, `§1 does not mention ${table}`).toContain(table);
    }
    // The open half is billing — box 17 on the claim. An Ask that has drifted
    // back to the care-team header is asking him to re-decide something that
    // is already three tables and a note header.
    const askAt = section.lastIndexOf("**Ask:**");
    expect(askAt, "§1 no longer asks him anything").toBeGreaterThan(-1);
    const ask = section.slice(askAt);
    expect(ask, "§1 asks him something other than the claim field").toMatch(/on the claim/);
    expect(ask, "§1 asks him something other than the claim field").toMatch(/box 17/);
  });
});

describe("db/seed/MANIFEST", () => {
  it("accounts for every seed beside it, applied or explained", () => {
    const seeds = readdirSync(SEED_DIR).filter((f) => f.endsWith(".sql"));
    expect(seeds.length).toBeGreaterThan(40);
    const unaccounted = seeds.filter((f) => !MANIFEST.includes(f));
    // Listed or commented out with a reason — never merely absent, which is
    // how a deliberate omission and a forgotten one come to look alike.
    expect(unaccounted, `not named in MANIFEST: ${unaccounted.join(", ")}`).toEqual([]);
  });

  it("points a hand-run of the demo seed at a deploy that can carry it", () => {
    const named = MANIFEST.match(/after the deploy\s+#?\s*that carries (\d{4})/);
    expect(named, "MANIFEST no longer says which deploy the demo seed follows").toBeTruthy();
    const required = DEMO_SEED.match(/REQUIRES migrations through (\d{4})/);
    expect(Number(named![1])).toBeGreaterThanOrEqual(Number(required![1]));
  });
});
