#!/usr/bin/env node
/**
 * =============================================================================
 * audit-live-answers.mjs — LAYER 3 of the rule-library production audit.
 * =============================================================================
 *
 * WHAT THIS PROVES
 * ----------------
 * Layers 1 and 2 count rows. This one prints the ANSWER. For every in-scope
 * palliative-care code crossed with every payer/state that has rules, it
 * resolves the live rule for each of the four attributes the denial scorer
 * consumes (covered, prior_auth_required, modifier_required, frequency_limit)
 * and renders exactly what a nurse practitioner would be shown in the billing
 * lookup panel:
 *
 *   - the answer sentence, produced by re-implementing, verbatim in behaviour,
 *     `describeRuleValue()` + `renderStructuredAnswer()` from
 *     lib/features/billing/rule-lookup.service.ts;
 *   - the citation block, produced the same way the service builds it
 *     (`documentName` / `verbatimQuote` / `documentUrl` / effective date);
 *   - the row-selection itself, produced by replicating `fetchPayerRule()` in
 *     lib/features/billing/payer-rule.repository.ts — same date-of-service
 *     window, same state-Medicaid `payer_id IS NULL` fallback for
 *     medicaid_mco / medicaid_state / tribal payers, same ORDER BY
 *     (own policy first, then product_line match, then newest effective date),
 *     same LIMIT 1.
 *
 * So a human can READ the output and judge whether the answers are real,
 * specific and sourced — not merely that a COUNT(*) matched. Every rendered
 * answer is additionally machine-checked for emptiness, missing citation,
 * placeholder/stock wording, and sub-threshold confidence (< 0.50, the
 * MIN_SQL_CONFIDENCE floor below which the service DISCARDS the structured
 * rule and falls through to RAG + Claude).
 *
 * WHAT THIS DELIBERATELY DOES *NOT* DO
 * ------------------------------------
 *  1. It never calls the Anthropic API, and never can: there is no HTTP client
 *     in this file. `lookupRule()` falls through to retrieval + Claude
 *     synthesis whenever NO structured rule exists, so exercising empty cells
 *     would fire thousands of paid calls. Empty cells are counted, and five are
 *     printed as a named sample, but they are NOT resolved.
 *  2. It does not import the TypeScript service. `tsx` is not installed on the
 *     VPS and `npx <anything>` blocks trying to download it. This is plain
 *     Node ESM talking to psql through child_process, because `pg` is not a
 *     dependency of this project (checked package.json).
 *  3. It does not exercise the ORG rulebook layer (`fetchOrgRule`). That is
 *     per-tenant, RLS-scoped data; this audit is of the GLOBAL library only.
 *     In the real service an org override would win over everything below.
 *  4. It does not judge whether an answer is CLINICALLY CORRECT. It proves the
 *     answer exists, is specific, is sourced to a verbatim quote in a real
 *     document, and is confident enough to actually be served. Correctness is
 *     a human reading the quotes printed here against payer policy.
 *  5. It does not "improve" the wording it prints. The service labels every
 *     code "For CPT <code>", including HCPCS G-codes; that is reproduced
 *     as-is, because the point is to show the panel text, not a nicer version
 *     of it. Fix the wording in rule-lookup.service.ts, not here.
 *  6. It reads nothing but SELECTs. The connection is opened with
 *     `default_transaction_read_only=on` via PGOPTIONS, so the server itself
 *     would reject a write even if one were somehow issued, and every SQL
 *     string is statically checked before it is handed to psql.
 *
 * USAGE (production VPS, as root)
 * -------------------------------
 *   node scripts/audit-live-answers.mjs                 # full report
 *   node scripts/audit-live-answers.mjs --brief         # checks + defects only
 *   node scripts/audit-live-answers.mjs | tee audit.txt # keep a copy to paste
 *
 * Defaults to `sudo -u postgres psql -d pallio`. Override the whole command
 * with AUDIT_PSQL, e.g. for a local dev database:
 *   AUDIT_PSQL="psql -h localhost -p 5432 -U postgres -d billing_rules" \
 *     node scripts/audit-live-answers.mjs
 *
 * Exit code 0 when every check passes, 1 when any check fails.
 * =============================================================================
 */

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Scope. 99343 is deliberately NOT here — it was deleted from CPT and must
// have no live rules; it is checked for separately as a negative control.
// ---------------------------------------------------------------------------
const CODES = [
  "99341", "99342", "99344", "99345", "99347", "99348", "99349", "99350",
  "99497", "99498", "99417", "G0318",
  "G0179", "G0180", "G0181",
  "99495", "99496",
  "99490", "99439", "99491", "99424", "99425", "99426", "99427",
  "99499",
];
const RETIRED_CODES = ["99343"];

