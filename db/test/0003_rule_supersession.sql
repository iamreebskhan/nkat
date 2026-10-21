-- ============================================================================
-- 0003_rule_supersession.sql
-- The rule library is only correct if it was applied in db/seed/MANIFEST order.
-- This file reads the database CI just built and asserts the ANSWER it now
-- serves, not the row counts and not the order of the shell loop that built it.
--
-- WHY IT EXISTS, named concretely. Rule seeds expire what they supersede
-- before inserting, and each revives its own rows with
-- `ON CONFLICT (id) DO UPDATE ... expiration_date = NULL`, so whichever of two
-- seeds sharing a key runs LAST wins. db/seed/payer-rules-denial-attributes.sql
-- (round 1) and -2.sql (round 2) share 28 keys. MANIFEST puts round 1 first so
-- round 2 wins; ASCII sorting inverts them, because '-' (0x2D) sorts before
-- '.' (0x2E), and CI applied `db/seed/*.sql` in glob order until 2026-09. The
-- database CI validated therefore served round 1 on all 28 keys while
-- production served round 2 — the same inversion round 1's own header records
-- as a production incident: "production quietly served the OLDER
-- UnitedHealthcare Ohio rule — the one without the TIN edit and without the
-- telehealth-list warning. No error anywhere; the row counts were all
-- correct." It was caught by the service-level check that reads the answer
-- text rather than counting rows. db/test had no such check. This is it.
--
-- Touches no user data. It reads payer_rule, payer and ingestion_source, and
-- materialises one `ON COMMIT DROP` temp table inside the first DO block; the
-- only right it needs beyond SELECT is TEMP on the database. It used to say
-- "every statement here is a SELECT", which is what a reader checks before
-- pointing a file at a production database — and it was false, so the next
-- person to add a statement here had no honest line to keep true.
-- ============================================================================

\set ON_ERROR_STOP on

\echo '== Rule supersession: round 2 must be live on every key it shares with round 1 =='

DO $$
DECLARE
  shared_keys      int;
  round1_live      int;
  round2_live      int;
  dupe_keys        int;
  worst            text;
BEGIN
  CREATE TEMP TABLE shared_key ON COMMIT DROP AS
    SELECT DISTINCT r1.payer_id, r1.state, r1.code, r1.attribute
      FROM payer_rule r1
      JOIN payer_rule r2
        ON (r2.payer_id, r2.state, r2.code, r2.attribute)
         = (r1.payer_id, r1.state, r1.code, r1.attribute)
     WHERE r1.created_by = 'extract:denial-rules-2026-08'
       AND r2.created_by = 'extract:denial-rules-round2-2026-08';

  SELECT count(*) INTO shared_keys FROM shared_key;

  -- POSITIVE CONTROL for everything below. The supersession assertions are
  -- "round 1 is not live on these keys" and the multiplicity assertion is "no
  -- key carries two live rules"; both are trivially true of a database with no
  -- rule rows at all — a seed dropped from MANIFEST, or a rule library that
  -- never applied. Round 1's own header records 28 shared keys.
  IF shared_keys < 28 THEN
    RAISE EXCEPTION 'RULE LIBRARY INCOMPLETE: only % key(s) are written by BOTH payer-rules-denial-attributes.sql and -2.sql; their headers document 28. Rounds 1 and 2 are not both in this database, so the supersession checks below would pass vacuously.',
      shared_keys;
  END IF;

  SELECT
    count(*) FILTER (WHERE pr.created_by = 'extract:denial-rules-2026-08'),
    count(*) FILTER (WHERE pr.created_by = 'extract:denial-rules-round2-2026-08')
    INTO round1_live, round2_live
    FROM payer_rule pr
    JOIN shared_key s
      ON (pr.payer_id, pr.state, pr.code, pr.attribute)
       = (s.payer_id, s.state, s.code, s.attribute)
   WHERE pr.expiration_date IS NULL;

  IF round1_live <> 0 THEN
    SELECT string_agg(format('%s/%s/%s', pr.state, pr.code, pr.attribute), ', ')
      INTO worst
      FROM payer_rule pr
      JOIN shared_key s
        ON (pr.payer_id, pr.state, pr.code, pr.attribute)
         = (s.payer_id, s.state, s.code, s.attribute)
     WHERE pr.expiration_date IS NULL
       AND pr.created_by = 'extract:denial-rules-2026-08';
    RAISE EXCEPTION 'SEED ORDER WRONG: round 1 (payer-rules-denial-attributes.sql) is LIVE on % of % shared key(s) — %. Round 2 supersedes it, so round 2 must be applied after it. The seeds were applied in filesystem order, not db/seed/MANIFEST order.',
      round1_live, shared_keys, worst;
  END IF;

  IF round2_live <> shared_keys THEN
    RAISE EXCEPTION 'SEED ORDER WRONG: round 2 (payer-rules-denial-attributes-2.sql) is live on only % of % shared key(s); it must win on all of them.',
      round2_live, shared_keys;
  END IF;

  -- fetchPayerRule ends in LIMIT 1, so two live rows on one key make the
  -- answer depend on row order. Both seeds' headers say so in as many words.
  --
  -- Scope: EVERY live payer_rule key, not only the keys the two
  -- denial-attribute seeds share. Scoped to the shared keys, this gate missed
  -- the one CI shape it was cited as covering. Applying
  -- db/seed/0018_test_palliative_payer_rules.sql AFTER the rule library
  -- instead of before leaves 15 keys carrying two live rules each — all 15
  -- outside the shared-key set — and 0003 exited 0 on that database. Over the
  -- whole live table it is still satisfied by a correctly built library:
  -- 0 duplicate keys on a full CI database applied in MANIFEST order, 0 on the
  -- developer's database, and 0 with 0018 in its proper place BEFORE the
  -- library, which expires all 15 of its rows on the way past.
  SELECT count(*), left(string_agg(d.k, ', ' ORDER BY d.k), 400)
    INTO dupe_keys, worst
    FROM (
      SELECT format('%s/%s/%s/%s', pr.state, pr.product_line, pr.code, pr.attribute) AS k
        FROM payer_rule pr
       WHERE pr.expiration_date IS NULL
       GROUP BY pr.payer_id, pr.state, pr.product_line, pr.code, pr.attribute
      HAVING count(*) > 1
    ) d;
  IF dupe_keys <> 0 THEN
    RAISE EXCEPTION 'AMBIGUOUS RULE: % live payer_rule key(s) carry more than one row — %. fetchPayerRule ends in LIMIT 1, so the answer a clinician sees would depend on row order. Two seeds wrote the same key and neither expired the other: check that every fixture writing payer_rule is applied BEFORE the rule library, not after it.',
      dupe_keys, worst;
  END IF;
