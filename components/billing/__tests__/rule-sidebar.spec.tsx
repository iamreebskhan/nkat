/**
 * @vitest-environment jsdom
 */
/**
 * The payer-rules panel on the documentation screen and the bill.
 *
 * Three things went wrong on localhost on 3 Nov 2026, and each test below
 * fails against the panel as it was:
 *   - a bill dated 12 March was checked against July's rules: the panel never
 *     sent the bill's date, though its price came from that date;
 *   - signed in as a clinician, every lookup was refused (403): the panel
 *     called /api/billing/lookup, which needs a billing permission the
 *     clinician role does not hold;
 *   - the refusal showed as "checking…" for good, a check that never ends,
 *     instead of no check at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { RuleSidebar } from "../rule-sidebar";

const PAYER = "a0000000-0000-4000-8000-000000000401";
const VISIT = "d3a1d68e-aee7-4955-8bb2-f45467d9db1a";

const answer = (code: string, coverageStatus = "covered") => ({
  status: "ok",
  source: "structured_rule",
  answer: `For CPT ${code}: ${coverageStatus}.`,
  coverageStatus,
  confidence: 0.95,
  citation: {
    documentName: "Payer policy document",
    documentUrl: null,
    effectiveDate: "2026-01-01",
    verbatimQuote: `CMS National Physician Fee Schedule Relative Value File RVU26A (January 2026) — ${code}`,
    page: null,
  },
  comparison: null,
  conflict: false,
});

let requests: { url: string; body: Record<string, unknown> }[];
let reply: (url: string, body: Record<string, unknown>) => { status: number; json: unknown } | "network";

beforeEach(() => {
  requests = [];
  reply = (_url, body) => ({
    status: 200,
    json: { success: true, data: answer(String(body.cptCode)) },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url, body });
      const r = reply(url, body);
      if (r === "network") throw new TypeError("Failed to fetch");
      return { status: r.status, ok: r.status < 400, json: async () => r.json } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RuleSidebar — the date the rules are read on", () => {
  it("sends the bill's date of service with each lookup", async () => {
    render(<RuleSidebar payerId={PAYER} state="OH" cptCodes={["99350", "36415"]} dos="2026-03-12" />);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.map((r) => r.url)).toEqual(["/api/billing/lookup", "/api/billing/lookup"]);
    expect(requests.map((r) => r.body.dos)).toEqual(["2026-03-12", "2026-03-12"]);
  });

  it("CONTROL: without a date it sends none, and the lookup answers for today", async () => {
    render(<RuleSidebar payerId={PAYER} state="OH" cptCodes={["99350"]} />);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.body).not.toHaveProperty("dos");
  });
});

describe("RuleSidebar — through the visit", () => {
  beforeEach(() => {
    reply = (url, body) =>
      url === `/api/visits/${VISIT}/payer-rules`
        ? {
            status: 200,
            json: {
              success: true,
              data: {
                dos: "2026-03-12",
                results: Object.fromEntries((body.codes as string[]).map((c) => [c, answer(c)])),
              },
            },
          }
        : { status: 403, json: { success: false, error: "Permission denied: missing billing.lookup.view." } };
  });

  it("asks the visit's own route, once, for every code", async () => {
    render(
      <RuleSidebar visitId={VISIT} payerId={PAYER} state="OH" cptCodes={["99350", "G0318"]} attribute="covered" />,
    );
    await waitFor(() => expect(screen.getAllByText("Covered")).toHaveLength(2));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`/api/visits/${VISIT}/payer-rules`);
    expect(requests[0]!.body).toEqual({ codes: ["99350", "G0318"], attribute: "covered" });
    expect(screen.getByText("For CPT 99350: covered.")).toBeTruthy();
  });

  it("says when the visit's answer leaves a code out", async () => {
    reply = () => ({ status: 200, json: { success: true, data: { dos: "2026-03-12", results: {} } } });
    render(<RuleSidebar visitId={VISIT} payerId={PAYER} state="OH" cptCodes={["99350"]} />);
    expect(await screen.findByText("No answer came back for this code.")).toBeTruthy();
    expect(screen.queryByText("checking…")).toBeNull();
  });
});

describe("RuleSidebar — a lookup that does not answer says so", () => {
  it("a refused lookup reads 'not checked', never 'checking…' for good", async () => {
    reply = () => ({ status: 403, json: { success: false, error: "Permission denied: missing billing.lookup.view." } });
    render(<RuleSidebar payerId={PAYER} state="OH" cptCodes={["99350"]} />);
    expect(await screen.findByText("Payer rules aren't available to your role.")).toBeTruthy();
    expect(screen.getByText("not checked")).toBeTruthy();
    expect(screen.queryByText("checking…")).toBeNull();
  });

  it("a failed lookup shows its reason", async () => {
    reply = () => ({ status: 422, json: { success: false, error: "The rule library is unavailable." } });
    render(<RuleSidebar payerId={PAYER} state="OH" cptCodes={["99350"]} />);
    expect(await screen.findByText("The rule library is unavailable.")).toBeTruthy();
    expect(screen.queryByText("checking…")).toBeNull();
  });

  it("a network failure says so", async () => {
    reply = () => "network";
    render(<RuleSidebar visitId={VISIT} payerId={PAYER} state="OH" cptCodes={["99350"]} />);
    expect(await screen.findByText("Network error.")).toBeTruthy();
    expect(screen.queryByText("checking…")).toBeNull();
  });

  it("CONTROL: while the lookup is still on its way, it does read 'checking…'", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        await gate;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, ok: true, json: async () => ({ success: true, data: answer(String(body.cptCode)) }) } as Response;
      }),
    );
    render(<RuleSidebar payerId={PAYER} state="OH" cptCodes={["99350"]} />);
    expect(await screen.findByText("checking…")).toBeTruthy();
    release();
    expect(await screen.findByText("Covered")).toBeTruthy();
  });
});
