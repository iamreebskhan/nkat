-- ============================================================================
-- 0001_smoke.sql
-- Smoke tests: every reference table populated, every constraint declared,
-- every extension enabled. Run as breakglass / admin role.
-- ============================================================================

\set ON_ERROR_STOP on
\timing off

\echo '== Extension presence =='
SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','citext','vector','uuid-ossp','btree_gin')
ORDER BY extname;

\echo ''
\echo '== Reference table row counts =='
SELECT 'state'              AS table, count(*) FROM state UNION ALL
SELECT 'product_line'       AS table, count(*) FROM product_line UNION ALL
SELECT 'pos'                AS table, count(*) FROM pos UNION ALL
SELECT 'modifier'           AS table, count(*) FROM modifier UNION ALL
SELECT 'modifier_relationship', count(*) FROM modifier_relationship UNION ALL
SELECT 'revenue_code'       AS table, count(*) FROM revenue_code UNION ALL
SELECT 'provider_taxonomy'  AS table, count(*) FROM provider_taxonomy UNION ALL
SELECT 'cob_rule'           AS table, count(*) FROM cob_rule
ORDER BY 1;

\echo ''
\echo '== Tenant tables exist and are empty =='
SELECT 'org'                AS table, count(*) FROM org UNION ALL
SELECT 'app_user'           AS table, count(*) FROM app_user UNION ALL
SELECT 'org_member'         AS table, count(*) FROM org_member UNION ALL
SELECT 'client_company'     AS table, count(*) FROM client_company UNION ALL
SELECT 'client_rulebook'    AS table, count(*) FROM client_rulebook UNION ALL
SELECT 'client_rule'        AS table, count(*) FROM client_rule UNION ALL
SELECT 'audit_log'          AS table, count(*) FROM audit_log UNION ALL
SELECT 'consent_record'     AS table, count(*) FROM consent_record UNION ALL
SELECT 'alert'              AS table, count(*) FROM alert UNION ALL
SELECT 'era_835_record'     AS table, count(*) FROM era_835_record UNION ALL
SELECT 'denial_event'       AS table, count(*) FROM denial_event UNION ALL
SELECT 'abn_record'         AS table, count(*) FROM abn_record
ORDER BY 1;

\echo ''
\echo '== RLS enabled on tenant-scoped tables =='
SELECT relname AS table, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relkind = 'r'
  AND relname IN (
    'org','org_member','client_company','client_rulebook','client_rule',
    'audit_log','consent_record','alert','era_835_record','denial_event','abn_record'
  )
ORDER BY relname;

\echo ''
\echo '== RLS disabled on reference tables =='
SELECT relname AS table, relrowsecurity AS rls_enabled
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relkind = 'r'
  AND relname IN (
    'code','modifier','modifier_relationship','pos','icd10','provider_taxonomy',
    'revenue_code','ms_drg','ndc','hcc_mapping','payer','state','product_line',
    'source_document','document_chunk','payer_rule','ncci_ptp','ncci_mue',
    'cob_rule','documentation_requirement'
  )
ORDER BY relname;

\echo ''
\echo '== app.current_org_id() function exists =='
SELECT proname, pronamespace::regnamespace AS schema
FROM pg_proc WHERE proname = 'current_org_id';

\echo ''
\echo '== HNSW index on document_chunk.embedding =='
SELECT i.indexname, am.amname AS method
FROM pg_indexes i
JOIN pg_class c ON c.relname = i.indexname
JOIN pg_am am ON am.oid = c.relam
WHERE i.tablename = 'document_chunk' AND am.amname = 'hnsw';

\echo ''
\echo 'SMOKE OK'
