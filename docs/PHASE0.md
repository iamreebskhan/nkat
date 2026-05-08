# Phase 0 — Foundation: Status

## Done

- **Project scaffold** at `C:\Users\S\Desktop\Nkat\billing-rules-platform`
  - README, .gitignore, .env.example, docker-compose.yml
  - `db/` with `migrations/`, `seed/`, `test/` subdirs
  - PowerShell apply + test scripts for Windows-friendly local dev

- **Postgres schema** (7 migration files, all 22 plan entities)
  - `0001_extensions_and_roles.sql` — extensions (pgvector, pgcrypto, citext, uuid-ossp, btree_gin), roles (`app` NOBYPASSRLS, `analyst`, `breakglass`), `app.current_org_id()` helper
  - `0002_reference_codes.sql` — code, modifier, modifier_relationship, pos, icd10, provider_taxonomy, revenue_code, ms_drg, ndc, hcc_mapping
  - `0003_payers_and_rules.sql` — state, product_line, payer, source_document, documentation_requirement, payer_rule, ncci_ptp, ncci_mue, cob_rule
  - `0004_document_chunks.sql` — document_chunk with HNSW vector index + GIN array indexes + tsvector for hybrid retrieval
  - `0005_tenant.sql` — org, app_user, org_member, client_company, client_rulebook, client_rule, audit_log, consent_record (42 CFR Part 2), alert
  - `0006_835_denial_abn.sql` — era_835_record, denial_event, abn_record
  - `0007_rls.sql` — RLS policies on every tenant-scoped table; assertion that reference tables stay open

- **Seed data**
  - 55 states/territories with MAC jurisdictions
  - 21 product lines covering FFS / MA / SNPs / Medicaid / commercial / WC / tribal / institutional variants
  - 47 Place of Service codes
  - 30 modifiers + NCCI hierarchy + mutual-exclusion relationships
  - 25 institutional revenue codes (hospice, home health, hospital outpatient, SNF)
  - ~30 NUCC provider taxonomies (physicians, NPs, PAs, behavioral health, hospice agencies)
  - 9 Coordination of Benefits rules (Medicare/Medicaid/employer/auto/WC/VA/TRICARE/ESRD)

- **Tests**
  - `0001_smoke.sql` — extensions present, reference data populated, RLS enabled on tenant tables, RLS disabled on reference tables, HNSW index present
  - `0002_rls_isolation.sql` — 2-tenant cross-leakage scenarios; cross-tenant write blocked

## Verified by test runs

**Status: BLOCKED on local Docker Desktop being wedged.** During this session
Docker Desktop's UI + WSL distros were running but the engine pipe
(`\\.\pipe\dockerDesktopLinuxEngine`) never responded. Re-terminating the WSL
distros didn't recover it. Test runs are deferred until Docker is healthy.

### Docker recovery steps (run yourself when ready)

1. Right-click the Docker Desktop tray icon → **Quit Docker Desktop**.
2. Wait 10s.
3. Right-click the Docker Desktop shortcut → **Run as administrator**.
4. Wait for the whale icon to go solid green (typically 30–60s).
5. Verify: `docker version` should print `Server: ...` within 5s.
6. Then run from this folder:

   ```powershell
   cd C:\Users\S\Desktop\Nkat\billing-rules-platform
   .\db\apply.ps1
   .\db\test.ps1
   ```

   Expected output:
   - `apply.ps1` → "APPLY OK"
   - `test.ps1` → "SMOKE OK" + "RLS ISOLATION OK" + "ALL TESTS OK"

If `apply.ps1 -Reset` is used, it will drop the volume and start clean.

### What the tests prove

- Smoke test: extensions present, all 13 reference seed loads succeeded, RLS
  is enabled on the 11 tenant-scoped tables and disabled on the 20 reference
  tables, the HNSW vector index on `document_chunk.embedding` exists.
- RLS isolation test: with two orgs and separate `client_company` rows, an
  `app` session reading with `app.current_org_id` set to org A sees only A's
  rows; setting it to B sees only B's; unsetting it sees zero rows; an
  attempted cross-tenant insert is blocked by the `WITH CHECK` clause.

## Open items still pending (manual / external)

- AMA CPT license application via royalties portal
- CMS Coverage API license-agreement token
- AWS account + HIPAA BAA + sub-processor BAAs (Bedrock, Datadog, Stripe, Vanta, Comprehend Medical)
- Healthcare regulatory counsel retainer
- Cyber/E&O insurance broker engagement
- BAA + MSA + DPA template legal review
- FDA CDS exemption memo + Colorado AI Act + WMHMDA applicability analyses
- 5 sample client docs + 100 sample 835 files for gold eval set
- Pilot customer + initial state confirmation
- First 2 analyst hires planned

## Phase 1 entry criteria

- [ ] Smoke + RLS tests pass locally
- [ ] CMS Coverage API token obtained → start ingesting NCDs/LCDs for palliative codes
- [ ] AMA CPT license application submitted (in flight)
- [ ] AWS HIPAA BAA signed (in flight)

Next: Phase 1 — Medicare core lookup. NestJS skeleton with tenant-RLS interceptor; CMS Coverage API ingestion proof-of-concept; query parser + RAG + citation rendering.
