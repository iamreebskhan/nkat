-- ============================================================================
-- refresh-rulebook-mirrors.sql — run AFTER every seed application.
--
-- A practice's rulebook keeps a copy of each library rule it was generated
-- from (org_rulebook_row, origin 'source'). The seeds correct the library in
-- place, and a copy kept the old text until something rewrote it: after the
-- 3 Nov 2026 audit, production's rulebooks still read G0318 as an office code
-- and quoted CMS mid-sentence. The lookup no longer answers from these copies
-- (it asks the library, for the date of service), but the rulebook page and
-- the cheat sheets still print them, so they follow the library here.
--
-- Same reasoning as close-rule-timelines.sql: a migration would run before
-- the seeds that change the library, so this belongs downstream of them.
-- app.refresh_rulebook_mirrors() is migration 0130. A person's edit, upload
-- or payer call is never touched; every row rewritten is journalled whole in
-- rulebook_mirror_journal first.
--
-- Idempotent. Safe to run on every deploy. Writes nothing when every copy is
-- current.
-- ============================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  SELECT * INTO r FROM app.refresh_rulebook_mirrors();
  RAISE NOTICE 'rulebook copies: % now hold the rule in force today, % lost their rule (now unknown), % already current, % have no rule in the library (gaps, unreviewed AI answers) and were left alone',
    r.followed, r.emptied, r.already_current, r.unanswered;
END $$;
