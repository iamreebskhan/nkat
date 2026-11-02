-- ============================================================================
-- 0113_symptom_scores.sql
--
-- Shortness of breath and nausea, scored 0-10 at each visit beside pain
-- (Level-1 doc:80-83; Mark Q11b default: 0-10 for the three symptoms the
-- workflow names). Pain was the only one recorded, so dyspnea and nausea and
-- the symptom burden over time could not be reported.
--
-- On visit_vitals with pain, so the trend that draws the weight and the pain
-- draws these too, one row per visit.
-- ============================================================================

ALTER TABLE visit_vitals
  ADD COLUMN dyspnea_score SMALLINT CHECK (dyspnea_score IS NULL OR dyspnea_score BETWEEN 0 AND 10),
  ADD COLUMN nausea_score  SMALLINT CHECK (nausea_score IS NULL OR nausea_score BETWEEN 0 AND 10);

COMMENT ON COLUMN visit_vitals.dyspnea_score IS 'Shortness of breath, 0-10 (Mark Q11b).';
COMMENT ON COLUMN visit_vitals.nausea_score IS 'Nausea, 0-10 (Mark Q11b).';
