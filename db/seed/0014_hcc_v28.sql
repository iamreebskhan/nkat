-- ============================================================================
-- 0014_hcc_v28.sql
-- CMS-HCC v28 mapping subset.
-- A representative 23-row subset for end-to-end validation; the full V28
-- mapping is loaded via CSV ingestion in Phase 6.
--
-- SOURCE, row by row: CMS "2026 Midyear/Final ICD-10-CM Mappings" (the V28
-- category for payment year 2026), with each category's label and its
-- community, non-dual, aged relative factor from the V28 model software's
-- V28_CE_Relative_Factors.csv (CMS_HCC_v28_2026_T package).
--
-- These rows used to be written from memory, and most were wrong: V28 HCC
-- numbers with V24 weights (0.302, 0.105), heart failure on HCC 224 (acute on
-- chronic) and HCC 226 labelled "unspecified", four cancers each one category
-- off, CKD 5 and ESRD on the stage 3 categories, respiratory failure on
-- severe asthma (279). F32.A, F33.0 and R64 map to no V28 payment HCC, so
-- they are gone rather than kept on an invented category.
--
-- The primary key includes the HCC, so a corrected row would sit BESIDE the
-- wrong one; the old rows for these codes are removed first. Nothing
-- references this table. Idempotent.
-- ============================================================================

BEGIN;

DELETE FROM hcc_mapping
 WHERE hcc_version = 'V28' AND effective_year = 2026
   AND icd10 IN ('E11.21','E11.22','E11.40','E11.65','E11.9',
                 'I50.20','I50.22','I50.32','I50.84','I50.9',
                 'J44.0','J44.1','J44.9',
                 'C18.0','C50.911','C61','C34.10',
                 'F32.A','F33.0','F10.20','F11.20',
                 'G30.9','N18.5','N18.6','J96.20','R64');

INSERT INTO hcc_mapping (icd10, hcc_version, hcc_code, category, raf_weight, effective_year) VALUES
  -- Diabetes
  ('E11.21',  'V28', 'HCC037', 'Diabetes with Chronic Complications',                              0.166, 2026),
  ('E11.22',  'V28', 'HCC037', 'Diabetes with Chronic Complications',                              0.166, 2026),
  ('E11.40',  'V28', 'HCC037', 'Diabetes with Chronic Complications',                              0.166, 2026),
  ('E11.65',  'V28', 'HCC038', 'Diabetes with No, Glycemic, or Unspecified Complications',         0.166, 2026),
  ('E11.9',   'V28', 'HCC038', 'Diabetes with No, Glycemic, or Unspecified Complications',         0.166, 2026),
  -- Heart failure
  ('I50.20',  'V28', 'HCC226', 'Heart Failure, Except End Stage and Acute',                        0.360, 2026),
  ('I50.22',  'V28', 'HCC226', 'Heart Failure, Except End Stage and Acute',                        0.360, 2026),
  ('I50.32',  'V28', 'HCC226', 'Heart Failure, Except End Stage and Acute',                        0.360, 2026),
  ('I50.84',  'V28', 'HCC222', 'End Stage Heart Failure',                                          2.505, 2026),
  ('I50.9',   'V28', 'HCC226', 'Heart Failure, Except End Stage and Acute',                        0.360, 2026),
  -- COPD
  ('J44.0',   'V28', 'HCC280', 'Chronic Obstructive Pulmonary Disease, Interstitial Lung Disorders, and Other Chronic Lung Disorders', 0.319, 2026),
  ('J44.1',   'V28', 'HCC280', 'Chronic Obstructive Pulmonary Disease, Interstitial Lung Disorders, and Other Chronic Lung Disorders', 0.319, 2026),
  ('J44.9',   'V28', 'HCC280', 'Chronic Obstructive Pulmonary Disease, Interstitial Lung Disorders, and Other Chronic Lung Disorders', 0.319, 2026),
  -- Cancers
  ('C18.0',   'V28', 'HCC022', 'Bladder, Colorectal, and Other Cancers',                           0.363, 2026),
  ('C50.911', 'V28', 'HCC023', 'Prostate, Breast, and Other Cancers and Tumors',                   0.186, 2026),
  ('C61',     'V28', 'HCC023', 'Prostate, Breast, and Other Cancers and Tumors',                   0.186, 2026),
  ('C34.10',  'V28', 'HCC020', 'Lung and Other Severe Cancers',                                    1.136, 2026),
  -- Substance use
  ('F10.20',  'V28', 'HCC139', 'Alcohol Use Disorder, Moderate/Severe, or Alcohol Use with Specified Non-Psychotic Complications', 0.242, 2026),
  ('F11.20',  'V28', 'HCC137', 'Drug Use Disorder, Moderate/Severe, or Drug Use with Non-Psychotic Complications', 0.424, 2026),
  -- Dementia
  ('G30.9',   'V28', 'HCC127', 'Dementia, Mild or Unspecified',                                    0.341, 2026),
  -- Kidney
  ('N18.5',   'V28', 'HCC326', 'Chronic Kidney Disease, Stage 5',                                  0.815, 2026),
  ('N18.6',   'V28', 'HCC326', 'Chronic Kidney Disease, Stage 5',                                  0.815, 2026),
  -- Respiratory failure
  ('J96.20',  'V28', 'HCC213', 'Cardio-Respiratory Failure and Shock',                             0.370, 2026)
  -- (Z51.5 palliative-care encounter does not map to an HCC; intentionally omitted.)
ON CONFLICT (icd10, hcc_version, hcc_code, effective_year) DO UPDATE
  SET category = EXCLUDED.category,
      raf_weight = EXCLUDED.raf_weight;

COMMIT;
