/**
 * @vitest-environment jsdom
 */
/**
 * The structured note component.
 *
 * Two of these tests exist because the bugs happened. Both were data loss on a
 * note that then locked, so neither was recoverable:
 *
 *   1. Sections autosave on blur, and clicking "Sign + submit" does not
 *      reliably blur the editor first. A Goals-of-care paragraph typed and then
 *      signed went to pending_billing with that section empty. The fix is the
 *      pending map plus flush(), which the page awaits before signing.
 *
 *   2. TipTap builds its document once inside useEditor and ignores later
 *      `initial` changes, so a section filled AFTER mount — carry-forward —
 *      kept showing an empty editor, and the next blur saved that emptiness
 *      straight over the carried text. The fix is keying the editor on
 *      `updatedAt`.
 *
 * The editor is faked, and the fake deliberately reproduces TipTap's
 * build-once behaviour (see FakeEditor). Without that the second test would be
 * circular — it would pass against a component that had never been fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/editor/tiptap-editor", async () => {
  const { useState } = await import("react");

  function FakeEditor({
    initial,
    onChange,
    onBlurSave,
    placeholder,
    readOnly,
  }: {
    initial?: unknown;
    onChange?: (doc: unknown) => void;
    onBlurSave?: (doc: unknown) => void;
    placeholder?: string;
    readOnly?: boolean;
  }) {
    // Seeded ONCE, at mount, and never re-seeded from the prop — which is
    // precisely what useEditor does with `content`. A later `initial` cannot
    // reach the visible text; only a remount can.
    const [text, setText] = useState(() => proseToText(initial));
    return (
      <textarea
        aria-label={placeholder ?? "Document content"}
        readOnly={readOnly}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange?.(textToProse(e.target.value));
        }}
        onBlur={(e) => onBlurSave?.(textToProse(e.target.value))}
      />
    );
  }
  return { TipTapEditor: FakeEditor };
});

import { SectionedNote } from "../sectioned-note";

const VISIT = "e0000000-0000-4000-8000-00000000000a";
const PREV = "e0000000-0000-4000-8000-00000000000b";
const CARRIED = "Metastatic NSCLC, on home oxygen. Daughter is primary carer.";

function textToProse(text: string) {
  return {
    type: "doc",
    content: text ? [{ type: "paragraph", content: [{ type: "text", text }] }] : [],
  };
}
function proseToText(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object") return;
    const node = n as { text?: unknown; content?: unknown };
    if (typeof node.text === "string") out.push(node.text);
    if (node.content) walk(node.content);
  };
  walk(doc);
  return out.join("");
}

// --- a small stand-in for the note API -------------------------------------
// PATCH mutates the store, so the component's re-read after a save sees what
// it wrote — including a moved updatedAt, which is what the editor keys on.

type Sec = {
  sectionKey: string; label: string; helpText: string | null;
  kind: "prose" | "list" | "vitals"; isRequired: boolean;
  content: unknown; isEmpty: boolean;
  carriedFromVisitId: string | null; carriedUnchanged: boolean; updatedAt: string | null;
};

let store: {
  sections: Sec[];
  vitals: Record<string, unknown> | null;
  carrySource: unknown;
  /** Set to an error message to make the next write fail. */
  failWith: string | null;
  clock: number;
};
let requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];

const sec = (o: Partial<Sec> & Pick<Sec, "sectionKey" | "label" | "kind">): Sec => ({
  helpText: null, isRequired: false, content: null, isEmpty: true,
  carriedFromVisitId: null, carriedUnchanged: false, updatedAt: null, ...o,
});

const stamp = () => new Date(Date.UTC(2026, 8, 9, 10, 0, store.clock++)).toISOString();

const noteBody = () => ({
  templateName: "Palliative visit note",
  templateVersion: 1,
  sections: store.sections,
  vitals: store.vitals,
  missingRequired: store.sections
    .filter((s) => s.isRequired && s.isEmpty)
    .map((s) => ({ sectionKey: s.sectionKey, label: s.label })),
});

