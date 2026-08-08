-- 0067 — expand the coverage target set to what a palliative practice
-- actually bills.
--
-- 0066 seeded 16 codes as the target. That was the narrow extraction's
-- scope, not the practice's. Production evidence: the demo org's
-- superbills carry 99347 and 99349, always with place of service 12 —
-- but a home-based palliative practice bills far more than home-visit
-- E/M. Patients are seen in the office between home visits, care is
-- managed between encounters, and transitions of care are billed after
-- every discharge.
--
-- The library now holds 443 distinct codes, so the target set is what
-- decides whether the coverage report means anything. Under-scoping it
-- reports 100% while real gaps hide; over-scoping it reports permanent
-- red for codes nobody bills. This is the set a home-based palliative
-- practice plausibly submits.
--
-- is_core marks the codes whose absence is urgent rather than untidy.

BEGIN;

INSERT INTO library_coverage_target (code, label, is_core, notes) VALUES
  -- Office / outpatient E/M. Patients are seen in clinic between home
  -- visits, and these are the most-billed E/M codes in any practice.
  ('99202', 'Office/outpatient visit, new patient, straightforward MDM',   FALSE, NULL),
  ('99203', 'Office/outpatient visit, new patient, low MDM',               FALSE, NULL),
  ('99204', 'Office/outpatient visit, new patient, moderate MDM',          FALSE, NULL),
  ('99205', 'Office/outpatient visit, new patient, high MDM',              FALSE, NULL),
  ('99212', 'Office/outpatient visit, established, straightforward MDM',   FALSE, NULL),
  ('99213', 'Office/outpatient visit, established, low MDM',              TRUE,  NULL),
  ('99214', 'Office/outpatient visit, established, moderate MDM',         TRUE,  NULL),
  ('99215', 'Office/outpatient visit, established, high MDM',             FALSE, NULL),

  -- Chronic and principal care management — the recurring revenue
  -- between visits, and a common denial source when a payer restricts
  -- them.
  ('99490', 'Chronic care management, first 20 minutes',                  TRUE,  NULL),
  ('99439', 'Chronic care management, each additional 20 minutes',        FALSE, 'Add-on to 99490'),
  ('99491', 'Chronic care management, physician time, first 30 minutes',  FALSE, NULL),
  ('99424', 'Principal care management, first 30 minutes',                FALSE, NULL),
  ('99425', 'Principal care management, each additional 30 minutes',      FALSE, 'Add-on to 99424'),
  ('99426', 'Principal care management, clinical staff, first 30 minutes', FALSE, NULL),
  ('99427', 'Principal care management, clinical staff, addl 30 minutes', FALSE, 'Add-on to 99426'),

  -- Prolonged services. G0316/G0317 are the Medicare-specific codes;
  -- 99417 is the CPT one, and Medicare does NOT accept it (status I on
  -- the PFS) — exactly the sort of divergence the library exists to
  -- surface, so both belong in the target set.
  ('G0316', 'Prolonged inpatient/observation E/M, each 15 minutes',       FALSE, NULL),
  ('G0317', 'Prolonged nursing facility E/M, each 15 minutes',            FALSE, NULL),

  -- Advance care planning is already targeted; add the venipuncture
  -- routinely drawn during a home visit.
  ('36415', 'Collection of venous blood by venipuncture',                 FALSE, NULL),

  -- Home health supervision, billed alongside certification.
  ('G0181', 'Home health care supervision, 30 minutes or more',           FALSE, NULL),
  ('G0182', 'Hospice care supervision, 30 minutes or more',               FALSE, NULL)
ON CONFLICT (code) DO UPDATE SET
  label   = EXCLUDED.label,
  is_core = EXCLUDED.is_core,
  notes   = EXCLUDED.notes;

COMMIT;
