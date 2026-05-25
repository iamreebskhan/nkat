# Master plan — EMR pivot after Mark / Areeba call (2026-05-22)

> Source: 42-min Zoom transcript, May 22 2026. Mark walked through a
> typical palliative-care EMR (schedule, caseload, super-bill) and
> articulated the gap: **no EMR shows the nurse practitioner which CPT
> codes their patient's payer actually accepts at the point of billing,
> and none predicts denials before submission.** Mark's framing:
> "you may have to redesign a whole EMR around this concept of billing."

This plan covers the seven changes A–G in priority order and is sized
in vertical slices so each phase ships independently green.

---

## Phase 0 — Foundation (one-time, blocks A & B)

**Goal:** the data model can answer "for this patient, which CPTs does
their payer pay?" in O(1) before we touch any UI.

### 0.1 Patient ↔ payer is a hard FK (not a free-text field)

- Audit `patient_insurance` schema. If `payer` is stored as text, add a
  nullable `payer_id UUID REFERENCES payer(id)` column with a backfill
  trigger that resolves on insert/update.
- Update `POST /api/patients` and `PATCH /api/patients/[id]` to require
  `primaryPayerId` when provided (zod enum from `/api/billing/payers`).
- Migration: `0041_phase_pallio_patient_primary_payer.sql`.
- Tests: cross-org RLS still isolates patient rows; payer_id NULL is
  legal (some patients are cash-pay).

### 0.2 "Allowed codes for this payer/state/DOS" view

A SQL view + service helper that returns the list of CPTs a payer
covers for a given state on a given date, with each row carrying:
`code, description, coverage_status, confidence, sourceKind,
priorAuthRequired, modifierRequired, frequencyLimit, lastVerifiedAt`.

- New view: `payer_allowed_codes_v` (joins `payer_rule` + `cpt_code`
  metadata, filters `coverage_status IN ('covered','conditional')` and
  effective-date window).
- New service: `lib/features/billing/payer-allowed-codes.service.ts`.
- New route: `GET /api/billing/allowed-codes?payerId&state&dos`.
- Cache: 60s in-process (these answers move daily not minutely).
- Tests: hits all 5 provenance sources (cms / crawler / analyst / ai /
  manual), respects expiration dates.

### 0.3 Denial-risk score primitive

Pure function that takes a draft super-bill line and returns
`{ score: 0..1, riskBand: 'low'|'medium'|'high'|'block',
reasons: string[] }`. Score combines:
- coverage_status of (payer, state, code) → block if `denied`
- confidence floor → high risk if < 0.5
- modifier_required and no modifier on line → medium
- prior_auth_required and no PA flag on patient → high
- frequency_limit hit within window (lookup recent superbills) → high
- diagnosis-code compatibility (later phase; stub now)

- New service: `lib/features/billing/denial-risk.service.ts`.
- Unit tests: 30+ fixtures covering each branch.
- No UI yet — wired in Phase B.

---

## Phase A — Payer-scoped CPT picker on the super-bill (HIGH)

**The single change Mark cared about most.** When the nurse opens the
super-bill for a patient, the CPT dropdown shows ONLY codes that the
patient's primary payer accepts in the patient's state on the date of
service, sorted by frequency-of-use for that provider.

### A.1 Server

- Extend `POST /api/visits/[id]/superbill/draft` to pre-fetch the
  allowed-codes view and return it alongside the draft.
- New endpoint `GET /api/visits/[id]/code-picker` for autocomplete
  refinements (text search inside the allowed set).

### A.2 UI — `app/(platform)/visits/[id]/superbill/page.tsx`

- Replace the existing "type any CPT" input with a virtualized combobox
  populated from `/code-picker`.
- Each option chip shows: code · short descriptor · coverage badge
  (green covered, amber conditional, slate unknown, red denied — but
  denied codes hidden by default; expand "show all" to bypass).
- Hover/click reveals: full descriptor, sourceKind, last verified date,
  confidence, modifier hint, PA hint.
- "Override" affordance — nurse can still type any CPT, but the row is
  marked `override=true` with a confirmation modal explaining why this
  code wasn't in the allow-list. (Compliance: don't *prevent* clinical
  judgement, but record the override for audit.)
- Empty state: if `allowed-codes` returns zero (new payer with no
  rules yet), surface a one-click "request analyst attestation" CTA
  that calls `POST /api/attestations/requests`.

### A.3 Tests

- Playwright: nurse opens superbill for an Aetna OH patient, only sees
  Aetna OH codes; switches patient to a Medicare patient, sees the
  Medicare list. Cross-payer isolation.