function fakeFetch(url: string, init?: RequestInit) {
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  requests.push({ url, method, body });

  const json = (d: unknown) => Promise.resolve({ json: () => Promise.resolve(d) } as Response);
  const fail = () => json({ success: false, error: store.failWith });

  if (url.endsWith("/note") && method === "GET") return json({ success: true, data: noteBody() });

  if (url.endsWith("/note") && method === "PATCH") {
    if (store.failWith) return fail();
    const s = store.sections.find((x) => x.sectionKey === body!.sectionKey)!;
    s.content = body!.content;
    s.isEmpty = proseToText(body!.content).trim() === "" && !hasItems(body!.content);
    s.carriedUnchanged = false;
    s.updatedAt = stamp();
    return json({ success: true, data: { updated: true, isEmpty: s.isEmpty } });
  }

  if (url.endsWith("/carry-forward") && method === "GET") {
    return json({ success: true, data: { source: store.carrySource } });
  }

  if (url.endsWith("/carry-forward") && method === "POST") {
    if (store.failWith) return fail();
    for (const key of body!.sectionKeys as string[]) {
      const s = store.sections.find((x) => x.sectionKey === key);
      if (!s || !s.isEmpty) continue;
      s.content = textToProse(CARRIED);
      s.isEmpty = false;
      s.carriedFromVisitId = PREV;
      s.carriedUnchanged = true;
      s.updatedAt = stamp();
    }
    return json({ success: true, data: { copied: body!.sectionKeys, skipped: [] } });
  }

  if (url.endsWith("/vitals") && method === "PUT") {
    if (store.failWith) return fail();
    store.vitals = { ...(store.vitals ?? {}), ...body, recordedAt: stamp() };
    return json({ success: true, data: { updated: true } });
  }

  return json({ success: false, error: `unrouted ${method} ${url}` });
}

const hasItems = (c: unknown) => {
  const items = (c as { items?: unknown })?.items;
  return Array.isArray(items) && items.length > 0;
};

const patches = () => requests.filter((r) => r.method === "PATCH");
const lastPatch = () => patches().at(-1);

/** Latest flush handed over by the component, as the page holds it. */
let flushRef: (() => Promise<boolean>) | null = null;
const registerFlush = (f: () => Promise<boolean>) => {
  flushRef = f;
};

beforeEach(() => {
  requests = [];
  flushRef = null;
  store = {
    sections: [
      sec({ sectionKey: "hpi", label: "History of present illness", kind: "prose", isRequired: true }),
      sec({ sectionKey: "goals_of_care", label: "Goals of care", kind: "prose" }),
      sec({ sectionKey: "medications", label: "Medications", kind: "list" }),
      sec({ sectionKey: "vitals", label: "Vitals", kind: "vitals" }),
    ],
    vitals: null,
    carrySource: null,
    failWith: null,
    clock: 0,
  };
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = (props: Partial<Parameters<typeof SectionedNote>[0]> = {}) =>
  render(<SectionedNote visitId={VISIT} registerFlush={registerFlush} {...props} />);

/** Wait for the initial load to settle. */
const ready = () => screen.findByLabelText("History of present illness");

describe("SectionedNote — rendering", () => {
  it("shows a loading line before the note arrives", () => {
    mount();
    expect(screen.getByText("Loading the note…")).toBeTruthy();
  });

  it("renders one control per template section, in template order", async () => {
    mount();
    await ready();
    expect(screen.getByLabelText("Goals of care")).toBeTruthy();
    expect(screen.getByLabelText("Medications")).toBeTruthy();
    expect(screen.getByLabelText("Weight lb")).toBeTruthy();
  });

  it("names the template version the note was written against", async () => {
    mount();
    await ready();
    expect(screen.getByText("Palliative visit note · v1")).toBeTruthy();
  });

  it("says which required sections still block signing", async () => {
    mount();
    await ready();
    expect(screen.getByText(/Still needed to sign/).textContent).toBe(
      "Still needed to sign: History of present illness",
    );
  });

  it("stops naming a required section once it holds text", async () => {
    store.sections[0]!.content = textToProse("Increasing dyspnoea.");
    store.sections[0]!.isEmpty = false;
    mount();
    await ready();
    expect(screen.queryByText(/Still needed to sign/)).toBeNull();
  });

  it("surfaces an API error where the clinician will see it", async () => {
    store.failWith = "This visit is signed and submitted.";
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });
    fireEvent.blur(screen.getByLabelText("Goals of care"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This visit is signed and submitted.");
  });
});

describe("SectionedNote — saving on blur", () => {
  it("saves a prose section when it loses focus", async () => {
    mount();
    await ready();
    const box = screen.getByLabelText("Goals of care");
    fireEvent.change(box, { target: { value: "Comfort-focused; DNR in place." } });
    fireEvent.blur(box);

    await waitFor(() => expect(lastPatch()).toBeTruthy());
    expect(lastPatch()!.body).toMatchObject({ sectionKey: "goals_of_care" });
    expect(proseToText(lastPatch()!.body!.content)).toBe("Comfort-focused; DNR in place.");
  });

  it("splits a list section by line, trimming blanks", async () => {
    mount();
    await ready();
    const box = screen.getByLabelText("Medications");
    fireEvent.change(box, { target: { value: "Morphine 2.5mg\n\n  Lorazepam 0.5mg  \n" } });
    fireEvent.blur(box);

    await waitFor(() => expect(lastPatch()).toBeTruthy());
    expect(lastPatch()!.body!.content).toEqual({
      items: ["Morphine 2.5mg", "Lorazepam 0.5mg"],
    });
  });

  it("re-reads from the server instead of trusting local state", async () => {
    // The server decides whether a section counts as empty, and that drives
    // the sign-off guard.
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });
    fireEvent.blur(screen.getByLabelText("Goals of care"));
    await waitFor(() => expect(lastPatch()).toBeTruthy());
    await waitFor(() =>
      expect(requests.filter((r) => r.method === "GET" && r.url.endsWith("/note")).length).toBe(2),
    );
  });

  it("tells the parent after a successful write", async () => {
    const onSaved = vi.fn();
    mount({ onSaved });
    await ready();
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });
    fireEvent.blur(screen.getByLabelText("Goals of care"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("does not tell the parent when the write failed", async () => {
    store.failWith = "nope";
    const onSaved = vi.fn();
    mount({ onSaved });
    await ready();
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });
    fireEvent.blur(screen.getByLabelText("Goals of care"));
    await screen.findByRole("alert");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("writes nothing at all in read-only mode", async () => {
    mount({ readOnly: true });
    await ready();
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });
    fireEvent.blur(screen.getByLabelText("Goals of care"));
    await Promise.resolve();
    expect(patches()).toHaveLength(0);
  });
});

