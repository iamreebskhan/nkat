# Full cross-check runbook — backend → user UI → master UI

One place that lists every live verification harness and what each proves, so a
full "is everything working" pass is a copy-paste on the VPS. All of these are
**session + SQL** paths except where noted — they pass regardless of Anthropic
API credit state (the AI-feature harness is the one exception, flagged below).

Run from `/opt/pallio/app` after `git pull origin main`.

## 1. Backend — every API route

```bash
BASE_URL=https://app.pallio.io CRON_SECRET=$(grep -hE '^CRON_SECRET=' .env .env.local .env.production 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'"'"'') \
  node scripts/probe-full-live.mjs
```
Probes all ~113 route contracts (auth, shapes, status codes) incl. the admin
API surface. Expected: **123/123** (119 without CRON_SECRET — 4 cron checks gate on it).

## 2. Master / operator surface (platform-admin)

```bash
# gating half (no operator creds needed): regular users are locked out
BASE_URL=https://app.pallio.io node scripts/verify-master-ui.mjs

# + function half: operator sees real data (use Hamda's platform_admin creds).
# read -rs keeps the password off-screen, out of history, and unmangled
# (a literal ! or # in the password is safe this way — never paste it into a command).
read -rs -p 'operator password: ' OPERATOR_PASSWORD; export OPERATOR_PASSWORD; echo
export OPERATOR_EMAIL='hamda@theaura.agency'
BASE_URL=https://app.pallio.io node scripts/verify-master-ui.mjs
```
Part A: every `/api/admin/*` returns **403** to the demo (org_admin) user, and
the operator pages don't render for them. Part B (with `OPERATOR_*`): the same
endpoints return **200 + data** and the `/admin/*` pages render for the
platform_admin. Proves the master UI is both **locked** and **functional**.

**If Part B fails at "operator login" (401):** the script now prints *why*.
Confirm the operator account exists, is flagged `platform_admin`, and whether
it has 2FA — one query:

```bash
sudo -u postgres psql pallio -c \
 "SELECT email, is_platform_admin, (mfa_enrolled_at IS NOT NULL) AS mfa_on FROM app_user WHERE email ILIKE 'hamda%';"
```

- `is_platform_admin = f` → promote it: `UPDATE app_user SET is_platform_admin = TRUE WHERE email = 'hamda@theaura.agency';`
- `mfa_on = t` → the 401 is "MFA code required"; re-run with `OPERATOR_MFA=<current 6-digit code>`.
- No row → the account doesn't exist under that email; create/verify it first.
- Row exists, no MFA, flagged admin, still 401 → the password is wrong or was
  paste-mangled (single-quote any password containing `!` or `#`).

## 3. User UI — headless click-through

```bash
BASE_URL=https://app.pallio.io node scripts/e2e-live-walkthrough.mjs
```
Drives a real browser through the user app as `livedemo@pallio.io`: login →
patients → superbill → billing lookup → denials (decide/refile/outcome
buttons) → rulebook → cheat sheets → messages → care plan → schedule →
logout, with screenshots. Expected: **30/30**.

## 3b. Exhaustive UI crawl — every page, every button, DnD, file upload

```bash
BASE_URL=https://app.pallio.io node scripts/e2e-exhaustive-ui.mjs
# include the master pages too (operator creds, via read -rs as in §2)
# include AI-invoking buttons (spends a little credit): INCLUDE_AI=1
```
Breadth to the walkthrough's depth: crawls **all ~34 user pages** (+5 detail
pages it seeds itself), clicks **every safe button** (destructive labels
skipped), and fails hard on any uncaught page exception or 5xx; UI-provoked
`/api` 404s are reported as broken-wiring warnings. Also drives the two flows
nothing else covers: **schedule drag-and-drop** (drag a visit card to another
day → `PATCH /reschedule` must 200) and the **rulebook CSV file input**
(real file chosen → `POST /api/rulebook/upload` → comparison renders).
Expected: **0 hard failures**.

## 4. Full CY2026 rule — extraction reads + comparison (demo seat)

```bash
BASE_URL=https://app.pallio.io node scripts/verify-demo-user-medicare.mjs
```
Demo user reads full-rule lookups (Federal-Register-cited), runs a Path-B
comparison (diff/unverified/new_from_pallio), and a green match. Expected: **13/13**.

## 5. Post-scan wiring fixes (FE→BE persistence)

```bash
BASE_URL=https://app.pallio.io node scripts/verify-scan-fixes.mjs
```
Denial decide→refile→outcome persistence, attestation claim-on-open, breakglass
audit. Expected: **15/15**.

## 5b. PHI column encryption (one-time provisioning)

Member IDs are dual-written to encrypted `_enc` companions (0034) once
`PALLIO_PHI_KEY` is set. One-time setup — generates the key, stores it, and
backfills existing rows (nothing to hand-edit):

```bash
cd /opt/pallio/app
grep -q '^PALLIO_PHI_KEY=' .env || echo "PALLIO_PHI_KEY=$(openssl rand -hex 32)" >> .env
pm2 restart pallio
export PALLIO_PHI_KEY=$(grep -hE '^PALLIO_PHI_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"')
sudo -u postgres psql pallio -v phi_key="$PALLIO_PHI_KEY" -f scripts/backfill-phi-encryption.sql
```

The verify SELECT at the end must show **0 / 0 / 0** (no plaintext without
ciphertext, no round-trip mismatch). The admin **/admin/compliance** page has
a "PHI member-id encryption coverage" check that turns green once this runs.
⚠ Back the key up (password manager / Vault) — ciphertexts are unreadable
without it. Rotate quarterly per the pgp.ts header (re-encrypt via a rerun of
the backfill after clearing `_enc`, old key in hand).

## 6. Live AI features  *(needs Anthropic API credits)*

```bash
node scripts/diagnose-anthropic-api.mjs                     # 3 models → 200
BASE_URL=https://app.pallio.io node scripts/probe-live-account.mjs   # deep intelligence
```
`diagnose` confirms Sonnet 4.6 / Opus 4.8 / Haiku all answer (~a cent).
`probe-live-account` exercises RAG embedding, denial analysis, cheat-sheet
gen, care plans. Expected: **24/24**. (Only these two depend on API credits;
1–5 above do not.)

---

### One-shot (1–5, no API credits required)

```bash
cd /opt/pallio/app && git pull origin main
export BASE_URL=https://app.pallio.io
export CRON_SECRET=$(grep -hE '^CRON_SECRET=' .env .env.local .env.production 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'"'"'')
node scripts/probe-full-live.mjs        && \
node scripts/verify-master-ui.mjs       && \
node scripts/e2e-live-walkthrough.mjs   && \
node scripts/e2e-exhaustive-ui.mjs      && \
node scripts/verify-demo-user-medicare.mjs && \
node scripts/verify-scan-fixes.mjs      && \
echo "✅ ALL GREEN (backend + master UI + user UI + every button + full rule + wiring)"
```

CI additionally guarantees on every PR: typecheck + lint, unit tests,
integration (real Postgres + pgvector), migrations apply cleanly, OpenAPI
drift, extension typecheck/e2e, PHI scrubber. The gold-standard eval also runs
there and needs API credits.
