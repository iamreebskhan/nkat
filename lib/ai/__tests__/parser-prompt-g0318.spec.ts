/**
 * Control: the parser prompt's G0318 lines agree with the CPT suggester.
 *
 * The prompt told the parser "Medicare + home-visit time beyond the 60-min
 * level (e.g. 70 min) → G0318" and described G0318 as "Medicare longitudinal
 * palliative care". The suggester, which is what bills, starts G0318 at the
 * CMS total time plus 15 minutes: 110 on an established visit (99350) and 140
 * on a new-patient visit (99345), pinned in cpt-suggester.spec.ts. G0318 is
 * the prolonged home/residence E/M add-on, one unit per full 15 minutes. A
 * billing agent asking about a 70-minute Medicare visit was routed to an
 * add-on CMS does not pay for it.
 *
 * The system text is captured from a REAL parseRuleQuery call: the SDK, env
 * and db are faked, the prompt and the call path are not. The start minutes
 * are computed from the real suggestCodes over the seeded ladder rather than
 * restated here, so moving them in the suggester turns this red on purpose.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildBands,
  suggestCodes,
  type VisitCodeBands,
} from "@/lib/features/visits/cpt-suggester";

type CreateRequest = {
  model: string;
  system: string;
  messages: Array<{ role: string; content: string }>;
};
type CreateResponse = { content: Array<{ type: string; text: string }> };

const h = vi.hoisted(() => {
  const create = vi.fn<(req: CreateRequest) => Promise<CreateResponse>>();
  const Anthropic = vi.fn(function FakeAnthropic() {
    return { messages: { create } };
  });
  return { create, Anthropic, recordedSql: [] as string[] };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: h.Anthropic }));

vi.mock("@/lib/env", () => ({
  env: () => ({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://x",
    JWT_SECRET: "x".repeat(32),
    JWT_EXPIRES_IN: "7d",
    COOKIE_NAME: "pallio_session",
    ANTHROPIC_API_KEY: "test",
    OPENAI_API_KEY: "test",
    EMAIL_FROM_ADDRESS: "no-reply@pallio.local",
    UPLOAD_DIR: "./var/uploads",
    MAX_FILE_SIZE_MB: 2000,
    CHUNK_SIZE_MB: 5,
    APP_BASE_URL: "http://localhost:3000",
  }),
}));

// Answers only the SQL it is sent: the model-pin read in runtime-settings.ts,
// with no pin stored. Anything else rejects. runtime-settings swallows every
// error and falls back, so the rejection alone proves nothing; the third test
// asserts the one statement recorded was the system_setting read.
vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join("¶");
      h.recordedSql.push(sql);
      return sql.includes("FROM system_setting")
        ? Promise.resolve([])
        : Promise.reject(new Error(`unexpected SQL in parser-prompt spec: ${sql}`));
    },
  },
}));

import { parseRuleQuery } from "../anthropic.client";

/** The ladders as db/seed/0007_palliative_codes.sql stores them. */
const BANDS: VisitCodeBands = {
  newPatientHome: buildBands([
    { code: "99341", typicalMinutes: 15 },
    { code: "99342", typicalMinutes: 30 },
    { code: "99344", typicalMinutes: 60 },
    { code: "99345", typicalMinutes: 75 },
  ]),
  establishedPatientHome: buildBands([
    { code: "99347", typicalMinutes: 20 },
    { code: "99348", typicalMinutes: 30 },
    { code: "99349", typicalMinutes: 40 },
    { code: "99350", typicalMinutes: 60 },
  ]),
};

const LADDERS = [
  { label: "established patient (99350)", visitType: "established_patient_home" },
  { label: "new patient (99345)", visitType: "new_patient_home" },
] as const;