/**
 * The four attributes lib/features/billing/predict-superbill.service.ts feeds
 * into scoreLine() in denial-risk.service.ts. These are the ones that decide
 * whether a claim gets paid, so these are the ones we render.
 */
const ATTRIBUTES = [
  "covered",
  "prior_auth_required",
  "modifier_required",
  "frequency_limit",
];

/** rule-lookup.service.ts: a structured rule below this is thrown away. */
const MIN_SQL_CONFIDENCE = 0.5;

/** Default product_line the lookup service asks for. */
const DEFAULT_PRODUCT_LINE = "commercial";

const ANSWER_CHARS = 200;
const CITE_CHARS = 120;
const MIN_ANSWER_CHARS = 40;
const MIN_QUOTE_CHARS = 25;
const EMPTY_CELL_SAMPLE = 5;

const BRIEF = process.argv.includes("--brief");

// ---------------------------------------------------------------------------
// psql plumbing. No `pg` dependency exists in package.json, and psql is always
// present on the VPS, so we shell out. Never npx — it blocks on download.
// ---------------------------------------------------------------------------
const PSQL_CMD = (process.env.AUDIT_PSQL || "sudo -u postgres psql -d pallio")
  .trim()
  .split(/\s+/);

const FORBIDDEN = /\b(insert|update|delete|alter|drop|truncate|create|grant|revoke|copy|vacuum|refresh|call|do)\b/i;

/** Static read-only guard: refuse to hand psql anything that is not a query. */
function assertReadOnly(sql) {
  const head = sql.trim().slice(0, 8).toLowerCase();
  if (!head.startsWith("select") && !head.startsWith("with")) {
    throw new Error(`REFUSED: statement does not start with SELECT/WITH:\n${sql.slice(0, 120)}`);
  }
  // Strip string literals before keyword-scanning so a quote containing the
  // word "update" in payer prose cannot trip the guard.
  const stripped = sql.replace(/'([^']|'')*'/g, "''");
  const hit = stripped.match(FORBIDDEN);
  if (hit) {
    throw new Error(`REFUSED: forbidden keyword "${hit[0]}" in SQL:\n${sql.slice(0, 120)}`);
  }
  return sql;
}

