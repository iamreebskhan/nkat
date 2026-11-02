/**
 * Offline (0119; doc:33; Mark Q8 default): text ↔ note, and the rule for when
 * a draft written offline may be sent. Pure.
 */
import { describe, expect, it } from "vitest";

import { proseToText } from "@/lib/features/visits/note-render";
import { sectionContentIsEmpty } from "@/lib/features/visits/note-template";

import {
  OFFLINE_MAX_AGE_HOURS,
  draftContent,
  listText,
  planDraft,
  proseText,
  snapshotIsFresh,
  textToList,
  textToProse,
} from "../offline";

describe("text ↔ note", () => {
  it("edits a prose section as lines and sends it back as paragraphs the note reads", () => {
    const typed = "Dyspnea worse at night.\n\nMorphine IR helps.\n";
    const doc = textToProse(typed);
    expect(doc).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Dyspnea worse at night." }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "Morphine IR helps." }] },
      ],
    });
    // What the device shows is what was typed; what the server reads is the same text.
    expect(proseText(doc)).toBe("Dyspnea worse at night.\n\nMorphine IR helps.");
    expect(proseToText(doc)).toBe("Dyspnea worse at night.\n\nMorphine IR helps.");
    expect(sectionContentIsEmpty("prose", doc)).toBe(false);
  });

  it("reads a section the online editor wrote, list items and line breaks included", () => {
    const online = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Plan:" }, { type: "hardBreak" }, { type: "text", text: "fan at night" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "head of bed up" }] }] }] },
        { type: "paragraph" },
      ],
    };
    expect(proseText(online)).toBe("Plan:\nfan at night\nhead of bed up");
    expect(proseText(null)).toBe("");
  });

  it("edits a list one item a line, dropping blank lines", () => {
    expect(listText({ items: ["Morphine IR 5 mg PO q4h PRN", "Senna 8.6 mg nightly"] })).toBe("Morphine IR 5 mg PO q4h PRN\nSenna 8.6 mg nightly");
    expect(textToList(" Morphine IR \r\n\r\nSenna\n")).toEqual({ items: ["Morphine IR", "Senna"] });
    expect(draftContent({ kind: "list", text: "a\nb" })).toEqual({ items: ["a", "b"] });
    // CONTROL: an emptied section reads as empty, so the sign guard still asks for it.
    expect(sectionContentIsEmpty("prose", textToProse("   \n"))).toBe(true);
    expect(sectionContentIsEmpty("list", textToList("\n \n"))).toBe(true);
  });
});

describe("when a draft may go", () => {
  const d = { baseUpdatedAt: "2026-10-28T22:29:55.299Z", label: "History of present illness" };
  const open = { visitStatus: "in_progress", sectionExists: true };

  it("goes onto the version it was written against, and a first write onto none", () => {
    expect(planDraft(d, { ...open, updatedAt: "2026-10-28T22:29:55.299Z" })).toEqual({ send: true });
    expect(planDraft({ ...d, baseUpdatedAt: null }, { ...open, visitStatus: "scheduled", updatedAt: null })).toEqual({ send: true });
  });

  it("CONTROL: never over a newer version, a signed note, or a visit that did not happen", () => {
    expect(planDraft(d, { ...open, updatedAt: "2026-10-28T22:40:00.000Z" })).toMatchObject({
      send: false,
      problem: expect.stringMatching(/changed on the server after this copy was saved.*nothing was overwritten/),
    });
    // Written by someone else for the first time since: not empty any more.
    expect(planDraft({ ...d, baseUpdatedAt: null }, { ...open, updatedAt: "2026-10-28T22:40:00.000Z" }).send).toBe(false);
    for (const visitStatus of ["documented", "pending_billing", "billed"]) {
      expect(planDraft(d, { ...open, visitStatus, updatedAt: d.baseUpdatedAt })).toMatchObject({
        send: false, problem: expect.stringMatching(/signed since.*addendum/),
      });
    }
    expect(planDraft(d, { ...open, visitStatus: "no_show", updatedAt: d.baseUpdatedAt })).toMatchObject({
      send: false, problem: "The visit was marked no-show since.",
    });
    expect(planDraft(d, { ...open, sectionExists: false, updatedAt: null }).send).toBe(false);
  });

  it("keeps a saved copy for so long, and no longer", () => {
    const now = new Date("2026-10-31T12:00:00Z");
    const ago = (h: number) => ({ generatedAt: new Date(now.getTime() - h * 3_600_000).toISOString() });
    expect(snapshotIsFresh(ago(OFFLINE_MAX_AGE_HOURS), now)).toBe(true);
    expect(snapshotIsFresh(ago(OFFLINE_MAX_AGE_HOURS + 1), now)).toBe(false);
  });
});
