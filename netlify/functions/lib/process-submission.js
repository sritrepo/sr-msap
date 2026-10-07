// netlify/functions/lib/process-submission.js
//
// The actual "do the migration to Manatal" logic, factored out of the
// HTTP handler so retry-failed-submissions.js can run the identical
// pipeline against a replayed payload.

const { mapPositionToJobId } = require('./job-mapping');
const {
  applyToJob,
  findCandidateByEmail,
  findMostRecentMatch,
  patchCandidateCustomFields,
  uploadMatchAttachment,
} = require('./manatal-client');
const { validateAndNormalizeFile } = require('./file-validator');
const { hostAttachment, deleteHostedAttachment } = require('./file-hosting');

const MANATAL_TOKEN = process.env.MANATAL_API_TOKEN;
const CLIENT_SLUG = process.env.MANATAL_CLIENT_SLUG || 'sphererocketva';

// Files uploaded as attachments on the MATCH (this specific job
// application), not the candidate's general record — see
// findMostRecentMatch in manatal-client.js. Label is what shows up as
// the attachment name in Manatal.
//
// resume_file is included here too: it's still also sent to applyToJob()
// below (Manatal needs it there for candidate creation/parsing), but
// that alone was landing it as a general candidate file, not scoped to
// the job it was tailored for — which defeated the point of letting
// applicants submit a different resume per role (Kyle, Oct 1 2026).
// Uploading it again here, against the match, fixes that.
const ATTACHMENT_FIELDS = [
  { field: 'resume_file', label: 'Resume' },
  { field: 'gov_id_file', label: 'Government ID' },
  { field: 'disc_file', label: 'DISC Assessment' },
  { field: 'device_specs_file', label: 'Device Specs' },
  { field: 'speed_test_file', label: 'Internet Speed Test' },
];

// ── Value-translation tables ──────────────────────────────────────────
// Manatal dropdown/checkbox custom fields validate against an exact
// choice string. Where the frontend's option text doesn't literally
// match Manatal's choice text, we translate here rather than touching
// the frontend copy (per Kyle's call, Sept 2026).
//
// Sourced from a direct diff of index.html's option values against
// qna-final-sept.json's `choices` arrays for the same slug.

// "Have you attended any formal VA training program or course?" —
// Manatal field type is `array` (checkbox), so the translated value
// must ALSO be wrapped in an array — see transform below.
const VA_TRAINING_MAP = {
  'Yes - completed formal VA training': 'Yes — I have completed a formal VA training program',
  'Yes - currently enrolled in VA training': 'Yes — I am currently enrolled in a VA training program',
  'No - self-taught with practical work experience': 'No — I am self-taught with practical work experience',
  'No - no formal VA training yet': 'No — I have not undergone any formal VA training yet',
  'Other': 'Other',
};

// Only the 2 gov-ID choices whose wording differs; everything else in
// the frontend's 9-option list matches Manatal's text exactly already.
const GOV_ID_MAP = {
  'Philippine Identification System ID (PhilSys / National ID)':
    'Philippine Identification System ID (PhilSys ID or National ID)',
  "Voter's ID or Voter's Certification (COMELEC)":
    "Voter's ID or Voter's Certification from the Commission on Elections (COMELEC)",
};

// CONFIRMED (Kyle, Sept 2026): frontend offers a plain "Facebook"
// option with no equivalent in Manatal's 17-choice list — Manatal only
// has "Facebook Ads", no plain "Facebook" choice exists on their side.
// Mapped straight across.
const REFERRAL_SOURCE_MAP = {
  'Facebook': 'Facebook Ads',
};

// Intentionally left unmapped (Kyle's call, Sept 2026): frontend's
// referrer list ("VA Janvee", "Jessy Sphere") doesn't match Manatal's
// ("Jason Sphere"), but internal team membership changes often enough
// that reconciling the two lists now wouldn't stay accurate for long.
// Revisit if/when this becomes worth actively maintaining.

function stripToDigits(value) {
  const digits = String(value).replace(/[^0-9]/g, '');
  return digits === '' ? undefined : Number(digits);
}

