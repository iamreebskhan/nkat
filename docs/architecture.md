# Pallio architecture

Living document. Update when topology, framework choice, or data
ownership changes.

## Stack at a glance

| Layer | Choice | Why |
|---|---|---|
| App framework | Next.js 16 App Router | SSR + RSC + colocated API routes. Single deploy unit. |
| Lang | TypeScript strict | Catch shape drift between EMR + billing halves at compile time. |
| ORM | Prisma | Generated client + readable migrations. RLS via `withOrgContext` wrapper. |
| Database | Postgres 16 + pgvector | Native RLS + JSONB + native vector search. **Deviation from vision**: vision §10.2 specifies MariaDB. We chose Postgres because pgvector + RLS are native and the original prototype was already on PG. Document this with Mark on next call. |
| AI | Anthropic Claude (haiku-4-5 + sonnet-4-6) | Citation-grounded synthesis with refusal. Bedrock dropped per vision pivot. |
| Embeddings | OpenAI text-embedding-3-large @ 1024 dims | Best retrieval-quality cost ratio at the time of choice. |
| UI | shadcn/ui + Tailwind v4 | Slate/teal design system per playbook §2.2. |
| Editor | TipTap | Visit + care plan rich text. |
| PDF | Puppeteer | Cheat sheet, superbill, rule-answer exports. |
| Auth | jose JWT in HttpOnly cookie | Vision §18.3. No NextAuth — simpler surface. |
| Email | Resend | Transactional. |
| Payments | Stripe | Subscription + BAA add-on. |

## Multi-tenancy

Every tenant-scoped query path goes through `withOrgContext(orgId, fn)`
in `lib/db.ts`. That wrapper opens a Prisma transaction and runs `SET
LOCAL app.current_org_id = '<orgId>'` so RLS policies fire correctly.

The `withBreakglass` escape hatch (also in `lib/db.ts`) bypasses RLS
for cross-tenant operations (Mark's platform admin view). Every
breakglass call requires a non-empty `reason` string and is
audit-logged.

`scripts/rls-audit.ts` enumerates every tenant table and asserts RLS
+ at least one policy is attached. Runs in CI + pre-deploy.

## Hallucination floor

The rule synthesizer (`lib/ai/anthropic.client.ts → synthesizeRuleAnswer`)
**must** return a parsable citation (source document + verbatim quote +
effective date) or the caller treats the answer as `NO_RULE_FOUND`.

The denial analyst (`lib/ai/denial-analyst.ts`) layers two more guards:

1. Recommendation must be one of a fixed enum — anything else is
   downgraded to "human review".
2. If a payer rule was provided in the prompt, the model **must** quote
   it back. Missing citation → fall back to the heuristic.

Gold-standard eval (`lib/ai/__tests__/gold-standard.spec.ts`, currently
skipped pending dataset) is the regression line — every prompt change
re-runs it and fails CI <95%.

## PHI boundary

Vision §15.4: no PHI to Anthropic (no BAA). Enforced two ways:

1. **Call-site contract** — only structured fields (payer, state, CPT,
   attribute) flow into Claude prompts. No patient row, no visit note,
   no superbill detail.
2. **Pre-send guard** — `lib/ai/phi-guard.ts → assertNoPhi(payload, ctx)`
   regex-scans every prompt for safe-harbor identifiers. Throws on hit.
   The throw is loud + audited; we don't silently scrub.

Every patient/visit read writes a `phi_access_log` row via
`lib/hipaa/phi-access-log.ts → logPhiAccess`. Retention 6 years per
HIPAA Security Rule §164.316(b)(2)(i). Trigger
`prevent_premature_audit_delete()` refuses DELETE/UPDATE on rows
younger than 6 years from the app role.

## Open vision deviations to flag with Mark

1. **Postgres, not MariaDB** — see table above.
2. **Hostinger VPS chosen over Cloudflare Pages** — vision §12 left
   this as VPS-or-Pages; Pages doesn't run Next SSR cleanly.
3. **Auth is custom jose+cookie, not NextAuth** — vision §18.3 implied
   custom; we picked the simpler surface.
4. **Embeddings dimension 1024 (not the model default 3072)** — we
   downsize to 1024 per OpenAI's slicing guidance to keep pgvector
   index size manageable on Neon Free.

## Where to look next

- `db/migrations/0029_phase_pallio_emr.sql` — patient/visit/care_plan/superbill core.
- `db/migrations/0031_phase_pallio_onboarding_rulebook.sql` — Path A/B rulebook.
- `db/migrations/0032_phase_pallio_attestations_branding.sql` — analyst + branding.
- `db/migrations/0033_phase_pallio_hipaa_gates.sql` — PHI access log + retention.
- `lib/features/billing/rule-lookup.service.ts` — the SQL-first → vector → Claude flow.
- `lib/manifests.ts` — sidebar items per role.
