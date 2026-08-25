// netlify/functions/lib/process-submission.js
//
// The actual "do the migration to Manatal" logic, factored out of the
// HTTP handler so retry-failed-submissions.js can run the identical
// pipeline against a replayed payload.

const { mapPositionToJobId } = require('./job-mapping');
const {
  applyToJob,
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

function buildCustomFieldsPayload(fields) {
  const payload = {};
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

  const { candidateId } = await applyToJob({
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