// Maps our form field names (the ACTUAL multipart payload keys the
// frontend sends — several differ from the semantic names you'd guess,
// see notes) to Manatal custom_fields slugs, confirmed against
// qna-final-sept.json (Sept 2026, 13 job postings, identical 46-field
// questionnaire on all of them). Optional `transform` handles value
// translation / type coercion / array-wrapping per field.
//
// NOT mapped (intentionally, see notes above/below):
//   - contract_type: no matching Manatal custom field exists at all.
//     UI selection screen is hidden for now (see index.html), payload
//     defaults to "Both (IC & BPO)" as a placeholder. Feature is on
//     hold, not removed — re-add a slug entry here once the field
//     exists in Manatal.
//
// sr_client_name / sr_client_last_day are handled separately below
// buildCustomFieldsPayload's main loop — Manatal only has one combined
// field for both (confirmed against the dashboard directly, Sept 2026).
const CUSTOM_FIELD_MAP = {
  has_va_experience:        { slug: 'doyouhaveavirtualassistantexperience' },
  previous_sr_client:       { slug: 'haveyouhadclientsfromsphererocketbefore' },
  va_training:              {
    slug: 'haveyouattendedanyformalvirtualassistanttrainingprogramorcourse',
    transform: (v) => (VA_TRAINING_MAP[v] ? [VA_TRAINING_MAP[v]] : undefined),
  },
  va_training_details:      { slug: 'vatrainingdetails' },
  computer_type:            { slug: 'doyouownapcoramac' },
  backup_power_internet:    { slug: 'doyouhaveabackuppowersourceandinternetconnection' },
  // NOTE: real payload keys, not "weekly_hours" / "rest_days" —
  // confirmed against the actual FormData field names built in
  // index.html's submit handler.
  weekly_hours_commitment:  { slug: 'howmuchworkinghourscanyoucommitinaweek' },
  preferred_rest_days:      { slug: 'restdays' },
  gov_id_type:               {
    slug: 'pleasechooseonevalidgovernmentidtoupload',
    transform: (v) => GOV_ID_MAP[v] || v,
  },
  disc_style:                 { slug: 'whatisyourdiscstyle' },
  // NOTE: real payload key is "min_rate_usd", not "min_rate". Manatal
  // field type is integer — strip the "$" the frontend placeholder
  // encourages (e.g. "$5") down to a plain number.
  min_rate_usd:                { slug: 'howmuchisyourpayperhour', transform: stripToDigits },
  // NOTE: real payload key is "max_rate_usd", not "max_rate". Unlike
  // min_rate, Manatal's "maxrate" field is type TEXT — send as-is,
  // don't coerce to a number.
  max_rate_usd:                 { slug: 'maxrate' },
  tools_used:                   { slug: 'pleaselistdownallthetoolsthatyouhaveusedfromyourpreviouswork' },
  other_languages:              { slug: 'doyouspeakanyotherlanguages' },
  college_degree:               { slug: 'whatisyourdegree' },
  portfolio_url:                { slug: 'sharethelinkofyoursampleworkportfolio' },
  referral_source:              {
    slug: 'howdidyouhearaboutsphererocketva',
    transform: (v) => REFERRAL_SOURCE_MAP[v] || v,
  },
  previous_client_industry:     { slug: 'whatwasthebusinessindustryofyourpreviousclient' },
  emergency_contact_name:       { slug: 'emergencycontactname' },
  // Manatal field type is integer, but this is a free-text `tel` input
  // (e.g. "+63 9XX XXX XXXX"). Stripped to digits-only (e.g.
  // "639171234567"). Kyle confirmed this field is real and in active
  // use on the Manatal side — still worth a live test submission to
  // make sure the digit-stripped format is what actually lands
  // correctly, since that part hasn't been verified end-to-end yet.
  emergency_contact_number:     { slug: 'emergencycontactnumber', transform: stripToDigits },
  alternative_phone:            { slug: 'contact' },
  facebook_url:                 { slug: 'whatisyourfacebookprofilelink' },
  complete_address:             { slug: 'address' },
  // Added Sept 29 2026 — these two ALSO still go to Manatal's native
  // `linkedin` / `message` params on /apply/ (see processSubmission).
  linkedin_instagram_url:       { slug: 'pleaseshareyourlinkedininstagramprofilelink' },
  skills_summary:               { slug: 'brieflyoutlineyourrelevantskillsandexperience' },
};

