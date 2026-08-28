// netlify/functions/lib/process-submission.js
//
// The actual "do the migration to Manatal" logic, factored out of the
// HTTP handler so retry-failed-submissions.js can run the identical
// pipeline against a replayed payload.

const { mapPositionToJobId } = require('./job-mapping');
const {
  applyToJob,
  findCandidateByEmail,
  patchCandidateCustomFields,
  uploadCandidateAttachment,
} = require('./manatal-client');
const { validateAndNormalizeFile } = require('./file-validator');
const { hostAttachment } = require('./file-hosting');

const MANATAL_TOKEN = process.env.MANATAL_API_TOKEN;
const CLIENT_SLUG = process.env.MANATAL_CLIENT_SLUG || 'sphererocketva';

// Non-resume file fields we also want attached to the candidate record.
// Label is what shows up as the attachment name in Manatal.
const ATTACHMENT_FIELDS = [
  { field: 'gov_id_file', label: 'Government ID' },
  { field: 'disc_file', label: 'DISC Assessment' },
  { field: 'device_specs_file', label: 'Device Specs' },
  { field: 'speed_test_file', label: 'Internet Speed Test' },
];

// Maps our form field names to Manatal custom_fields slugs.
// FILL THESE IN once the corresponding custom fields exist in your
// Manatal account (Settings > Custom Fields) — see MIGRATION_GUIDE.md.
// Left blank/commented keys are simply skipped, so it's safe to enable
// these incrementally.
const CUSTOM_FIELD_MAP = {
  // has_va_experience:      'has_va_experience',
  // previous_sr_client:     'previous_sr_client',
  // va_training:            'va_training',
  // va_training_details:    'va_training_details',
  // computer_type:          'computer_type',
  // backup_power_internet:  'backup_power_internet',
  // weekly_hours:           'weekly_hours',
  // rest_days:              'rest_days',
  // contract_type:          'contract_type',
  // gov_id_type:            'gov_id_type',
  // disc_style:             'disc_style',
  // min_rate:               'min_rate',
  // max_rate:               'max_rate',
  // tools_used:             'tools_used',
  // other_languages:        'other_languages',
  // college_degree:         'college_degree',
  // portfolio_url:          'portfolio_url',
  // referral_source:        'referral_source',
  // internal_referral:      'internal_referral',
  // previous_client_industry: 'previous_client_industry',
  // sr_client_name:         'sr_client_name',
  // sr_client_last_day:     'sr_client_last_day',
  // emergency_contact_name:   'emergency_contact_name',
  // emergency_contact_number: 'emergency_contact_number',
  // alternative_phone:      'alternative_phone',
  // facebook_url:           'facebook_url',
  // complete_address:       'complete_address',
};

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

function buildCustomFieldsPayload(fields) {
  const payload = { ...AUTO_AGREE_CUSTOM_FIELDS };
  for (const [formField, manatalSlug] of Object.entries(CUSTOM_FIELD_MAP)) {
    if (fields[formField] !== undefined && fields[formField] !== '') {
      payload[manatalSlug] = fields[formField];
    }
  }
  return payload;
}

/**
 * @param {{fields: Object, files: Object}} parsed - output of parseMultipart()
 * @returns {Promise<{candidateId: string|number, jobId: string}>}
 */
async function processSubmission({ fields, files }) {
  if (!MANATAL_TOKEN) {
    throw new Error('MANATAL_API_TOKEN is not set.');
  }

  const jobId = mapPositionToJobId(fields.position);

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

  // /apply/'s response never contains a candidate id (confirmed via direct
  // testing — it's just {"status": "Candidate added to job"}), so we look
  // the candidate up by the email we just submitted.
  const candidateId = await findCandidateByEmail({ token: MANATAL_TOKEN, email: fields.email });

  const customFields = buildCustomFieldsPayload(fields);
  if (Object.keys(customFields).length > 0) {
    await patchCandidateCustomFields({ token: MANATAL_TOKEN, candidateId, customFields });
  }

  for (const { field, label } of ATTACHMENT_FIELDS) {
    const file = files[field];
    if (file) {
      // 1. Validate against Manatal's constraints (5MB cap, PDF/DOC/DOCX/RTF)
      //    and convert images to PDF only if needed — see file-validator.js.
      const normalized = await validateAndNormalizeFile(file);
      // 2. Host the (possibly converted) bytes publicly — Manatal's
      //    attachment endpoint requires a URL, not raw bytes.
      const fileUrl = await hostAttachment(normalized);
      // 3. Send the URL, not the file itself.
      await uploadCandidateAttachment({ token: MANATAL_TOKEN, candidateId, fileUrl, label });
    }
  }

  return { candidateId, jobId };
}

module.exports = { processSubmission, buildCustomFieldsPayload, CUSTOM_FIELD_MAP };
