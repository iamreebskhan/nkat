-- ============================================================================
-- 0006_cob_rules.sql
-- Coordination of Benefits priority rules per CMS guidance.
-- Source: https://www.cms.gov/medicare/coordination-benefits-recovery/overview/coordination-benefits
-- ============================================================================

INSERT INTO cob_rule (coverage_type_a, coverage_type_b, primary_position, conditions, rationale, source_url, effective_date) VALUES
  -- Medicare vs employer group health plan
  ('medicare',         'employer_group_health',
    'depends',
    '{"primary_if_employer_size_lt": 20, "primary_otherwise": "B"}'::jsonb,
    'Medicare primary if employer < 20 employees; secondary if >= 20',
    'https://www.cms.gov/medicare/coordination-benefits-recovery/overview/coordination-benefits',
    '1965-07-30'),
  -- Medicare vs Medicaid
  ('medicare',         'medicaid',
    'A',
    '{}'::jsonb,
    'Medicare always primary; Medicaid is payer of last resort',
    'https://www.medicaid.gov/medicaid/eligibility-policy/medicaid-third-party-liability-coordination-benefits/index.html',
    '1965-07-30'),
  -- Commercial vs Medicaid
  ('commercial',       'medicaid',
    'A',
    '{}'::jsonb,
    'Medicaid is payer of last resort by federal law',
    'https://www.medicaid.gov/medicaid/eligibility-policy/medicaid-third-party-liability-coordination-benefits/index.html',
    '1965-07-30'),
  -- Auto / no-fault vs Medicare
  ('auto_no_fault',    'medicare',
    'A',
    '{"applies_when": "treatment_is_for_motor_vehicle_injury"}'::jsonb,
    'Auto / no-fault primary for treatment of motor vehicle accident injuries',
    'https://www.cms.gov/medicare/coordination-benefits-recovery/overview/coordination-benefits',
    '1980-12-05'),
  -- Workers comp vs Medicare
  ('workers_comp',     'medicare',
    'A',
    '{"applies_when": "treatment_is_for_work_related_injury"}'::jsonb,
    'WC primary for work-related injury treatment',
    'https://www.cms.gov/medicare/coordination-benefits-recovery/overview/coordination-benefits',
    '1980-12-05'),
  -- VA / TRICARE vs Medicare
  ('va_benefits',      'medicare',
    'tie_other_rules',
    '{"note": "VA does not coordinate with Medicare; member chooses where to seek care"}'::jsonb,
    'VA care is not primary or secondary to Medicare; separate systems',
    'https://www.cms.gov/medicare/coordination-benefits-recovery/overview/coordination-benefits',
    '1965-07-30'),
  ('tricare',          'medicare',
    'B',
    '{}'::jsonb,
    'Medicare primary for active-duty retirees enrolled in Medicare; TRICARE pays remainder',
    'https://www.cms.gov/medicare/coordination-benefits-recovery/overview/coordination-benefits',
    '1965-07-30'),
  -- ESRD: special 30-month coordination period
  ('employer_group_health', 'medicare',
    'depends',
    '{"esrd_30_month_coordination_period": true}'::jsonb,
    'For ESRD, employer group plan is primary for 30 months; Medicare primary thereafter',
    'https://www.cms.gov/medicare/coordination-benefits-recovery/overview/coordination-benefits',
    '1972-10-30'),
  -- Dual eligibility: Medicaid always last
  ('any_other',        'medicaid',
    'A',
    '{}'::jsonb,
    'Medicaid is always payer of last resort regardless of other coverage type',
    'https://www.medicaid.gov/medicaid/eligibility-policy/medicaid-third-party-liability-coordination-benefits/index.html',
    '1965-07-30')
ON CONFLICT DO NOTHING;