describe("SectionedNote — flush() before signing (regression)", () => {
  it("persists a section typed into but never blurred", async () => {
    // The bug: sign without blurring, and this paragraph was gone for good.
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Goals of care"), {
      target: { value: "Comfort-focused; daughter agrees; DNR signed today." },
    });
    expect(patches()).toHaveLength(0); // nothing saved yet — this is the danger

    await flushRef!();

    expect(patches()).toHaveLength(1);
    expect(lastPatch()!.body!.sectionKey).toBe("goals_of_care");
    expect(proseToText(lastPatch()!.body!.content)).toBe(
      "Comfort-focused; daughter agrees; DNR signed today.",
    );
    expect(store.sections.find((s) => s.sectionKey === "goals_of_care")!.isEmpty).toBe(false);
  });

  it("persists every unblurred section, not just the last one touched", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("History of present illness"), {
      target: { value: "Increasing dyspnoea over four days." },
    });
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });

    await flushRef!();

    expect(patches().map((p) => p.body!.sectionKey).sort()).toEqual(["goals_of_care", "hpi"]);
  });

  it("stops re-sending a section once it has saved", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });
    await flushRef!();
    await flushRef!();
    expect(patches()).toHaveLength(1);
  });

  it("has nothing to do when nothing was typed", async () => {
    mount();
    await ready();
    await flushRef!();
    expect(patches()).toHaveLength(0);
  });

  it("keeps a section pending when its save failed, so signing can be retried", async () => {
    store.failWith = "network is down";
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });
    await flushRef!();
    expect(patches()).toHaveLength(1);

    store.failWith = null;
    await flushRef!();
    expect(patches()).toHaveLength(2);
    expect(store.sections.find((s) => s.sectionKey === "goals_of_care")!.isEmpty).toBe(false);
  });

  it("reports failure to the caller, so the caller can decline to sign", async () => {
    // Keeping the section pending is not enough on its own: the caller signs
    // next, and signing locks the note. saveSection handles its own error, so
    // only this return value can stop the visit locking over unsaved text.
    store.failWith = "network is down";
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });
    expect(await flushRef!()).toBe(false);
  });

  it("reports success when everything landed", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });
    expect(await flushRef!()).toBe(true);
  });

  it("reports success when there was nothing to flush", async () => {
    mount();
    await ready();
    expect(await flushRef!()).toBe(true);
  });

  it("reports success on a read-only note rather than blocking the caller", async () => {
    mount({ readOnly: true });
    await ready();
    expect(await flushRef!()).toBe(true);
  });

  it("reports failure if any one section fails, even when others saved", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("History of present illness"), {
      target: { value: "Increasing dyspnoea." },
    });
    fireEvent.change(screen.getByLabelText("Goals of care"), { target: { value: "Comfort." } });
    // First save succeeds, then the connection drops.
    const realFetch = globalThis.fetch as typeof fetch;
    let n = 0;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH" && n++ === 1) store.failWith = "network is down";
      return (realFetch as unknown as typeof fakeFetch)(url, init);
    }));

    expect(await flushRef!()).toBe(false);
    expect(patches()).toHaveLength(2);
  });

  it("writes nothing when the note is read-only", async () => {
    mount({ readOnly: true });
    await ready();
    await flushRef!();
    expect(patches()).toHaveLength(0);
  });
});

