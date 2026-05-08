# Medical Billing Rule Lookup + Reconciliation Platform

Multi-tenant SaaS that helps medical billers pre-flight claims against payer × state × code rules,
reconcile their company rule docs against authoritative sources, and measure outcomes from 835 ERA files.

See the full plan: `C:\Users\S\.claude\plans\c-users-s-desktop-nkat-transcript-txt-r-vast-beaver.md`

## Status

**Phase 0 — Foundation.** Postgres schema + reference data first.

## Repository layout

```
billing-rules-platform/
├── db/
│   ├── migrations/    # numbered, forward-only SQL migrations (Sqitch-compatible naming)
│   ├── seed/          # idempotent reference-data inserts
│   └── test/          # smoke + RLS isolation tests
├── docs/              # ADRs, ops runbooks
├── docker-compose.yml # Postgres 16 + pgvector for local dev
├── .env.example
└── README.md
```

## Quick start (local dev)

Prereqs: Docker Desktop running.

```powershell
# 1. Start Postgres with pgvector
docker compose up -d db

# 2. Apply migrations (in order)
.\db\apply.ps1

# 3. Run tests
.\db\test.ps1
```

## Compliance posture (high level)

- HIPAA Business Associate by default; BAA with every customer.
- Postgres Row-Level Security on every tenant-scoped table; reference data is global.
- 6-year audit log retention (Object Lock for immutability).
- AMA CPT license required before paid pilot — store code numbers only, never AMA verbatim descriptors.
- FDA CDS §3060 four-factor exemption documented pre-launch.
- WMHMDA, Colorado AI Act SB24-205, California AB 3030 applicability analyses on file.

## Build phases

Per the approved plan:

| Phase | Weeks | Scope |
|---|---|---|
| 0 | 1–2 | Foundation: schema, infra, licenses, BAAs |
| 1 | 3–7 | Medicare core lookup + UX core |
| 2 | 8–12 | Ohio commercial payers + 835 ingestion |
| 3 | 13–17 | Reconciliation + alerts + browser ext + SOC 2 Type 1 |
| 4 | 18–22 | NC + SC + behavioral health + SNPs + CCM/RPM/RTM |
| 5 | 23–24+ | Oncology + DMEPOS + WC + IHS + ASC + CMS-0057-F |
