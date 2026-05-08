# Launch-Readiness Gates

The single source of truth for "are we cleared to send our first prod
email and onboard our first paying tenant?" Each gate is binary; ALL
must be green before a `prod` cutover proceeds.

The gates exist in two stacks: **infrastructure** (technical readiness)
and **commercial** (legal + customer readiness). Both stacks must clear.

---

## Infrastructure stack

### A1. Stage SES smoke green

- [ ] `npm run ses:simulator -- --from no-reply@stage.example.com` exits 0.
- [ ] `email_suppression` shows the bounce + complaint rows within 90s.
- [ ] No PHI patterns leaked through `email_send.subject` (visual scan of last 100 stage rows).

### A2. Stage Stripe smoke green

- [ ] `POST /v1/billing/stripe-webhook` (synthetic event signed with stage `STRIPE_WEBHOOK_SIGNING_SECRET`) returns 200.
- [ ] `billing_event` row written, idempotent on replay (second post returns 200, no new row).
- [ ] `customer.subscription.created` event triggers welcome email (`email_send.template='welcome'` row appears with `status='sent'`).

### A3. Stage cutover dress rehearsal pass

- [ ] `cutover-dress-rehearsal-results.md` template filled in for the most recent rehearsal.
- [ ] All P1 tickets resolved.
- [ ] CTO/CEO/Compliance sign-offs captured.

### A4. CI / OpenAPI gates green

- [ ] `npx jest --ci` (backend + extension + Lambda scrubber) all green.
- [ ] `npx ts-node scripts/export-openapi.ts` produces a clean diff.
- [ ] `npm run stage:health -- --base-url https://stage --org-id <synthetic>` exits 0.

### A5. Production infra parity

- [ ] All migrations in `db/migrations/*.sql` applied to prod RDS.
- [ ] All seeds applied.
- [ ] RLS posture confirmed via the `break-glass.md` query — zero rows from the tenant-table scan.
- [ ] Datadog forwarder Lambda healthy + logs flowing.
- [ ] All EventBridge schedules in scheduled-tasks.tf show `state=ENABLED` for prod.

### A6. Backups verified by restore

- [ ] Most recent daily `pg_dump` restored to staging in the last 30 days.
- [ ] Restored DB passes the schema-shape integration suite.

### A7. Pen test + SOC 2

- [ ] External pen test report on file; no high/critical findings open.
- [ ] SOC 2 Type 1 report issued.
- [ ] Vanta evidence collection running for Type 2.

---

## Commercial stack

### B1. Sub-processor BAAs

- [ ] AWS HIPAA BAA executed.
- [ ] Bedrock + SES + Comprehend Medical (per AWS BAA scope).
- [ ] Datadog HIPAA BAA executed.
- [ ] Stripe BAA NOT REQUIRED (does not process PHI), but Stripe DPA executed.
- [ ] Vanta DPA executed (no PHI).

### B2. Customer agreements

- [ ] First design-partner MSA executed.
- [ ] First design-partner BAA executed.
- [ ] First design-partner DPA executed.
- [ ] First design-partner Order Form signed with the agreed tier + seats + states + specialty packs.

### B3. Insurance bound

- [ ] Cyber liability policy effective (≥ $5M/$5M).
- [ ] E&O policy effective (≥ $5M/$5M).
- [ ] General liability effective.
- [ ] Certificates filed.

### B4. AMA + CMS licenses

- [ ] AMA CPT license active; license token in prod Secrets Manager.
- [ ] CMS Coverage API token issued; in prod Secrets Manager.

### B5. State privacy notice surfaces

- [ ] Privacy Center page live at `https://<domain>/privacy`.
- [ ] Washington MHMDA notice + consent UI live for WA-resident users.
- [ ] Colorado AI Act customer-side notice template provided to design partners.

### B6. Counsel sign-off

- [ ] Healthcare regulatory counsel reviewed the launch package.
- [ ] FDA CDS §3060 exemption memo on file.
- [ ] AKS/Stark/FCA review of the Order Form clean.

---

## Authority + clock

The CTO chairs the launch-readiness review. Two-thirds approval (CTO + CEO + Compliance Lead) is required to flip any gate from red to green.

Cutover schedule is set by the CTO **only after every gate is green**.

If a gate flips back to red after the cutover is scheduled (e.g., a P1 surfaces in stage post-rehearsal), the cutover is **paused, not slipped**. Resumption requires the same 2/3 approval.

---

## What "first prod cutover" means

- The first paying tenant's org row exists with `subscription.status = 'active'`.
- Their admin has redeemed their invite + completed first login.
- They've run their first lookup against a real payer × state combo.
- They're receiving the trial-ending / welcome email from `prod` SES (List-Unsubscribe header verified by inspecting the rendered message in their inbox).
- A status-page incident "Service launched" is posted (informational; no impact).

The post-cutover monitoring window is **2 hours**. On-call primary + secondary watch dashboards. Any anomaly triggers the rollback decision tree in `production-cutover.md`.

---

## After cutover (T+1 to T+30)

See `post-launch-playbook.md` for the day-by-day cadence — health-check spam isn't useful, but **the first 30 days do have a defined cadence** the CSM + on-call follow.