// Manatal dropdown, but confirmed by direct test (Kyle, Sept 29 2026)
// that the API does NOT validate the value against the choices list, so
// no translation/allowlist is needed: send whatever the form sent, or
// "N/A" when the dropdown was hidden/left empty.
const INTERNAL_REFERRAL_SLUG = 'ifyouwerereferredbyasphererocketinternalteampleaseinputthenamebelow';

/**
 * CONFIRMED (Aug 2026, sourced directly from Kyle's qna-final.json export
 * of these fields, which lists field_category: "candidate_field" for
 * each — meaning these slugs ARE real candidate custom field keys, not
 * leftover data from an unrelated system): the 9 consent/disclaimer
 * checkboxes on the form. Each is a Manatal `checkbox` field with
 * type "array" and exactly one valid choice, "I Agree." (WITH the
 * trailing period — confirmed against the exported choices array).
 *
 * Because type is "array", the value must be sent as an array, e.g.
 * ["I Agree."], not a bare string — a bare string would very likely be
 * silently rejected as not matching the field's expected shape.
 *
 * These always get sent, regardless of what the candidate submitted for
 * other fields, since there's no legitimate alternative answer to a
 * required consent checkbox with only one valid choice.
 *
 * NOT included here: "Have you attended any formal Virtual Assistant
 * training program or course?" — also a checkbox field in the same
 * export, but a real multi-choice question with 5 genuine answers, not
 * a consent item. That one should come from the candidate's actual
 * form answer via CUSTOM_FIELD_MAP above once its form field name is
 * known, not be auto-filled.
 */
const AUTO_AGREE_CUSTOM_FIELDS = {
  friendlyreminderwhenyouuploadyourresumepleasemakesuretoincludethejobtitleanddescriptionofthepositionyoureapplyingfor: ['I Agree.'],
  iunderstandsphererocketvaisnotmyemployeranddoesnotguaranteejobplacementorhiring: ['I Agree.'],
  sphererocketvaisausbasedtechplatformthatconnectsbusinessownersandvirtualassistantsforpotentialworkingrelationships: ['I Agree.'],
  sphererocketvamayrecommendorintroduceprofilesbasedonfitbutallhiringdecisionsaremadesolelybytheclient: ['I Agree.'],
  compensationcontractsandworktermsarenegotiateddirectlybetweentheclientandvasphererocketvaisnotapartytotheseagreements: ['I Agree.'],
  sphererocketvadoesnotnegotiatepayassigntasksmanageschedulesorsupervisetheworkofanyvirtualassistant: ['I Agree.'],
  iunderstandthatvettinginterviewsarenotjobinterviewsbutinternalassessmentsusedforprofilereviewandfuturematching: ['I Agree.'],
  notallapplicantswillbematchedorselectedvisibilitydependsonclientdemandskillalignmentandplatformneeds: ['I Agree.'],
  imayupdateorresubmitmyapplicationatanytimetoreflectnewskillstoolsavailabilityorotherrelevantchanges: ['I Agree.'],
};

// "SR Client Name" + "SR Client Last Day" combine into ONE Manatal
// field. Confirmed Sept 2026 — Kyle checked the dashboard directly:
// this really is a single combined custom field
// (`srclientnameandlastday`), not two separate ones. (Earlier
// confusion was with `previous_sr_client`, the separate Yes/No
// question above — that one IS its own field, already mapped below.)
const SR_CLIENT_SLUG = 'srclientnameandlastday';

function buildCustomFieldsPayload(fields) {
  const payload = { ...AUTO_AGREE_CUSTOM_FIELDS };
  for (const [formField, mapping] of Object.entries(CUSTOM_FIELD_MAP)) {
    const raw = fields[formField];
    if (raw === undefined || raw === '') continue;

    const { slug, transform } = mapping;
    const value = transform ? transform(raw) : raw;

    // A transform can intentionally return undefined (e.g. va_training
    // getting a value with no known translation) — skip rather than
    // send a bad payload for that one field.
    if (value === undefined) continue;

    payload[slug] = value;
  }

  payload[INTERNAL_REFERRAL_SLUG] = (fields.internal_referral || '').trim() || 'N/A';

  // Raw selected position text, sent as-is regardless of whether it
  // matched a specific Manatal job_id or fell through to a catch-all
  // (see job-mapping.js). Added Sept 30 2026 so sourcing/recruitment can
  // always see exactly what the candidate picked, even when the
  // application itself landed under "50 Plus Other positions". Both
  // slugs are populated with the same value — they appear to be
  // separate custom fields per job category (general vs. VA-specific)
  // rather than alternatives, so filling both is the safe default.
  if (fields.position) {
    payload['whatpositionareyouapplyingfor'] = fields.position;
    payload['whatvapositionareyouapplyingfor'] = fields.position;
  }

  // Combine the two frontend fields into Manatal's one field. Both are
  // optional (only relevant if previous_sr_client === 'Yes'), so only
  // send this at all if the candidate actually filled in at least one
  // half — matches the field's own "Put N/A if not applicable" wording
  // for the case where just one half was answered.
  const clientName = fields.sr_client_name;
  const lastDay = fields.sr_client_last_day;
  if (clientName || lastDay) {
    payload[SR_CLIENT_SLUG] = `${clientName || 'N/A'} — ${lastDay || 'N/A'}`;
  }

  return payload;
}

