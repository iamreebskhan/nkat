-- ============================================================================
-- 0014_hcc_v28.sql
-- CMS-HCC v28 mapping subset.
-- Source: CMS HCC Risk Adjustment 2024 Final Rule (V28 phased in 2024-2026).
-- This is a representative ~30-row subset for end-to-end validation; the
-- full V28 mapping is loaded via CSV ingestion in Phase 6.
-- ============================================================================

INSERT INTO hcc_mapping (icd10, hcc_version, hcc_code, category, raf_weight, effective_year) VALUES
  -- Diabetes (combined HCC)
  ('E11.21',  'V28', 'HCC037', 'Diabetes with chronic complications',           0.302, 2026),
  ('E11.22',  'V28', 'HCC037', 'Diabetes with chronic complications',           0.302, 2026),
  ('E11.40',  'V28', 'HCC037', 'Diabetes with chronic complications',           0.302, 2026),
  ('E11.65',  'V28', 'HCC036', 'Diabetes with acute complications',             0.302, 2026),
  ('E11.9',   'V28', 'HCC038', 'Diabetes without complication',                 0.105, 2026),
  -- CHF
  ('I50.20',  'V28', 'HCC224', 'Heart Failure, Except End-Stage and Acute',     0.337, 2026),
  ('I50.22',  'V28', 'HCC224', 'Heart Failure, Except End-Stage and Acute',     0.337, 2026),
  ('I50.32',  'V28', 'HCC224', 'Heart Failure, Except End-Stage and Acute',     0.337, 2026),
  ('I50.84',  'V28', 'HCC222', 'End-Stage Heart Failure',                       0.737, 2026),
  ('I50.9',   'V28', 'HCC226', 'Heart Failure, Unspecified',                    0.275, 2026),
  -- COPD
  ('J44.0',   'V28', 'HCC280', 'Chronic Obstructive Pulmonary Disease',         0.319, 2026),
  ('J44.1',   'V28', 'HCC280', 'Chronic Obstructive Pulmonary Disease',         0.319, 2026),
  ('J44.9',   'V28', 'HCC280', 'Chronic Obstructive Pulmonary Disease',         0.319, 2026),
  -- Cancers
  ('C18.0',   'V28', 'HCC020', 'Colorectal, Anal, and Other GI Cancers',        0.281, 2026),
  ('C50.911', 'V28', 'HCC019', 'Breast and Other Cancers',                      0.149, 2026),
  ('C61',     'V28', 'HCC019', 'Breast and Other Cancers',                      0.149, 2026),
  ('C34.10',  'V28', 'HCC017', 'Lung and Other Severe Cancers',                 0.928, 2026),
  -- Behavioral / SUD
  ('F32.A',   'V28', 'HCC151', 'Major Depressive, Bipolar, and Paranoid',       0.276, 2026),
  ('F33.0',   'V28', 'HCC151', 'Major Depressive, Bipolar, and Paranoid',       0.276, 2026),
  ('F10.20',  'V28', 'HCC135', 'Alcohol Use Disorder',                          0.317, 2026),
  ('F11.20',  'V28', 'HCC136', 'Drug Use Disorder',                             0.347, 2026),
  -- Dementia / neurological
  ('G30.9',   'V28', 'HCC125', 'Dementia, Severity Unspecified',                0.346, 2026),
  -- Renal
  ('N18.5',   'V28', 'HCC329', 'CKD Stage 5',                                   0.418, 2026),
  ('N18.6',   'V28', 'HCC328', 'End Stage Renal Disease',                       0.473, 2026),
  -- Respiratory failure
  ('J96.20',  'V28', 'HCC279', 'Respiratory Failure',                           0.388, 2026),
  -- Cachexia / hospice-relevant
  ('R64',     'V28', 'HCC084', 'Cachexia',                                      0.476, 2026)
  -- (Z51.5 palliative-care encounter does not map to an HCC; intentionally omitted.)
ON CONFLICT (icd10, hcc_version, hcc_code, effective_year) DO UPDATE
  SET category = EXCLUDED.category,
      raf_weight = EXCLUDED.raf_weight;
