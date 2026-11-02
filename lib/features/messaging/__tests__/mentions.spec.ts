/**
 * @mentions by full name (Level-1 doc:57). The old parser took one run of
 * non-space characters after "@", so "@Helen Okafor" mentioned nobody.
 */
import { describe, expect, it } from "vitest";

import { findMentions, mentionQueryAt, suggestMentions, type Mentionable } from "../mentions";

const HELEN = "11111111-1111-4111-8111-000000000001";
const ANN = "11111111-1111-4111-8111-000000000002";
const ANN_LEE = "11111111-1111-4111-8111-000000000003";
const PRIYA = "11111111-1111-4111-8111-000000000004";

const ROSTER: Mentionable[] = [
  { userId: HELEN, fullName: "Helen Okafor", email: "helen.okafor@demo.pallio.io" },
  { userId: ANN, fullName: "Ann Byers", email: "ann.byers@demo.pallio.io" },
  { userId: ANN_LEE, fullName: "Ann Lee", email: "ann.lee@demo.pallio.io" },
  { userId: PRIYA, fullName: "Priya Raman", email: "priya@demo.pallio.io" },
];

describe("findMentions", () => {
  it("finds a member by full name, whatever the case or spacing", () => {
    expect(findMentions("@Helen Okafor can you call the daughter?", ROSTER)).toEqual([HELEN]);
    expect(findMentions("thanks @helen   okafor.", ROSTER)).toEqual([HELEN]);
    expect(findMentions("for @Helen\nOkafor", ROSTER)).toEqual([HELEN]);
  });

  it("still finds one by email, and by a first name only one member has", () => {
    expect(findMentions("cc @priya@demo.pallio.io", ROSTER)).toEqual([PRIYA]);
    expect(findMentions("@Priya please review", ROSTER)).toEqual([PRIYA]);
  });

  it("takes the longest name, and two different members in one message", () => {
    expect(findMentions("@Ann Lee and @Ann Byers", ROSTER).sort()).toEqual([ANN, ANN_LEE].sort());
  });

  it("CONTROL: a shared first name alone, a longer word, an address in the text and a stranger mention nobody", () => {
    // Two Anns: "@Ann" could be either, so it is neither.
    expect(findMentions("@Ann can you look", ROSTER)).toEqual([]);
    expect(findMentions("@Helena said so", ROSTER)).toEqual([]);
    expect(findMentions("write to family.helen@example.com", ROSTER)).toEqual([]);
    expect(findMentions("@Dr Smith", ROSTER)).toEqual([]);
  });

  it("counts a member once however often they are mentioned", () => {
    expect(findMentions("@Helen Okafor ... @helen okafor ... @Helen", ROSTER)).toEqual([HELEN]);
  });
});

describe("the composer's suggestions", () => {
  it("knows the @ word the caret is in", () => {
    const text = "please ask @hel";
    expect(mentionQueryAt(text, text.length)).toEqual({ start: 11, query: "hel" });
    expect(mentionQueryAt("@Helen Ok", 9)).toEqual({ start: 0, query: "Helen Ok" });
  });

  it("CONTROL: is not in one inside an address, after a line break, or far past the @", () => {
    expect(mentionQueryAt("mail family@gm", 14)).toBeNull();
    expect(mentionQueryAt("@hel\nnext line", 14)).toBeNull();
    expect(mentionQueryAt("@this is a long sentence now", 28)).toBeNull();
    expect(mentionQueryAt("no mention here", 15)).toBeNull();
  });

  it("suggests members by any word of their name, or their email", () => {
    expect(suggestMentions("ok", ROSTER).map((m) => m.userId)).toEqual([HELEN]);
    expect(suggestMentions("ann", ROSTER).map((m) => m.userId)).toEqual([ANN, ANN_LEE]);
    expect(suggestMentions("priya@", ROSTER).map((m) => m.userId)).toEqual([PRIYA]);
    expect(suggestMentions("", ROSTER)).toHaveLength(4);
  });
});
