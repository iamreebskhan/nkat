# Demo tenant

Audit R20. How to create, check, refresh and retire the demo org
**Pallio Demo Palliative Care** (slug `pallio-demo-palliative-care`, id
`d0000000-0000-4000-8000-000000000001`).

It replaces 'Pallio Live Demo', which held two cloned fixture patients, typing
left over from a walkthrough and one user who sat in no care-team seat. That
org cannot be cleaned in place, because `audit_log_retention_guard` keeps six
years of its audit rows, so the replacement is a new org.

The source is `db/seed/tenant-demo-palliative.sql`. It is deliberately **not**
in `db/seed/MANIFEST`, so no deploy applies it. CI applies it to its own
throwaway database on every push, so a schema change that breaks it fails CI.

## What it contains

- **Staff:** eight people at `@demo.pallio.io`. None has an individual NPI
  (see [NPIs](#npis)).

  | Login | Role template | Credential | Shows |
  |---|---|---|---|
  | `helen.okafor@demo.pallio.io` | org_admin | MD | Medical director; sees patients and signs as MD |
  | `colleen.brandt@demo.pallio.io` | org_admin | — | Practice manager; Team, settings, audit |
  | `marcus.delgado@demo.pallio.io` | clinician | NP | Visits, notes and sign-off; no billing |
  | `priya.raman@demo.pallio.io` | clinician | NP | Same as above |
  | `theresa.kowalski@demo.pallio.io` | clinician | RN | RN case manager; care-team seat on every chart |
  | `jamal.whitfield@demo.pallio.io` | clinician | LCSW | Social worker; care-team seat on every chart |
  | `dana.mercer@demo.pallio.io` | billing_agent | — | Claims and denials; cannot edit a note |
  | `anne.lindqvist@demo.pallio.io` | read_only | — | Chaplain; reads patients and the audit log, creates nothing |

- **Patients:** 14, all with distinct names and birth dates (1931 to 1958),
  living in nine towns around Columbus. Acuity is 3 critical, 4 high,
  5 medium and 2 low. One patient is discharged and one is deceased, and all
  four care-team seats are filled on every chart.
- **Visits:** 52 in all.
  - 40 are signed, spread over the last six weeks, by the MD and the two NPs.
    Two are telehealth and two are advance care planning.
  - The other 12 are scheduled over the next two weeks.
  - The dates are relative to the day the seed runs, so the current week
    always has visits for all three clinicians.
- **Notes:** every signed visit has the required sections, goals of care,
  medications and code status. Every signed home visit also has vitals, and
  weight and PPS fall over time.
- **Bills:** 40, one per signed visit: 29 paid, 1 partly paid, 2 denied,
  6 submitted and 2 still in draft.
  - They are priced the way the app prices them: the payer's rate on file
    first, then the reference table.
  - The two denials (CARC 50 and CARC 16) wait for a decision.
- **Care plans:** 5 patients have one.

## Before you start

1. **The deploy carrying migration 0101 (R36) has run.** It retires 'Pallio
   Live Demo'. This command should print 0:

   ```bash
   sudo -u postgres psql pallio -X -tAc "SELECT count(*) FROM org WHERE slug = 'pallio-live-demo' AND deleted_at IS NULL"
   ```

2. **Migrations through 0103 are applied.** The seed writes
   `visit.signer_credential` (0098) and `org_visit_type.is_telehealth` (0099),
   and it also fills `patient_contact`, `external_provider` and
   `patient_external_provider` — the three tables 0103 creates (audit R30) —
   because its closing checks require a family contact and a referring
   physician on every patient. The seed's own header says 0103 too.

   This gate used to stop at 0099 and check only the two columns, so an
   operator on 0100, 0101 or 0102 passed both checks and then watched the seed
   die on `ERROR: relation "patient_contact" does not exist` — which is not one
   of the failures listed below, because it is not one the seed raises. The
   command now counts the two columns **and** the three tables, so it should
   print 5:

   ```bash
   sudo -u postgres psql pallio -X -tAc "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND (table_name, column_name) IN (('visit', 'signer_credential'), ('org_visit_type', 'is_telehealth'))) + (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('patient_contact', 'external_provider', 'patient_external_provider'))"
   ```

   0103 is the whole floor. 0104 revokes TRUNCATE on the log tables and 0105
   pins already-started notes to their org's active template; neither creates
   or drops anything this seed writes, and 0105 has nothing to reach in an org
   that does not exist yet — the seed pins its own notes itself, after it
   writes them. Being past 0103 is fine; being short of it is not.

## Create it (on the VPS)

```bash
cd /opt/pallio/app
read -rs -p 'demo password: ' DEMO_PW; echo
sudo -u postgres psql pallio -X -v ON_ERROR_STOP=1 -v demo_password="$DEMO_PW" -f db/seed/tenant-demo-palliative.sql
unset DEMO_PW
```

The run should end with these two lines:

```
demo seed: password set on the seeded @demo.pallio.io accounts
COMMIT
```

The whole file is one transaction. If you see `ERROR: demo seed: …`, nothing
was written; the message names the problem.

- **Duplicate name or date of birth:** two patients in the org share one.
- **Daily capacity:** a clinician has more visits in one day than the org's
  daily capacity allows.
- **Payer name:** a payer named in the seed is missing or matches more than
  one active payer.

About the password:

- All eight accounts get the one password.
- If you leave out `-v demo_password=…`, no password is set. On a first run
  that means no one can log in, because `login()` rejects a NULL hash.
- The password is stored as a bcrypt hash (pgcrypto, cost 12), and nothing
  about it is kept in git.
- While psql runs, the password is visible in the process list. It is also
  in the text of the one statement that hashes it, so the seed switches
  statement logging off for its own transaction first (`log_statement`,
  `log_min_duration_statement`, `log_min_error_statement`): the server log
  does not capture it, even on a server that logs slow statements.

Then encrypt the member ids the seed wrote in plaintext. This is
CROSSCHECK-RUNBOOK §5b; it reads the key from `.env`, so there is nothing to
substitute:

```bash
cd /opt/pallio/app
export PALLIO_PHI_KEY=$(grep -hE '^PALLIO_PHI_KEY=' .env .env.local .env.production 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
sudo -u postgres psql pallio -v phi_key="$PALLIO_PHI_KEY" -f scripts/backfill-phi-encryption.sql
unset PALLIO_PHI_KEY
```

All three counts it prints should be 0.

## Check it

```bash
sudo -u postgres psql pallio -X <<'SQL'
SELECT (SELECT count(*) FROM patient    WHERE org_id = 'd0000000-0000-4000-8000-000000000001') AS patients,
       (SELECT count(*) FROM visit      WHERE org_id = 'd0000000-0000-4000-8000-000000000001') AS visits,
       (SELECT count(*) FROM superbill  WHERE org_id = 'd0000000-0000-4000-8000-000000000001') AS bills,
       (SELECT count(*) FROM superbill_denial WHERE org_id = 'd0000000-0000-4000-8000-000000000001') AS denials,
       (SELECT count(*) FROM org_member WHERE org_id = 'd0000000-0000-4000-8000-000000000001') AS staff;
SELECT lower(first_name), lower(last_name), count(*) FROM patient
 WHERE org_id = 'd0000000-0000-4000-8000-000000000001' GROUP BY 1, 2 HAVING count(*) > 1;
SELECT date_of_birth, count(*) FROM patient
 WHERE org_id = 'd0000000-0000-4000-8000-000000000001' GROUP BY 1 HAVING count(*) > 1;
SQL
```

The first query should return 14, 52, 40, 2 and 8, and the two duplicate
queries should return no rows.

## Giving someone access

This is R20 decision 1. To give the person running the demo, for example
Mark, a login:

1. Sign in as `colleen.brandt@demo.pallio.io` with the demo password.
2. Open **Team → Invite** and invite **their own email** with the `org_admin`
   template.

Their actions then show under their own name in /audit. The org is on the
`org` plan (25 seats); a `team` plan has five, fewer than this roster.

Use the seeded logins only to show role separation:

- **As the RN:** `/billing/superbills` is denied and `GET /api/superbills`
  returns 403.
- **As the biller:** `PATCH /api/visits/<id>/document` returns 403.
- **As the chaplain:** patients are listed, and there is no button to create
  one.

## Harness scripts never touch it

No harness script may run against an `@demo.pallio.io` account. Those
scripts sign up, create patients and stack visits; that is how 'Pallio Live
Demo' filled up with clones.

R36's guard in `scripts/lib/test-credentials.mjs` enforces this.
`DEMO_TENANT_EMAIL` refuses a `TEST_EMAIL` on the tenant, and
`DEMO_TENANT_ORG` refuses a `TEST_ORG` naming it. Either way the script exits
2 before making any request.

To check it, run this against localhost. It should exit 2 and leave the
org's visit count unchanged:

```bash
TEST_EMAIL=helen.okafor@demo.pallio.io BASE_URL=http://localhost:3000 node scripts/verify-scan-fixes.mjs; echo "exit $?"
```

## NPIs

The org NPI is `1234567893`, the check-digit example CMS publishes.
Clinicians have a credential but no individual NPI, because a real-format
number could belong to a real provider (R20 decision 2). Until real NPIs are
recorded, every bill names the org NPI as rendering provider, and the bill
page warns about it.

When the practice supplies real NPIs, or they are confirmed against NPPES,
record them on the Team page. That fills them into the open bills (R40). A
re-run of the seed keeps them: it writes the org NPI back only onto a bill
that still carries the org NPI, or none.

## Re-running

Re-running is safe and idempotent. It:

- moves the caseload to the current week;
- restores every seeded row to its seeded state, including notes, bills,
  denials and each seeded user's permissions;
- leaves rows created in the app alone;
- keeps existing passwords unless `-v demo_password=…` is passed again.

After a re-run, run the PHI backfill again.

Do not re-run the seed straight after a live demo unless you mean to reset
it. If someone signed one of the seeded upcoming visits, the re-run sets
that visit back to scheduled. A bill they raised on it would stay attached to
a visit that no longer looks signed, so void that bill first.

## Retiring it

The org cannot be deleted, for the same audit-retention reason as 'Pallio
Live Demo'. Retire it the way 0101 retires that org: set `deleted_at`. Login
then ignores the org, so its accounts can no longer sign in.

```bash
sudo -u postgres psql pallio -X -c "UPDATE org SET deleted_at = now() WHERE id = 'd0000000-0000-4000-8000-000000000001' AND deleted_at IS NULL"
```

A re-run of the seed does not undo this; a retired demo org stays retired.

## Running it locally

Always try the seed on localhost before a VPS run:

```bash
read -rs -p 'demo password: ' DEMO_PW; echo
psql "postgres://admin:admin_dev_only_change_in_prod@localhost:5432/billing_rules" -X -v ON_ERROR_STOP=1 -v demo_password="$DEMO_PW" -f db/seed/tenant-demo-palliative.sql
unset DEMO_PW
```

Run it twice. The counts from [Check it](#check-it), with the psql URL above
in place of `sudo -u postgres psql pallio`, should be the same after both
runs.