/**
 * @param {{fields: Object, files: Object}} parsed - output of parseMultipart()
 * @returns {Promise<{candidateId: string|number, jobId: string, matchId: string|number}>}
 */
async function processSubmission({ fields, files }, progress = {}) {
  if (!MANATAL_TOKEN) {
    throw new Error('MANATAL_API_TOKEN is not set.');
  }

  // `progress` records which steps already succeeded so a retry resumes
  // where the last attempt died instead of repeating work (most
  // importantly: re-uploading attachments that already landed). It is
  // mutated in place and also attached to any thrown error as
  // `err.progress` so the caller can persist it.
  progress.attachments = progress.attachments || [];

  try {
    const jobId = mapPositionToJobId(fields.position);

    if (!progress.applied) {
      await applyToJob({
        token: MANATAL_TOKEN,
        clientSlug: CLIENT_SLUG,
        jobId,
        fullName: fields.full_name,
        email: fields.email,
        phone: fields.phone,
        linkedin: fields.linkedin_instagram_url,
        message: fields.skills_summary,
        resumeFile: files.resume_file,
      });
      progress.applied = true;
    }

    // /apply/'s response never contains a candidate id (confirmed via direct
    // testing — it's just {"status": "Candidate added to job"}), so we look
    // the candidate up by the email we just submitted.
    if (!progress.candidateId) {
      progress.candidateId = await findCandidateByEmail({ token: MANATAL_TOKEN, email: fields.email });
    }
    const candidateId = progress.candidateId;

    if (!progress.patched) {
      const customFields = buildCustomFieldsPayload(fields);
      if (Object.keys(customFields).length > 0) {
        await patchCandidateCustomFields({ token: MANATAL_TOKEN, candidateId, customFields });
      }
      progress.patched = true;
    }

    // Attachments go on the MATCH (this candidate's pairing with THIS
    // job), not the candidate's general record — see ATTACHMENT_FIELDS
    // comment above and findMostRecentMatch in manatal-client.js.
    if (!progress.matchId) {
      progress.matchId = await findMostRecentMatch({ token: MANATAL_TOKEN, candidateId });
    }
    const matchId = progress.matchId;

    for (const { field, label } of ATTACHMENT_FIELDS) {
      const file = files[field];
      if (file && !progress.attachments.includes(label)) {
        // 1. Validate against Manatal's constraints (5MB cap, PDF/DOC/DOCX/RTF)
        //    and convert images to PDF only if needed — see file-validator.js.
        const normalized = await validateAndNormalizeFile(file);
        // 2. Host the (possibly converted) bytes publicly — Manatal's
        //    attachment endpoint requires a URL, not raw bytes.
        const { url: fileUrl, key: hostedKey } = await hostAttachment(normalized);
        // 3. Send the URL, not the file itself.
        await uploadMatchAttachment({ token: MANATAL_TOKEN, matchId, fileUrl, label });
        progress.attachments.push(label);
        // 4. Manatal has confirmed it fetched the file — our hosted copy
        //    has no further purpose. Delete it now rather than leaving it
        //    publicly reachable; cleanup-hosted-attachments.js (3h purge)
        //    is only the fallback for whatever slips past this.
        await deleteHostedAttachment(hostedKey);
      }
    }

    return { candidateId, jobId, matchId };
  } catch (err) {
    err.progress = progress;
    throw err;
  }
}

module.exports = { processSubmission, buildCustomFieldsPayload, CUSTOM_FIELD_MAP };
