// netlify/functions/lib/job-mapping.js
//
// Maps a frontend "position" selection to a Manatal job_id.
//
// Per the migration spec, only 1 of the form's 41 position names is an
// exact match against Manatal's listed jobs ("Social Media Manager").
// Per Kyle's decision (Aug 2026), every other selection - including the
// remaining 40 named roles and "Other" - routes to the general catch-all,
// "50 Plus Other positions".
//
// The LatAm and Reapplication catch-alls exist as Manatal job_ids but are
// NOT wired up here: the current form has no region-selector or
// "returning applicant" field to trigger them. Left as named constants
// below so they're one line to wire in once/if that UI ships.

const JOB_IDS = {
  SEO_SPECIALIST:            'b248117a-108e-4f34-beb0-3d652d1aaabc',
  DIGITAL_MARKETING_MANAGER: '726007d6-53ae-4ed4-94be-11e593adef2a',
  COPYWRITER:                '80ecf5fb-5528-4779-9c50-1e161168c6c4',
  EXECUTIVE_ASSISTANT:       '878c49b1-2183-4c74-a6ed-20083a2398ae',
  INSIDE_SALES_AGENT:        'e16cac3d-dc65-4c34-ba3a-1a38a0b1058b',
  BOOKKEEPER:                '3be69b35-c4f3-4692-8813-3d05ae3a2e70',
  LEAD_GEN_SPECIALIST:       'a8307ba5-c0de-4844-b77b-d06a2df68f44',
  TRANSACTION_LISTING_COORD: '1244f6f3-26dd-4c15-a61e-fda5fd29e394',
  GHL_SPECIALIST:            '65f85e73-394e-4181-a30d-08a848b1a2f6',
  SOCIAL_MEDIA_MANAGER:      '214804f9-f9b7-46e8-bb76-adff666d1c94',

  // Catch-alls
  OTHER_POSITIONS:  'a5476f66-b93d-4ace-930e-d52c540353a0', // "50 Plus Other positions" — DEFAULT
  LATAM_NETWORK:    '31409302-326a-4c17-b9ad-5470b170ef28', // not currently reachable from the form
  REAPPLICATION:    '493bc2c5-bd18-48ef-8a60-c346df1d1d1c', // not currently reachable from the form
};

const DEFAULT_JOB_ID = JOB_IDS.OTHER_POSITIONS;

// Explicit overrides: frontend `position` value (exact string, case-sensitive
// as it comes out of the form) -> job_id. Everything NOT listed here falls
// through to DEFAULT_JOB_ID. Add rows here as you confirm more 1:1 matches.
const EXPLICIT_MAP = {
  'Social Media Manager': JOB_IDS.SOCIAL_MEDIA_MANAGER,
};

/**
 * @param {string} position - raw value of the `position` form field
 * @returns {string} Manatal job_id
 */
function mapPositionToJobId(position) {
  if (!position) return DEFAULT_JOB_ID;
  const trimmed = position.trim();
  return EXPLICIT_MAP[trimmed] || DEFAULT_JOB_ID;
}

module.exports = { JOB_IDS, DEFAULT_JOB_ID, EXPLICIT_MAP, mapPositionToJobId };