END $$;

\echo 'Round 2 wins on every shared key; no live payer_rule key carries two rows.'

\echo ''
\echo '== The answer text itself, on the key the incident was found on =='

DO $$
DECLARE
  n_live  int;
  answer  text;
  author  text;
BEGIN
  SELECT count(*) INTO n_live
    FROM payer_rule
   WHERE payer_id = 'a0000000-0000-4000-8000-000000000302'
     AND state = 'OH' AND product_line = 'medicaid_mco'
     AND code = '99349' AND attribute = 'provider_taxonomy_allowed'
     AND expiration_date IS NULL;
  IF n_live <> 1 THEN
    RAISE EXCEPTION 'RULE MISSING OR AMBIGUOUS: UnitedHealthcare Community Plan OH / OH / 99349 / provider_taxonomy_allowed has % live rule(s); expected exactly 1.',
      n_live;
  END IF;

  SELECT value->>'answer', created_by INTO answer, author
    FROM payer_rule
   WHERE payer_id = 'a0000000-0000-4000-8000-000000000302'
     AND state = 'OH' AND product_line = 'medicaid_mco'
     AND code = '99349' AND attribute = 'provider_taxonomy_allowed'
     AND expiration_date IS NULL;

  -- The TIN edit is the whole difference between the two rounds on this key,
  -- and it is what a biller acts on: round 2 says the edit keys on the billing
  -- TIN, round 1's telehealth-practitioner list does not mention it at all.
  -- Counting rows cannot tell the two apart — both are one live row.
  IF answer NOT ILIKE '%own individual or group TIN%' THEN
    RAISE EXCEPTION 'WRONG RULE LIVE: the live answer for UHC Community Plan OH / 99349 / provider_taxonomy_allowed does not carry the TIN edit (written by %). Answer begins: %',
      author, left(coalesce(answer, '<null>'), 160);
  END IF;
END $$;

\echo 'Live answer carries round 2 TIN edit.'

\echo ''
\echo '== Ingestion sources resolved their payer =='

-- db/seed/ingestion-sources-cms.sql resolves Traditional Medicare with
-- `SELECT id FROM payer WHERE name ILIKE '%medicare%'` and writes payer_id
-- NULL when that finds nothing — legal, and silent. Under filesystem order it
-- ran before payer-medicare.sql, the only seed that creates that payer, so in
-- CI every CMS source was bound to no payer and inert:
-- ingestDocumentFromUrl only writes payer_rule rows when BOTH payer_id and
-- state are set. MANIFEST puts payer-medicare.sql first, which is why this
-- passes; it is the assertion that notices if that stops being true.
DO $$
DECLARE n_medicare int; n_unbound int; urls text;
BEGIN
  SELECT count(*) INTO n_medicare FROM payer WHERE name ILIKE '%medicare%';
  IF n_medicare < 1 THEN
    RAISE EXCEPTION 'SEED ORDER WRONG: no payer matches ILIKE ''%%medicare%%'' — db/seed/payer-medicare.sql did not apply, so every Medicare ingestion source resolved to NULL.';
  END IF;

  SELECT count(*), string_agg(url, ', ') INTO n_unbound, urls
    FROM ingestion_source WHERE payer_id IS NULL;
  IF n_unbound <> 0 THEN
    RAISE EXCEPTION 'INGESTION SOURCE UNBOUND: % source(s) have payer_id NULL — %. The seed resolves its payer by name, so it was applied before the payer existed; ON CONFLICT (url) DO NOTHING never repairs the binding on a re-run.',
      n_unbound, urls;
  END IF;
END $$;

\echo ''
\echo 'RULE SUPERSESSION OK'
