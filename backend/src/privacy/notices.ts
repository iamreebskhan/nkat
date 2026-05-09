/**
 * Static state-privacy notice library.
 *
 * Each entry is the canonical short notice we serve when a consumer
 * is a resident of that state. The wording is reviewed by counsel;
 * code does not change it without bumping the `version` field.
 *
 * Pure data — no side effects. Lives outside the DB so the legal
 * team can review changes via a code-review on PRs.
 *
 * IMPORTANT: not legal advice. Counsel must approve any wording change.
 */
import type { PrivacyRegime } from '../database/schema.types';

export interface Notice {
  regime: PrivacyRegime;
  version: string;
  jurisdictions: string[]; // ISO-style state codes; "*" = all-US default
  title: string;
  body: string;
  actions: NoticeAction[];
}

export interface NoticeAction {
  label: string;
  href?: string; // an internal route, e.g. '/v1/privacy/dsar'
  kind: 'link' | 'consent' | 'opt_out';
}

const WMHMDA_BODY =
  'Washington residents: under the My Health My Data Act (MHMDA, RCW 19.373), ' +
  'we collect, use, and share consumer health data only as described in our ' +
  'Consumer Health Data Privacy Policy. You may request access, deletion, or ' +
  'opt out of the sale of your consumer health data. We do not sell your ' +
  'consumer health data. Treble damages may apply for violations.';

const CCPA_BODY =
  'California residents: under CCPA/CPRA you have the right to know what ' +
  'personal information we collect, the right to delete, the right to opt out ' +
  'of sale or sharing, and the right to limit use of sensitive personal ' +
  'information. We do not sell your personal information.';

const CPA_CO_BODY =
  'Colorado residents: under the Colorado Privacy Act you have the right of ' +
  'access, correction, deletion, portability, opt-out of sale, opt-out of ' +
  'targeted advertising, and opt-out of profiling for decisions producing ' +
  'legal or similarly significant effects.';

const SB24_205_AI_CO_BODY =
  'Colorado residents: this product uses an AI system as part of its operations. ' +
  'Under the Colorado AI Act (SB24-205, effective June 30, 2026), we provide ' +
  'pre-deployment notice when AI is used to make or substantially influence a ' +
  'consequential decision affecting you. Our system is provider-facing and does ' +
  'not autonomously make consequential decisions; a licensed billing professional ' +
  'reviews every output before action.';

const AB3030_AI_BODY =
  'California: California Assembly Bill 3030 requires that AI-generated patient ' +
  'communications about clinical information include a disclaimer and a path to a ' +
  'human licensed provider. Our tool is provider-facing — your billing team is the ' +
  'licensed reviewer — so AB 3030 does not apply directly here, but if you ' +
  'integrate our outputs into patient-facing communications you remain ' +
  'responsible for the AB 3030 disclaimer.';

const TDPSA_TX_BODY =
  'Texas residents: under the Texas Data Privacy and Security Act (TDPSA) you ' +
  'have rights of access, deletion, portability, correction, opt-out of sale, ' +
  'opt-out of targeted advertising, and opt-out of profiling.';

const VCDPA_VA_BODY =
  'Virginia residents: under the Virginia Consumer Data Protection Act (VCDPA) ' +
  'you have rights of access, deletion, correction, portability, and opt-out of ' +
  'sale and targeted advertising.';

const GENERAL_BODY =
  'We process personal information in accordance with our Privacy Policy. You ' +
  'may exercise rights under applicable state privacy law (CCPA, CPA, VCDPA, ' +
  'TDPSA, etc.) by submitting a Data Subject Access Request.';

export const NOTICES: Notice[] = [
  {
    regime: 'wmhmda',
    version: '2026-05-01',
    jurisdictions: ['WA'],
    title: 'Washington Consumer Health Data Notice (MHMDA)',
    body: WMHMDA_BODY,
    actions: [
      {
        label: 'View full Consumer Health Data Privacy Policy',
        href: '/legal/wmhmda',
        kind: 'link',
      },
      { label: 'Submit a request to exercise your rights', href: '/v1/privacy/dsar', kind: 'link' },
    ],
  },
  {
    regime: 'ccpa',
    version: '2026-05-01',
    jurisdictions: ['CA'],
    title: 'California Privacy Notice (CCPA / CPRA)',
    body: CCPA_BODY,
    actions: [
      {
        label: 'Do Not Sell or Share My Personal Information',
        href: '/v1/privacy/dsar?type=opt_out_sale',
        kind: 'opt_out',
      },
      { label: 'Submit an access or deletion request', href: '/v1/privacy/dsar', kind: 'link' },
    ],
  },
  {
    regime: 'cpa_co',
    version: '2026-05-01',
    jurisdictions: ['CO'],
    title: 'Colorado Privacy Notice (CPA)',
    body: CPA_CO_BODY,
    actions: [
      { label: 'Submit an access or deletion request', href: '/v1/privacy/dsar', kind: 'link' },
    ],
  },
  {
    regime: 'sb24_205_ai_co',
    version: '2026-05-01',
    jurisdictions: ['CO'],
    title: 'Colorado AI Notice (SB24-205)',
    body: SB24_205_AI_CO_BODY,
    actions: [],
  },
  {
    regime: 'ab3030_ai',
    version: '2026-05-01',
    jurisdictions: ['CA'],
    title: 'California AI in Healthcare Notice (AB 3030)',
    body: AB3030_AI_BODY,
    actions: [],
  },
  {
    regime: 'tdpsa_tx',
    version: '2026-05-01',
    jurisdictions: ['TX'],
    title: 'Texas Privacy Notice (TDPSA)',
    body: TDPSA_TX_BODY,
    actions: [{ label: 'Submit a request', href: '/v1/privacy/dsar', kind: 'link' }],
  },
  {
    regime: 'vcdpa_va',
    version: '2026-05-01',
    jurisdictions: ['VA'],
    title: 'Virginia Privacy Notice (VCDPA)',
    body: VCDPA_VA_BODY,
    actions: [{ label: 'Submit a request', href: '/v1/privacy/dsar', kind: 'link' }],
  },
  {
    regime: 'general',
    version: '2026-05-01',
    jurisdictions: ['*'],
    title: 'General Privacy Notice',
    body: GENERAL_BODY,
    actions: [{ label: 'Submit a request', href: '/v1/privacy/dsar', kind: 'link' }],
  },
];

/**
 * Pick all notices applicable to a given state.
 *  - State-specific notices first (WMHMDA for WA, etc.).
 *  - Plus the AI-specific notices that overlay (AB 3030 for CA, SB24-205 for CO).
 *  - Plus the general fallback.
 */
export function noticesForState(stateCode: string): Notice[] {
  const u = stateCode.toUpperCase();
  const matches = NOTICES.filter((n) => n.jurisdictions.includes(u));
  const general = NOTICES.find((n) => n.regime === 'general');
  if (matches.length === 0 && general) return [general];
  if (general && !matches.includes(general)) matches.push(general);
  return matches;
}