function psqlRaw(sql) {
  assertReadOnly(sql);
  const [bin, ...args] = PSQL_CMD;
  const res = spawnSync(
    bin,
    [...args, "-v", "ON_ERROR_STOP=1", "-A", "-t", "-c", sql],
    {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      env: {
        ...process.env,
        PGCLIENTENCODING: "UTF8",
        // Belt and braces: the SERVER refuses writes on this connection.
        PGOPTIONS: "-c default_transaction_read_only=on",
      },
    },
  );
  if (res.error) {
    throw new Error(`Could not run "${PSQL_CMD.join(" ")}": ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `psql exited ${res.status}\n${(res.stderr || "").trim()}\n` +
        `(while running: ${sql.replace(/\s+/g, " ").trim().slice(0, 120)}…)`,
    );
  }
  return (res.stdout || "").trim();
}

/** Run a query wrapped in json_agg and parse it. One round trip, no parsing of
 *  delimiter-separated text (payer prose is full of pipes and newlines). */
function psqlJson(innerSelect) {
  const out = psqlRaw(
    `SELECT coalesce(json_agg(__t), '[]'::json)::text FROM (\n${innerSelect}\n) __t`,
  );
  return JSON.parse(out || "[]");
}

const sqlList = (arr) => arr.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(", ");

// ---------------------------------------------------------------------------
// Answer rendering — ported behaviour-for-behaviour from
// lib/features/billing/rule-lookup.service.ts. If that file changes, change
// this too, or the audit stops auditing the real thing.
// ---------------------------------------------------------------------------
function describeRuleValue(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.answer === "string" && value.answer.trim()) {
    return value.answer.trim();
  }
  const parts = [];
  for (const [key, raw] of Object.entries(value)) {
    if (key === "answer" || key === "covered") continue;
    if (raw === null || raw === undefined || raw === "") continue;
    const label = key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    const rendered =
      typeof raw === "boolean"
        ? raw ? "yes" : "no"
        : Array.isArray(raw)
          ? raw.join(", ")
          : typeof raw === "object"
            ? JSON.stringify(raw)
            : String(raw);
    parts.push(/^(note|notes|detail|details)$/i.test(key) ? rendered : `${label}: ${rendered}`);
  }
  return parts.join(". ");
}

function renderStructuredAnswer(hit, code) {
  const status = String(hit.coverage_status || "unknown").replace("_", " ");
  const detail = describeRuleValue(hit.value);
  return detail ? `For CPT ${code}: ${status}. ${detail}` : `For CPT ${code}: ${status}.`;
}

/** The citation object the service builds for a structured_rule answer. */
function buildCitation(hit) {
  if (!hit.source_quote || !String(hit.source_quote).trim()) return null;
  return {
    documentName: hit.is_statewide ? "State Medicaid policy" : "Payer policy document",
    documentUrl: hit.source_url || null,
    effectiveDate: hit.effective_date || null,
    verbatimQuote: String(hit.source_quote).trim(),
    page: hit.source_page ?? null,
  };
}

// ---------------------------------------------------------------------------
// Defect detection on the RENDERED answer (not the raw row).
// ---------------------------------------------------------------------------
const STOCK_PHRASES = [
  "no confirmed rule found",
  "recommend calling the payer",
  "not specified",
  "no information",
  "see policy",
  "see payer policy",
  "refer to policy",
  "unknown",
  "tbd",
  "to be determined",
  "n/a",
];

/** Everything after the "For CPT X: <status>." prefix. Empty = bare status. */
function detailOf(answer) {
  const m = answer.match(/^For CPT \S+: [a-z ]+\.\s*(.*)$/s);
  return (m ? m[1] : answer).trim();
}

function inspectCell(cell) {
  const problems = [];
  const warnings = [];
  const detail = detailOf(cell.answer);

  if (!cell.answer || !cell.answer.trim()) {
    problems.push("EMPTY ANSWER — nothing would render in the panel");
  }
  if (!cell.citation) {
    problems.push("UNCITED — source_quote is null, the panel shows no citation");
  } else {
    if (cell.citation.verbatimQuote.length < MIN_QUOTE_CHARS) {
      warnings.push(
        `citation quote is only ${cell.citation.verbatimQuote.length} chars (< ${MIN_QUOTE_CHARS})`,
      );
    }
    if (!cell.citation.documentUrl) {
      warnings.push("citation has no source URL — biller cannot open the document");
    }
  }
  if (cell.confidence < MIN_SQL_CONFIDENCE) {
    problems.push(
      `CONFIDENCE ${cell.confidence.toFixed(2)} < ${MIN_SQL_CONFIDENCE.toFixed(2)} — ` +
        `the service DISCARDS this rule and falls through to RAG + Claude`,
    );
  }
  if (!cell.sourceDocResolved) {
    problems.push("SOURCE DOC MISSING — source_doc_id does not resolve to a source_document row");
  }
  if (cell.coverageStatus === "unknown") {
    if (cell.attribute === "covered") {
      // getAllowedCodesForPayer() drops `unknown` codes from the super-bill
      // picker by default, and scoreLine() adds a coverage_unknown risk
      // reason — so a `covered` rule that resolves to unknown answers nothing.
      problems.push(
        "COVERAGE UNKNOWN — the coverage attribute itself resolves to 'unknown': " +
          "the code is hidden from the super-bill picker and the denial scorer flags it as a risk",
      );
    } else {
      warnings.push(
        "coverage_status is 'unknown', so the panel headline reads " +
          '"For CPT <code>: unknown" even though the detail below it is specific',
      );
    }
  }

  const lowered = detail.toLowerCase();
  const stock = STOCK_PHRASES.find(
    (p) => lowered === p || lowered === `${p}.` || lowered.startsWith(`${p}.`) || lowered.startsWith(`${p} `),
  );
  if (stock) {
    problems.push(`STOCK PHRASE — answer says nothing beyond "${stock}"`);
  }

  if (!detail) {
    // A bare "For CPT 99349: covered." is legitimate for the `covered`
    // attribute (the status IS the answer) but useless for the other three,
    // which exist precisely to state a specific requirement.
    if (cell.attribute === "covered") {
      warnings.push("bare status only — no prose detail beyond the coverage status");
    } else {
      problems.push(
        `NO DETAIL — "${cell.attribute}" rendered as bare status with no requirement stated`,
      );
    }
  } else if (detail.length < MIN_ANSWER_CHARS && cell.attribute !== "covered") {
    warnings.push(`answer detail is only ${detail.length} chars (< ${MIN_ANSWER_CHARS})`);
  }

  return { problems, warnings };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const RULE = "=".repeat(78);
const THIN = "-".repeat(78);
const out = [];
const say = (s = "") => out.push(s);
const flush = () => { process.stdout.write(out.join("\n") + "\n"); out.length = 0; };

function clip(s, n) {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

const pad = (s, n) => String(s).padEnd(n);

// ---------------------------------------------------------------------------
// Checks ledger
// ---------------------------------------------------------------------------
const checks = [];
function check(name, ok, measured, detail) {
  checks.push({ name, ok: !!ok, measured: String(measured), detail: detail || null });
  return ok;
}

// ===========================================================================
// MAIN
// ===========================================================================
function main() {
  const startedAt = new Date();

  say(RULE);
  say("  PALLIO — LAYER 3: WHAT THE BILLER ACTUALLY SEES");
  say("  Live answer audit of the global payer_rule library");
  say(RULE);
  say(`  Run at            : ${startedAt.toISOString()}`);
  say(`  Database command  : ${PSQL_CMD.join(" ")}`);
  say("  Mode              : READ ONLY (default_transaction_read_only=on)");
  say("  Anthropic API     : NOT CALLED — this script contains no HTTP client");
  say(RULE);
  say();

  // -- 0. Connectivity + shape ---------------------------------------------
  const meta = psqlJson(`
    SELECT current_database() AS db,
           current_date::text AS dos,
           (SELECT count(*) FROM payer_rule WHERE expiration_date IS NULL) AS live_rules,
           (SELECT count(*) FROM payer) AS payers,
           (SELECT count(*) FROM source_document) AS docs
  `)[0];

  const dos = meta.dos;
  say("CONNECTION");
  say(`  database              : ${meta.db}`);
  say(`  date of service used  : ${dos}   (same DOS window fetchPayerRule() applies)`);
  say(`  live payer_rule rows  : ${Number(meta.live_rules).toLocaleString()}`);
  say(`  payers                : ${meta.payers}`);
  say(`  source documents      : ${Number(meta.docs).toLocaleString()}`);
  say();

  check("Database reachable and payer_rule has live rules", Number(meta.live_rules) > 0,
    `${meta.live_rules} live rules`);

  // -- 1. Payer x state universe -------------------------------------------
  // A pair qualifies when at least one live in-scope rule is reachable by the
  // real fetch predicate (own rule, or the statewide Medicaid fallback).
  const pairs = psqlJson(`
    SELECT p.id::text        AS payer_id,
           p.name            AS payer_name,
           p.payer_type      AS payer_type,
           s.state           AS state
    FROM payer p
    CROSS JOIN LATERAL unnest(coalesce(p.states_served, ARRAY[]::text[])) AS s(state)
    WHERE EXISTS (
      SELECT 1 FROM payer_rule pr
      WHERE pr.state = s.state
        AND pr.code IN (${sqlList(CODES)})
        AND pr.attribute IN (${sqlList(ATTRIBUTES)})
        AND pr.effective_date <= current_date
        AND (pr.expiration_date IS NULL OR pr.expiration_date > current_date)
        AND (
          pr.payer_id = p.id
          OR (pr.payer_id IS NULL
              AND p.payer_type IN ('medicaid_mco','medicaid_state','tribal'))
        )
    )
    ORDER BY p.name, s.state
  `);

  // Payers configured but carrying no in-scope rules at all — every lookup for
  // them falls straight through to RAG + Claude. Not a failure, but the client
  // must know the library does not answer for them.
  const barren = psqlJson(`
    SELECT p.name AS payer_name, p.payer_type,
           array_to_string(coalesce(p.states_served, ARRAY[]::text[]), ',') AS states
    FROM payer p
    WHERE NOT EXISTS (
      SELECT 1 FROM payer_rule pr
      WHERE pr.code IN (${sqlList(CODES)})
        AND pr.attribute IN (${sqlList(ATTRIBUTES)})
        AND pr.effective_date <= current_date
        AND (pr.expiration_date IS NULL OR pr.expiration_date > current_date)
        AND (
          pr.payer_id = p.id
          OR (pr.payer_id IS NULL
              AND p.payer_type IN ('medicaid_mco','medicaid_state','tribal'))
        )
    )
    ORDER BY p.name
  `);

  const totalCells = pairs.length * CODES.length * ATTRIBUTES.length;

  say("SCOPE EXERCISED");
  say(`  in-scope codes        : ${CODES.length}   (99343 excluded — retired from CPT)`);
  say(`  denial-scorer attrs   : ${ATTRIBUTES.join(", ")}`);
  say(`  payer × state pairs   : ${pairs.length}`);
  say(`  cells enumerated      : ${totalCells.toLocaleString()}   (codes × attrs × payer-states)`);
  say();

  check("At least one payer × state pair carries in-scope rules", pairs.length > 0,
    `${pairs.length} pairs`);

  // -- 2. Resolve every cell through the real fetch path --------------------
  // One LATERAL per cell, replicating fetchPayerRule() exactly: DOS window,
  // statewide Medicaid fallback, own-policy-first / product-line / newest
  // ordering, LIMIT 1.
  const pairValues = pairs
    .map((p) => `('${p.payer_id}'::uuid, '${p.payer_type}'::text, '${p.state}'::text)`)
    .join(",\n      ");

  const rows = psqlJson(`
    WITH pairs(payer_id, payer_type, state) AS (
      VALUES
      ${pairValues}
    ),
    codes(code) AS (SELECT unnest(ARRAY[${sqlList(CODES)}]::text[])),
    attrs(attribute) AS (SELECT unnest(ARRAY[${sqlList(ATTRIBUTES)}]::text[])),
    cells AS (
      SELECT pairs.payer_id, pairs.payer_type, pairs.state, codes.code, attrs.attribute
      FROM pairs CROSS JOIN codes CROSS JOIN attrs
    )
    SELECT
      c.payer_id::text  AS payer_id,
      c.state           AS state,
      c.code            AS code,
      c.attribute       AS attribute,
      h.rule_id, h.value, h.coverage_status,
      h.confidence, h.effective_date, h.source_quote, h.source_page,
      h.source_url, h.is_statewide, h.product_line, h.source_doc_resolved
    FROM cells c
    LEFT JOIN LATERAL (
      SELECT
        pr.id::text                 AS rule_id,
        pr.value                    AS value,
        pr.coverage_status          AS coverage_status,
        pr.confidence::float8       AS confidence,
        pr.effective_date::text     AS effective_date,
        pr.source_quote             AS source_quote,
        pr.source_page              AS source_page,
        pr.product_line             AS product_line,
        sd.url                      AS source_url,
        (pr.payer_id IS NULL)       AS is_statewide,
        (sd.id IS NOT NULL)         AS source_doc_resolved
      FROM payer_rule pr
      LEFT JOIN source_document sd ON sd.id = pr.source_doc_id
      WHERE pr.state     = c.state
        AND pr.code      = c.code
        AND pr.attribute = c.attribute
        AND pr.effective_date <= current_date
        AND (pr.expiration_date IS NULL OR pr.expiration_date > current_date)
        AND (
          pr.payer_id = c.payer_id
          OR (pr.payer_id IS NULL
              AND c.payer_type IN ('medicaid_mco','medicaid_state','tribal'))
        )
      ORDER BY
        (pr.payer_id IS NOT NULL) DESC,
        (pr.product_line = '${DEFAULT_PRODUCT_LINE}') DESC,
        pr.effective_date DESC
      LIMIT 1
    ) h ON TRUE
    ORDER BY c.state, c.payer_id, c.code, c.attribute
  `);

  // -- 3. Render + inspect ---------------------------------------------------
  const pairKey = (p) => `${p.payer_id}|${p.state}`;
  const byPair = new Map(pairs.map((p) => [pairKey(p), { ...p, cells: [], empty: [] }]));

  const failures = [];
  const warnList = [];
  const emptyCells = [];
  let answered = 0;

  for (const r of rows) {
    const bucket = byPair.get(`${r.payer_id}|${r.state}`);
    if (!bucket) continue;
    if (!r.rule_id) {
      bucket.empty.push(r);
      emptyCells.push(r);
      continue;
    }
    answered += 1;
    const cell = {
      code: r.code,
      attribute: r.attribute,
      coverageStatus: r.coverage_status,
      confidence: Number(r.confidence),
      answer: renderStructuredAnswer(r, r.code),
      citation: buildCitation(r),
      productLine: r.product_line,
      isStatewide: r.is_statewide,
      sourceDocResolved: r.source_doc_resolved === true,
      ruleId: r.rule_id,
      effectiveDate: r.effective_date,
    };
    const { problems, warnings } = inspectCell(cell);
    cell.problems = problems;
    cell.warnings = warnings;
    bucket.cells.push(cell);
    const where = `${bucket.payer_name} / ${r.state} / ${r.code} / ${r.attribute}`;
    for (const p of problems) failures.push({ where, what: p, cell, pair: bucket });
    for (const w of warnings) warnList.push({ where, what: w });
  }

  say("CELL RESOLUTION");
  say(`  cells WITH a live rule : ${answered.toLocaleString()}  ← rendered below, every one checked`);
  say(`  cells with NO rule     : ${emptyCells.length.toLocaleString()}  ← NOT exercised (would call Claude)`);
  say();

  check("Every payer × state pair returns at least one live answer",
    [...byPair.values()].every((b) => b.cells.length > 0),
    `${[...byPair.values()].filter((b) => b.cells.length > 0).length}/${pairs.length} pairs answered`,
    [...byPair.values()].filter((b) => b.cells.length === 0)
      .map((b) => `${b.payer_name} / ${b.state}`).join("; "));

  // -- 4. The report ---------------------------------------------------------
  if (!BRIEF) {
    say(RULE);
    say("  PER-PAYER ANSWERS  —  read these. This is the panel text.");
    say(`  ANSWER clipped to ${ANSWER_CHARS} chars, CITE clipped to ${CITE_CHARS}.`);
    say(RULE);
  } else {
    say("(--brief: per-payer answers suppressed; defects and checks follow)");
    say();
  }

  const sortedPairs = [...byPair.values()].sort(
    (a, b) => a.payer_name.localeCompare(b.payer_name) || a.state.localeCompare(b.state),
  );

  for (const p of sortedPairs) {
    const cellsHere = p.cells.length;
    const totalHere = CODES.length * ATTRIBUTES.length;
    const badHere = p.cells.filter((c) => c.problems.length > 0).length;

    if (!BRIEF) {
      say();
      say(THIN);
      say(`PAYER: ${p.payer_name}  [${p.payer_type}]   state ${p.state}`);
      say(`  live answers ${cellsHere}/${totalHere} cells   ·   flagged ${badHere}`);
      say(THIN);
    }

    const visible = BRIEF
      ? p.cells.filter((c) => c.problems.length > 0 || c.warnings.length > 0)
      : p.cells;
    if (BRIEF && visible.length > 0) {
      say();
      say(`PAYER: ${p.payer_name}  [${p.payer_type}]   state ${p.state}` +
          `   ·   ${visible.length} flagged of ${cellsHere} live answers`);
    }

    let lastCode = null;
    for (const c of visible) {
      if (c.code !== lastCode) {
        if (!BRIEF) say();
        say(`  ${c.code}`);
        lastCode = c.code;
      }
      const flag = c.problems.length ? "FAIL" : c.warnings.length ? "warn" : "ok  ";
      say(
        `    ${flag} ${pad(c.attribute, 20)} ${pad(`[${c.coverageStatus}]`, 14)}` +
          ` conf ${c.confidence.toFixed(2)}${c.isStatewide ? "  (statewide policy)" : ""}`,
      );
      say(`         ANSWER  ${clip(c.answer, ANSWER_CHARS)}`);
      if (c.citation) {
        say(`         CITE    “${clip(c.citation.verbatimQuote, CITE_CHARS)}”`);
        say(
          `                 ${c.citation.documentName}` +
            `${c.citation.effectiveDate ? ` · eff ${c.citation.effectiveDate}` : ""}` +
            `${c.citation.page ? ` · p.${c.citation.page}` : ""}`,
        );
        if (c.citation.documentUrl) say(`                 ${clip(c.citation.documentUrl, 100)}`);
      } else {
        say("         CITE    (none — the panel would show this answer uncited)");
      }
      for (const pr of c.problems) say(`         !! ${pr}`);
      for (const w of c.warnings) say(`         ~  ${w}`);
    }

    if (!BRIEF && p.empty.length > 0) {
      const missCodes = [...new Set(p.empty.map((e) => `${e.code}/${e.attribute}`))];
      say();
      say(`  no rule on file (${p.empty.length} cells) — these fall through to RAG + Claude:`);
      say(`    ${clip(missCodes.join(", "), 900)}`);
    }
  }

  // -- 5. Empty-cell sample --------------------------------------------------
  say();
  say(RULE);
  say("  EMPTY-CELL SAMPLE (named, NOT resolved — resolving these costs API calls)");
  say(RULE);
  if (emptyCells.length === 0) {
    say("  none — every enumerated cell has a live rule.");
  } else {
    const step = Math.max(1, Math.floor(emptyCells.length / EMPTY_CELL_SAMPLE));
    for (let i = 0, n = 0; i < emptyCells.length && n < EMPTY_CELL_SAMPLE; i += step, n += 1) {
      const e = emptyCells[i];
      const b = byPair.get(`${e.payer_id}|${e.state}`);
      say(`  ${pad(b ? b.payer_name : e.payer_id, 42)} ${e.state}  ${pad(e.code, 7)} ${e.attribute}`);
    }
    say(`  … and ${Math.max(0, emptyCells.length - EMPTY_CELL_SAMPLE)} more.`);
    say("  For each of these lookupRule() would fall through to retrieval +");
    say("  Claude synthesis. This script did not do that, by design.");
  }

  // -- 6. Structural checks that back the report up --------------------------
  const dupes = psqlJson(`
    SELECT payer_id::text AS payer_id, state, code, attribute, count(*)::int AS n
    FROM payer_rule
    WHERE expiration_date IS NULL
      AND code IN (${sqlList(CODES)})
      AND attribute IN (${sqlList(ATTRIBUTES)})
    GROUP BY 1,2,3,4
    HAVING count(*) > 1
    ORDER BY n DESC
    LIMIT 20
  `);

  const retired = psqlJson(`
    SELECT pr.code AS code,
           coalesce(p.name, '(statewide policy)') AS payer_name,
           pr.state AS state,
           count(*)::int AS n
    FROM payer_rule pr
    LEFT JOIN payer p ON p.id = pr.payer_id
    WHERE pr.expiration_date IS NULL AND pr.code IN (${sqlList(RETIRED_CODES)})
    GROUP BY 1,2,3
    ORDER BY 1,2,3
  `);

  const codesSeen = new Set(rows.filter((r) => r.rule_id).map((r) => r.code));
  const codesMissing = CODES.filter((c) => !codesSeen.has(c));

  const attrsSeen = new Set(rows.filter((r) => r.rule_id).map((r) => r.attribute));
  const attrsMissing = ATTRIBUTES.filter((a) => !attrsSeen.has(a));

  const count = (pred) => failures.filter((f) => f.what.startsWith(pred)).length;

  check("No duplicate live rule per (payer, state, code, attribute) — fetchPayerRule ends in LIMIT 1 with no tiebreak, so a duplicate makes the answer nondeterministic",
    dupes.length === 0, `${dupes.length} duplicated cells`,
    dupes.map((d) => `${d.state}/${d.code}/${d.attribute} ×${d.n}`).join("; "));

  check(`Retired code(s) ${RETIRED_CODES.join(", ")} have no live rules — a deleted CPT code that still answers will be billed and denied`,
    retired.length === 0, `${retired.reduce((s, r) => s + r.n, 0)} live rules on retired codes`,
    retired.map((r) => `${r.code}: ${r.payer_name} / ${r.state} ×${r.n}`).join("; "));

  check("Every in-scope code answers for at least one payer",
    codesMissing.length === 0, `${CODES.length - codesMissing.length}/${CODES.length} codes answer`,
    codesMissing.join(", "));

  check("All four denial-scorer attributes answer somewhere",
    attrsMissing.length === 0, `${ATTRIBUTES.length - attrsMissing.length}/${ATTRIBUTES.length} attributes answer`,
    attrsMissing.join(", "));

  check("Every rendered answer is non-empty",
    count("EMPTY ANSWER") === 0, `${answered - count("EMPTY ANSWER")}/${answered} non-empty`);

  check("Every rendered answer carries a verbatim citation",
    count("UNCITED") === 0, `${answered - count("UNCITED")}/${answered} cited`);

  check(`Every rendered answer is at or above the ${MIN_SQL_CONFIDENCE.toFixed(2)} confidence floor (below it the service discards the rule and calls Claude)`,
    count("CONFIDENCE") === 0, `${answered - count("CONFIDENCE")}/${answered} servable`);

  check("Every citation resolves to a real source_document row",
    count("SOURCE DOC MISSING") === 0, `${answered - count("SOURCE DOC MISSING")}/${answered} resolved`);

  check("No answer is a stock/placeholder phrase",
    count("STOCK PHRASE") === 0, `${answered - count("STOCK PHRASE")}/${answered} substantive`);

  check("Every prior_auth / modifier / frequency answer states an actual requirement (not bare status)",
    count("NO DETAIL") === 0, `${answered - count("NO DETAIL")}/${answered} specific`);

  const coveredCells = answered
    ? rows.filter((r) => r.rule_id && r.attribute === "covered").length
    : 0;
  check("Every `covered` answer resolves to a real coverage status, not 'unknown'",
    count("COVERAGE UNKNOWN") === 0,
    `${coveredCells - count("COVERAGE UNKNOWN")}/${coveredCells} covered-attribute answers decisive`);

  // -- 7. Verdict ------------------------------------------------------------
  const failed = checks.filter((c) => !c.ok);

  say();
  say(RULE);
  say("  CHECKS");
  say(RULE);
  for (const c of checks) {
    say(`  [${c.ok ? "PASS" : "FAIL"}]  ${c.measured}`);
    say(`          ${c.name}`);
    if (!c.ok && c.detail) say(`          → ${clip(c.detail, 400)}`);
  }

  say();
  say(RULE);
  say("  ADVISORIES (not failures)");
  say(RULE);
  if (barren.length === 0) {
    say("  none — every configured payer answers for at least one in-scope cell.");
  } else {
    say(`  ${barren.length} configured payer(s) carry NO in-scope rules at all. Every`);
    say("  lookup against them falls through to RAG + Claude:");
    for (const b of barren) say(`    · ${b.payer_name} [${b.payer_type}] ${b.states}`);
  }
  if (warnList.length > 0) {
    say();
    say(`  ${warnList.length} soft warning(s) on rendered answers:`);
    const grouped = new Map();
    for (const w of warnList) {
      const k = w.what.replace(/\d+/g, "N");
      grouped.set(k, (grouped.get(k) || 0) + 1);
    }
    for (const [k, n] of [...grouped].sort((a, b) => b[1] - a[1])) {
      say(`    · ${n.toString().padStart(4)}  ${k}`);
    }
    say("  (each is printed inline above, marked ~)");
  }

  say();
  say(RULE);
  if (failed.length === 0) {
    say(`  RESULT: PASS — all ${checks.length} checks green across ${answered.toLocaleString()} live answers.`);
    say(RULE);
    flush();
    return 0;
  }

  say(`  RESULT: FAIL — ${failed.length} of ${checks.length} checks failed.`);
  say(RULE);
  for (const c of failed) {
    say();
    say(`  FAILED: ${c.name}`);
    say(`    measured: ${c.measured}`);
    if (c.detail) say(`    details : ${clip(c.detail, 600)}`);
  }

  if (failures.length > 0) {
    say();
    say("  Offending cells (payer / state / code / attribute):");
    const shown = failures.slice(0, 60);
    for (const f of shown) {
      say(`    · ${f.where}`);
      say(`        ${f.what}`);
      say(`        rule_id ${f.cell.ruleId}`);
    }
    if (failures.length > shown.length) {
      say(`    … and ${failures.length - shown.length} more flagged cells (see report above).`);
    }
  }

  say();
  say(RULE);
  say("  Send this whole output back to the engineering team.");
  say(RULE);
  flush();
  return 1;
}

try {
  process.exitCode = main();
} catch (err) {
  flush();
  process.stdout.write(
    `\n${RULE}\n  RESULT: FAIL — the audit could not run.\n  ${err.message}\n${RULE}\n`,
  );
  process.exitCode = 1;
}
