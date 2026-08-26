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
//
// ID FORMAT — deliberately legacy/numeric, not UUID (confirmed via testing,
// Aug 2026): Manatal's newer v1 Career Page API (UUID-format job ids) only
// exposes Manatal's own predefined fields. The legacy numeric-id career-page
// endpoints (/career-page/{slug}/jobs/{id}/...) are the ones that actually
// carry our org's custom questionnaire fields. "Legacy" in their docs does
// not mean deprecated-for-us — it's the only namespace with our custom
// fields, so this is deliberate, not an oversight. Revisit only if/when
// Manatal migrates custom questionnaires onto the UUID endpoints.

const JOB_IDS = {
  SEO_SPECIALIST:            2915653,
  DIGITAL_MARKETING_MANAGER: 2915667,
  COPYWRITER:                2915699,
  EXECUTIVE_ASSISTANT:       2915701,
  INSIDE_SALES_AGENT:        2915668,
  BOOKKEEPER:                2915664,
  LEAD_GEN_SPECIALIST:       2915697,
  TRANSACTION_LISTING_COORD: 2915700,
  GHL_SPECIALIST:            2915703,
  SOCIAL_MEDIA_MANAGER:      2923924,

  // Catch-alls
  OTHER_POSITIONS:  3055555, // "50 Plus Other positions" — DEFAULT
  LATAM_NETWORK:    3600743, // not currently reachable from the form
  REAPPLICATION:    3412588, // not currently reachable from the form
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
