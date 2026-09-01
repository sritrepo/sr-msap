// netlify/functions/lib/job-mapping.js
//
// Maps a frontend "position" selection to a Manatal job_id.
//
// UPDATED (Aug 2026): 8 new roles (Bookkeeper, Copywriter, Digital
// Marketing Manager, Executive Assistant, GoHighLevel (GHL) Specialist,
// Inside Sales Agent, Lead Generation Specialist, SEO Specialist) were
// added to the frontend's POSITIONS array specifically because they had
// real, dedicated Manatal job posts but no corresponding selectable
// option on the form — meaning every applicant for those roles was
// silently landing in the "50 Plus Other positions" catch-all. Now
// mapped 1:1. "Transaction Coordinator" and "Listing Coordinator" are
// two separate frontend roles that both map to Manatal's single combined
// "Transaction & Listing Coordinator" post, per the original migration
// spec. Every other frontend role, and "Other", still routes to the
// catch-all — there's no dedicated Manatal post for them.
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
  'Transaction Coordinator': JOB_IDS.TRANSACTION_LISTING_COORD,
  'Listing Coordinator': JOB_IDS.TRANSACTION_LISTING_COORD,
  'Bookkeeper': JOB_IDS.BOOKKEEPER,
  'Copywriter': JOB_IDS.COPYWRITER,
  'Digital Marketing Manager': JOB_IDS.DIGITAL_MARKETING_MANAGER,
  'Executive Assistant': JOB_IDS.EXECUTIVE_ASSISTANT,
  'GoHighLevel (GHL) Specialist': JOB_IDS.GHL_SPECIALIST,
  'Inside Sales Agent': JOB_IDS.INSIDE_SALES_AGENT,
  'Lead Generation Specialist': JOB_IDS.LEAD_GEN_SPECIALIST,
  'SEO Specialist': JOB_IDS.SEO_SPECIALIST,
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