- Probe: extend `probe-all-scenarios.mjs` with a payer-filtered
  super-bill flow assertion.

---

## Phase B — Pre-submission denial predictor (HIGH)

The differentiator. Before the nurse hits Save & Finalize, show a
banner: "This super-bill has 2 high-risk lines and 1 likely denial."
Each line in the table gets an inline risk badge + tooltip explaining
why.

### B.1 Server

- New endpoint `POST /api/superbills/predict` accepts the draft
  payload, runs `denial-risk.service` per line, returns the scored
  result without persisting anything.
- Persist (`POST /api/superbills`) also runs the predictor and stores
  the result in `superbill.predicted_risk` JSON column for later
  comparison against actual denials (feedback loop).
- Migration: `0042_phase_pallio_superbill_predicted_risk.sql`.

### B.2 UI

- Inline badges on each line in the superbill draft view (re-runs
  predictor on every change with 300ms debounce).
- "Why?" popover lists the exact rule(s) that triggered the risk and
  cites the `source_document` so the nurse can read the source.
- Pre-submit summary modal: "X high-risk, Y medium, Z low. Proceed?".
- "Predicted vs. actual" widget on `/billing/denials` — once a denial
  comes back, we surface whether we predicted it. Long-run accuracy
  metric drives Mark's trust in the system.

### B.3 Feedback loop (closes the learning gap)

- Cron `nightly-denial-feedback.mjs` joins `superbill.predicted_risk`
  with `superbill_denial.outcome`, writes precision/recall per rule
  into `denial_rule_metrics`. Rules with consistent false-positive
  ratio get downweighted automatically.

### B.4 Tests

- Unit: 30+ predictor fixtures.
- Integration: log a denial → next-day predictor accuracy report
  surfaces the rule that mispredicted.
- Probe: end-to-end predict → finalize → denial logged → metrics row.

---

## Phase C — Nurse-friendly super-bill edit (HIGH)

Mark: "Editing and submitting those super bills is what's really
critical and really difficult for nurse practitioners because they're
clinical, not billing-oriented."

### C.1 UX redesign of the superbill page

- Two-pane: left = visit context (chief complaint, time spent,
  diagnoses); right = super-bill lines with payer-scoped picker.
- "Smart suggestions" panel — based on the documented visit duration
  + diagnoses, propose the most-likely-correct CPT (with all the
  Phase-A and Phase-B context already baked in).
- Diagnosis-code (ICD-10) picker uses the same allowed-codes pattern:
  filtered to ones that pair with the chosen CPT under the payer's
  rules (this requires us to feed ICD-CPT pairing data — defer the
  hard work; v1 = autocomplete from a static ICD-10 table).
- Time-spent slider (Mark explicitly mentioned 40-minute thresholds for
  some codes) — when the nurse moves it past a threshold, the picker
  updates the suggested code (e.g. 99348 → 99349 at the right minute
  bracket).

### C.2 Drafts auto-save every 5 s. No data loss.

### C.3 "Why this code?" + "Why not that code?" explainers.

---

## Phase D — Caseload acuity column + sort (MED)

Mark: "A nurse is monitoring this patient's by acuity, by case, they
can tell when the last visit was, they can tell when the next visit
is."

### D.1 Add `acuity` to `patient`

- Enum: `low`, `medium`, `high`, `critical` (Mark to confirm exact set
  — palliative care typically uses PPS or hospice scales). Stub with
  these four; rename later.
- Migration `0043_phase_pallio_patient_acuity.sql`.
- API: `PATCH /api/patients/[id]` accepts `acuity`.

### D.2 `/patients` list

- Sortable acuity column (color-coded chip).
- Last-visit and next-visit columns (we have the data; just surface).
- Default sort: critical → low.

---

## Phase E — Schedule weekly view + provider color (MED)

Mark walked the calendar live; ours is thin.

### E.1 Calendar enhancements

- Switch from current month grid to a week-view default with
  drag-to-reschedule.
- Each visit chip colored by provider (deterministic hash of provider
  id → palette).
- Hover shows: patient name, town, visit type, planned duration.
- "PTO" first-class on the schedule (separate row at top per provider).
- Print view for the day's route — palliative care nurses drive
  between homes; a printable route sheet is non-obvious-but-valuable.

### E.2 Capacity guard

- Warn when scheduling more than N visits in a day for one provider
  (config in `org_settings`).

---

## Phase F — Patient-scoped messaging (MED)

Mark: "These are all the messages that they've had back and forth with
one another through the messaging system."

### F.1 Data model

