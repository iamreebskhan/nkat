-- ============================================================================
-- 0001_states_product_lines.sql
-- US states + DC + territories. Product lines covering every billing context.
-- Idempotent (uses ON CONFLICT DO NOTHING / DO UPDATE).
-- ============================================================================

INSERT INTO state (state, name, region, mac_jurisdiction) VALUES
  ('AL','Alabama','Southeast','J10'), ('AK','Alaska','West','J6'),
  ('AZ','Arizona','West','J8'), ('AR','Arkansas','South','J7'),
  ('CA','California','West','J5'), ('CO','Colorado','West','J4'),
  ('CT','Connecticut','Northeast','J13'), ('DE','Delaware','Mid-Atlantic','J12'),
  ('DC','District of Columbia','Mid-Atlantic','J12'),
  ('FL','Florida','Southeast','J9'), ('GA','Georgia','Southeast','J10'),
  ('HI','Hawaii','West','J1'), ('ID','Idaho','West','J6'),
  ('IL','Illinois','Midwest','J6'), ('IN','Indiana','Midwest','J5'),
  ('IA','Iowa','Midwest','J5'), ('KS','Kansas','Midwest','J5'),
  ('KY','Kentucky','Southeast','J11'), ('LA','Louisiana','South','J7'),
  ('ME','Maine','Northeast','J13'), ('MD','Maryland','Mid-Atlantic','J12'),
  ('MA','Massachusetts','Northeast','J13'), ('MI','Michigan','Midwest','J6'),
  ('MN','Minnesota','Midwest','J6'), ('MS','Mississippi','South','J7'),
  ('MO','Missouri','Midwest','J5'), ('MT','Montana','West','J4'),
  ('NE','Nebraska','Midwest','J5'), ('NV','Nevada','West','J3'),
  ('NH','New Hampshire','Northeast','J13'), ('NJ','New Jersey','Mid-Atlantic','J12'),
  ('NM','New Mexico','West','J4'), ('NY','New York','Northeast','J13'),
  ('NC','North Carolina','Southeast','JM'), ('ND','North Dakota','Midwest','J6'),
  ('OH','Ohio','Midwest','J15'), ('OK','Oklahoma','South','J4'),
  ('OR','Oregon','West','J6'), ('PA','Pennsylvania','Mid-Atlantic','J12'),
  ('RI','Rhode Island','Northeast','J13'), ('SC','South Carolina','Southeast','JM'),
  ('SD','South Dakota','Midwest','J6'), ('TN','Tennessee','Southeast','J11'),
  ('TX','Texas','South','J4'), ('UT','Utah','West','J4'),
  ('VT','Vermont','Northeast','J13'), ('VA','Virginia','Mid-Atlantic','JM'),
  ('WA','Washington','West','J3'), ('WV','West Virginia','Mid-Atlantic','J12'),
  ('WI','Wisconsin','Midwest','J5'), ('WY','Wyoming','West','J4'),
  ('PR','Puerto Rico','Territory','J9'), ('VI','U.S. Virgin Islands','Territory','J9'),
  ('GU','Guam','Territory','J1'), ('AS','American Samoa','Territory','J1'),
  ('MP','Northern Mariana Islands','Territory','J1')
ON CONFLICT (state) DO NOTHING;

-- Product lines, covering every billing context the schema supports.
INSERT INTO product_line (product_line, description, claim_form_type) VALUES
  ('medicare_ffs',                 'Medicare Fee-For-Service (Part A & B)', 'either'),
  ('medicare_advantage',           'Medicare Advantage (Part C)',           'either'),
  ('medicare_advantage_dsnp',      'MA Dual Eligible SNP',                  'either'),
  ('medicare_advantage_csnp',      'MA Chronic Condition SNP',              'either'),
  ('medicare_advantage_isnp',      'MA Institutional SNP (SNF/LTC)',        'either'),
  ('medicaid_ffs',                 'State Medicaid Fee-For-Service',        'either'),
  ('medicaid_mco',                 'Medicaid Managed Care Organization',    'either'),
  ('chip',                         'Children''s Health Insurance Program',  'either'),
  ('commercial',                   'Commercial / employer group',           'either'),
  ('exchange_qhp',                 'ACA Exchange Qualified Health Plan',    'either'),
  ('workers_comp_state',           'State Workers'' Compensation',          'professional'),
  ('workers_comp_federal_owcp',    'Federal OWCP (FECA/LHWCA/BLBA/EEOICPA)', 'professional'),
  ('auto_no_fault',                'Auto / no-fault medical',               'professional'),
  ('tribal_638',                   'Tribal 638 facility',                   'either'),
  ('ihs_direct',                   'IHS-operated facility',                 'either'),
  ('institutional_hospital',       'Hospital inpatient/outpatient',         'institutional'),
  ('institutional_snf',            'Skilled Nursing Facility',              'institutional'),
  ('institutional_hospice',        'Hospice',                               'institutional'),
  ('institutional_home_health',    'Home Health Agency',                    'institutional'),
  ('institutional_asc',            'Ambulatory Surgical Center',            'institutional')
ON CONFLICT (product_line) DO UPDATE
  SET description = EXCLUDED.description,
      claim_form_type = EXCLUDED.claim_form_type;