/** The first whole minute at which the real suggester bills G0318 on a Medicare visit. */
function firstG0318(visitType: (typeof LADDERS)[number]["visitType"]): number | undefined {
  for (let m = 1; m <= 600; m++) {
    const s = suggestCodes({
      bands: BANDS,
      visitType,
      totalMinutes: m,
      acpMinutes: 0,
      payerCategory: "medicare",
    });
    if (s.prolongedAddOns.some((c) => c.code === "G0318")) return m;
  }
  return undefined;
}

/**
 * Every minute figure the line routes to G0318: the "N min" / "N-min"
 * figures in the text before each "→ G0318".
 */
function minutesRoutedToG0318(line: string): number[] {
  const out: number[] = [];
  const parts = line.split("→");
  for (let i = 1; i < parts.length; i++) {
    if (!/^\s*G0318\b/.test(parts[i]!)) continue;
    for (const m of parts[i - 1]!.matchAll(/(\d+)(?:\s*|-)min(?:ute)?s?\b/g)) {
      out.push(Number(m[1]));
    }
  }
  return out;
}

const QUERY = "Medicare prolonged service add-on for home visit";

let parsed: Awaited<ReturnType<typeof parseRuleQuery>>;
let systemText = "";
let g0318Lines: string[] = [];

beforeAll(async () => {
  h.create.mockResolvedValue({
    content: [
      {
        type: "text",
        text: '{"payer":"Medicare","state":null,"cptCode":"G0318","attribute":null}',
      },
    ],
  });
  parsed = await parseRuleQuery(QUERY);
  systemText = h.create.mock.calls[0]?.[0].system ?? "";
  g0318Lines = systemText.split("\n").filter((l) => l.includes("G0318"));
});

describe("parser prompt: G0318 agrees with the CPT suggester", () => {
  it("CONTROL: states where G0318 starts on each ladder, and routes no shorter visit to it", () => {
    const problems: string[] = [];
    const starts: number[] = [];
    for (const { label, visitType } of LADDERS) {
      const start = firstG0318(visitType);
      if (start === undefined) {
        problems.push(`suggestCodes never bills G0318 on the ${label} ladder up to 600 min`);
        continue;
      }
      starts.push(start);
      if (!g0318Lines.some((l) => new RegExp(`\\b${start}\\s*min`).test(l))) {
        problems.push(
          `no G0318 prompt line states "${start} min", where the suggester starts G0318 on the ${label} ladder`,
        );
      }
    }
    if (starts.length > 0) {
      const lowest = Math.min(...starts);
      for (const l of g0318Lines) {
        for (const m of minutesRoutedToG0318(l)) {
          if (m < lowest) {
            problems.push(`routes ${m} min to G0318, below the suggester's first G0318 minute (${lowest}): ${l.trim()}`);
          }
        }
      }
    }
    expect(problems, `G0318 prompt lines:\n${g0318Lines.join("\n")}`).toEqual([]);
  });

  it("CONTROL: the G0318 catalog line describes the prolonged home add-on per 15 min", () => {
    const line = systemText.split("\n").find((l) => /^\s*G0318\s*=/.test(l));
    expect(line, "no 'G0318 =' catalog line in the parser prompt").toBeDefined();
    const text = line ?? "";
    const problems: string[] = [];
    if (!/prolonged/i.test(text)) problems.push("does not say prolonged");
    if (!/home/i.test(text)) problems.push("does not say home");
    if (!/\b15 min\b/.test(text)) problems.push('does not say "15 min"');
    if (/longitudinal/i.test(text)) problems.push("says longitudinal");
    if (/care management/i.test(text)) problems.push("says care management");
    expect(problems, text.trim()).toEqual([]);
  });

  it("is a real call: one haiku request with the prompt, the model pin read, the JSON parsed", () => {
    expect(parsed).toEqual({ payer: "Medicare", state: null, cptCode: "G0318", attribute: null });
    expect(h.Anthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "test" }));
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: QUERY }],
    });
    expect(systemText).toContain("CPT/HCPCS catalog");
    expect(h.recordedSql).toHaveLength(1);
    expect(h.recordedSql[0]).toMatch(/FROM system_setting/);
  });
});