- `patient_thread (id, org_id, patient_id, created_by, created_at)`
- `patient_message (id, thread_id, author_user_id, body, attachments,
  read_by user_id[], created_at)`
- RLS: same org_id pattern.

### F.2 UI

- Inline thread panel on patient chart; @mention triggers in-app
  notification (existing `notification` table).
- No external email/SMS in v1 — strictly inside the platform.
- Edit window: 5 minutes; after that, append-only.

### F.3 Compliance

- PHI guard: thread content is PHI; existing `audit_log` covers reads.
- Export tool for legal/HIPAA disclosure requests (operator-only).

---

## Phase G — Cheat-sheet breadth (PARALLEL — data-driven, not code)

This phase is driven by feeders, not engineering scope. Once Mark
sends AAPC seat / Avality access:

- Operator adds Availity per-payer policy pages as `ingestion_source`
  rows (one per payer × state combo we care about).
- Cron runs nightly, the extractor fills `payer_rule`.
- Cheat-sheet PDF generator (already built) automatically produces a
  new cheat sheet per payer × state combination once `payer_rule` has
  ≥ N covered codes for that pair.
- Analyst attestation queue fills with the "AI-synthesized" low-conf
  rules → as analysts confirm, confidence climbs across all orgs.

No code work for G beyond making sure the existing engine handles
Availity's HTML format. If Availity returns JSON via API (Mark to
confirm), we add a JSON parser branch in the document-ingestion
service.

---

## Cross-cutting concerns

### Permissions

Add to `lib/permissions.ts`:

- `messaging.send`, `messaging.read` (Phase F)
- `superbill.predict` (everyone with `billing.lookup.view` gets it; the
  cost is on us)
- `patient.acuity.edit` (clinician + org_admin)

### Audit

Every override on the super-bill picker → `audit_log` entry with the
declined-vs-chosen code pair. This is the data we need to demonstrate
clinical judgement + show patterns when training new nurses.

### Telemetry

`predicted_risk` vs. `actual_denial` joins are the single most
important metric for product credibility. Build a small Grafana
dashboard pointing at the metrics table once Phase B ships.

### Performance

- `payer_allowed_codes_v` is queried per super-bill open; index on
  `(payer_id, state, effective_date, expiration_date)` in payer_rule.
- Predictor is < 50 ms per line on average; benchmark in CI.

---

## Sequencing & rough effort

| Phase | Engineering days | User-visible? | Ship gate |
|---|---|---|---|
| 0 (foundation) | 3 | no | view + service + tests green |
| A (picker) | 5 | yes | Playwright + probe green; demo to Mark |
| B (predictor) | 6 | yes | feedback loop seeded; metrics dashboard live |
| C (edit UX) | 5 | yes | usability test with 1 nurse (Mark introduces) |
| D (acuity) | 2 | yes | column sortable; migration applied |
| E (schedule) | 4 | yes | week view + color coding + print route |
| F (messaging) | 6 | yes | thread on patient chart; @mention notification |
| G (cheat-sheet breadth) | ongoing | yes | per-payer cheat sheets auto-generate |

**Total: ~31 engineering days.** Phases 0 → A → B is the demo path
back to Mark (~14 days). C–F are sequenced after that based on his
feedback.

---

## Open questions for Mark / Areeba

1. **Acuity scale** — exact enum values? Palliative-care orgs vary.
2. **Override threshold** — should we *prevent* (hard block) a denied
   code, or always allow override with audit? (Strong recommendation:
   always allow; nurses know edge cases.)
3. **Messaging scope** — provider ↔ provider only, or also patient
   (telehealth chat)? Big PHI implications either way.
4. **Time-spent capture** — does the nurse type the minutes manually,
   or does the system auto-time from visit start/end? (Auto would be
   nicer; manual is what they're used to.)
5. **Calendar source of truth** — current `/schedule` route already
   drives visits; does Mark want Google Calendar sync too?
6. **Avality API vs. HTML** — Mark to confirm once his account
   reactivates whether they expose a structured API or it's screen
   scrape.
7. **Per-payer cheat-sheet PDFs** — does Mark want a manual "approve
   before publish" gate, or auto-publish once confidence ≥ 0.6?

## Out of scope (deliberate, for now)

- Direct clearinghouse submission (Change Healthcare / Availity EDI).
  Still pending until Mark wants to go full revenue-cycle.
- e-Prescribing / labs — those are EMR features but not the
  differentiator he asked for.
- Patient portal — Mark didn't bring it up; explicitly defer.
- Mobile app — `/schedule` mobile-responsive is enough for v1; native
  app is a separate program.