describe("SectionedNote — carry forward (regression)", () => {
  beforeEach(() => {
    store.carrySource = {
      visitId: PREV,
      visitDate: "2026-09-01T14:00:00.000Z",
      visitTypeLabel: "Established patient — home",
      sections: [
        { sectionKey: "hpi", label: "History of present illness" },
        { sectionKey: "goals_of_care", label: "Goals of care" },
      ],
    };
  });

  it("offers the last signed visit's completed sections", async () => {
    mount();
    await ready();
    expect(await screen.findByText(/Established patient — home/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Carry forward/ })).toBeTruthy();
  });

  it("asks only for sections that are empty here", async () => {
    // Carrying forward must never replace something written on this encounter.
    store.sections[0]!.content = textToProse("Written today.");
    store.sections[0]!.isEmpty = false;
    mount();
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: /Carry forward/ }));

    await waitFor(() =>
      expect(requests.find((r) => r.method === "POST")).toBeTruthy(),
    );
    expect(requests.find((r) => r.method === "POST")!.body).toEqual({
      fromVisitId: PREV,
      sectionKeys: ["goals_of_care"],
    });
  });

  it("shows the carried text in the editor rather than a stale empty one", async () => {
    // THE regression. The section is filled after mount, so the editor's
    // build-once document is out of date; only the updatedAt key remounts it.
    mount();
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: /Carry forward/ }));

    await waitFor(() =>
      expect((screen.getByLabelText("History of present illness") as HTMLTextAreaElement).value).toBe(
        CARRIED,
      ),
    );
  });

  it("blurring after a carry-forward saves the carried text, not emptiness", async () => {
    // What the stale editor actually cost: the next blur wrote "" over the
    // text that had just been brought forward.
    mount();
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: /Carry forward/ }));
    await waitFor(() =>
      expect((screen.getByLabelText("Goals of care") as HTMLTextAreaElement).value).toBe(CARRIED),
    );

    fireEvent.blur(screen.getByLabelText("Goals of care"));
    await waitFor(() => expect(lastPatch()).toBeTruthy());
    expect(proseToText(lastPatch()!.body!.content)).toBe(CARRIED);
    expect(store.sections.find((s) => s.sectionKey === "goals_of_care")!.isEmpty).toBe(false);
  });

  it("marks a carried section as unedited until it is changed", async () => {
    mount();
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: /Carry forward/ }));
    // Visible on the note, not buried in an audit log — a clinician about to
    // sign should see which paragraphs they did not write this visit.
    expect(await screen.findAllByText("carried forward · unedited")).toHaveLength(2);
  });

  it("drops the unedited marker once the clinician writes over it", async () => {
    mount();
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: /Carry forward/ }));
    await screen.findAllByText("carried forward · unedited");

    const box = screen.getByLabelText("Goals of care");
    fireEvent.change(box, { target: { value: `${CARRIED} Reviewed and revised today.` } });
    fireEvent.blur(box);

    await waitFor(() => expect(screen.getAllByText("carried forward · unedited")).toHaveLength(1));
    expect(screen.getByText("carried forward · revised")).toBeTruthy();
  });

  it("offers nothing to carry when every section here is already written", async () => {
    for (const s of store.sections) s.isEmpty = false;
    mount();
    await ready();
    expect((await screen.findByRole("button", { name: /Carry forward/ })).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("does not offer carry-forward on a read-only note", async () => {
    mount({ readOnly: true });
    await ready();
    expect(screen.queryByRole("button", { name: /Carry forward/ })).toBeNull();
  });
});

describe("SectionedNote — vitals", () => {
  it("labels weight, height and temperature in US customary units", async () => {
    // Mark is a US palliative NP. A form that asks him for kilograms is how a
    // 150 lb patient gets recorded as 150 kg.
    mount();
    await ready();
    expect(screen.getByLabelText("Weight lb")).toBeTruthy();
    expect(screen.getByLabelText("Height in")).toBeTruthy();
    expect(screen.getByLabelText("Temperature °F")).toBeTruthy();
  });

  it("saves the value just typed, converted to the metric the column stores", async () => {
    // onBlur reads e.target.value. Reading `vitals` instead would save the
    // pre-change state whenever change and blur land in the same tick.
    mount();
    await ready();
    const weight = screen.getByLabelText("Weight lb");
    fireEvent.change(weight, { target: { value: "150.5" } });
    fireEvent.blur(weight);

    await waitFor(() => expect(requests.find((r) => r.method === "PUT")).toBeTruthy());
    expect(requests.find((r) => r.method === "PUT")!.body!.weightKg).toBe(68.27);
  });

  it("shows a stored metric weight back in pounds", async () => {
    store.vitals = { weightKg: 68.27, recordedAt: "2026-09-09T10:00:00.000Z" };
    mount();
    await ready();
    expect((screen.getByLabelText("Weight lb") as HTMLInputElement).value).toBe("150.5");
  });

  it("round-trips a temperature the clinician typed", async () => {
    // 97.8 F is the value that used to come back as 97.9.
    mount();
    await ready();
    const temp = screen.getByLabelText("Temperature °F");
    fireEvent.change(temp, { target: { value: "97.8" } });
    fireEvent.blur(temp);

    await waitFor(() => expect(requests.find((r) => r.method === "PUT")).toBeTruthy());
    const storedC = requests.find((r) => r.method === "PUT")!.body!.temperatureC;
    expect(storedC).toBe(36.56);

    cleanup();
    store.vitals = { temperatureC: storedC, recordedAt: "2026-09-09T10:00:00.000Z" };
    mount();
    await ready();
    expect((screen.getByLabelText("Temperature °F") as HTMLInputElement).value).toBe("97.8");
  });

  it("sends a cleared field as null rather than zero", async () => {
    // Number("") is 0, and a recorded weight of 0 is not a missing weight.
    store.vitals = { weightKg: 61.4, painScore: null, recordedAt: "2026-09-09T10:00:00.000Z" };
    mount();
    await ready();
    const weight = screen.getByLabelText("Weight lb");
    fireEvent.change(weight, { target: { value: "" } });
    fireEvent.blur(weight);

    await waitFor(() => expect(requests.find((r) => r.method === "PUT")).toBeTruthy());
    expect(requests.find((r) => r.method === "PUT")!.body!.weightKg).toBeNull();
  });

  it("keeps a zero reading — a pain score of 0 is an observation", async () => {
    mount();
    await ready();
    const pain = screen.getByLabelText("Pain /10");
    fireEvent.change(pain, { target: { value: "0" } });
    fireEvent.blur(pain);

    await waitFor(() => expect(requests.find((r) => r.method === "PUT")).toBeTruthy());
    expect(requests.find((r) => r.method === "PUT")!.body!.painScore).toBe(0);
  });

  it("never sends recordedAt — the server stamps it", async () => {
    mount();
    await ready();
    const weight = screen.getByLabelText("Weight lb");
    fireEvent.change(weight, { target: { value: "61.4" } });
    fireEvent.blur(weight);

    await waitFor(() => expect(requests.find((r) => r.method === "PUT")).toBeTruthy());
    expect(requests.find((r) => r.method === "PUT")!.body).not.toHaveProperty("recordedAt");
  });

  it("writes no vitals in read-only mode", async () => {
    store.vitals = { weightKg: 61.4, recordedAt: "2026-09-09T10:00:00.000Z" };
    mount({ readOnly: true });
    await ready();
    const weight = screen.getByLabelText("Weight lb");
    fireEvent.blur(weight);
    await Promise.resolve();
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });
});
