// netlify/functions/lib/manatal-client.js
//
// Minimal client for the pieces of the Manatal V3 API this integration
// needs. Uses global fetch/FormData/Blob, so Netlify's Node runtime must
// be >= 18 (set in netlify.toml: [functions] node_bundler / or
// environment NODE_VERSION = "18" or higher).
//
// Docs referenced:
//   Auth:            https://developers.manatal.com/reference/authorization
//   Career page apply: https://developers.manatal.com/reference/career-page_jobs_apply_for_job
//   Candidate patch:  https://developers.manatal.com/reference/candidates_partial_update
//   Attachments:      https://developers.manatal.com/reference/candidates_attachments_create
//
// NOTE ON ASSUMPTIONS (verify against your token in Postman before go-live,
// per Manatal's own "Testing with Postman" guide — their published docs
// don't show the exact response body shape for the apply endpoint):
//   - We assume the /apply/ response includes the candidate id under one
//     of `candidate.id`, `candidate_id`, or `id`. `extractCandidateId`
//     below tries all three and throws a clear error if none match, so a
//     schema surprise fails loud instead of silently dropping the
//     follow-up custom-field/attachment calls.
//
// FIXED (Aug 2026): uploadCandidateAttachment() previously sent a binary
// Blob for `file`, but Manatal's docs specify `file` as a URL string —
// this was very likely why attachments weren't landing correctly. It now
// takes `fileUrl` (see lib/file-hosting.js for how files get a public URL
// before this is called) and sends JSON instead of multipart.

const API_ROOT = 'https://api.manatal.com/open/v3';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry(url, options, attempt = 1) {
  const res = await fetch(url, options);

  if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
    const retryAfterHeader = res.headers.get('retry-after');
    const backoffMs = retryAfterHeader
      ? Number(retryAfterHeader) * 1000
      : 500 * 2 ** attempt; // 1s, 2s, 4s...
    await sleep(backoffMs);
    return requestWithRetry(url, options, attempt + 1);
  }

  return res;
}

function authHeaders(token) {
  return { Authorization: `Token ${token}` };
}

function extractCandidateId(applyResponseJson) {
  const id =
    applyResponseJson?.candidate?.id ??
    applyResponseJson?.candidate_id ??
    applyResponseJson?.id;

  if (!id) {
    throw new Error(
      `Could not find candidate id in Manatal /apply/ response. Got keys: ${Object.keys(
        applyResponseJson || {}
      ).join(', ')}`
    );
  }
  return id;
}

/**
 * Creates/finds the candidate by email and attaches them to the job,
 * uploading the resume in the same request.
 */
async function applyToJob({ token, clientSlug, jobId, fullName, email, phone, linkedin, message, resumeFile }) {
  const form = new FormData();
  form.set('full_name', fullName || '');
  form.set('email', email || '');
  if (phone) form.set('phone_number', phone);
  if (linkedin) form.set('linkedin', linkedin);
  if (message) form.set('message', message);

  if (resumeFile) {
    form.set(
      'resume',
      new Blob([resumeFile.buffer], { type: resumeFile.contentType }),
      resumeFile.filename
    );
  }

  const url = `${API_ROOT}/career-page/${clientSlug}/jobs/${jobId}/apply/`;
  const res = await requestWithRetry(url, {
    method: 'POST',
    headers: authHeaders(token),
    body: form,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(`Manatal /apply/ failed (${res.status}): ${text.slice(0, 500)}`);
  }

  return { candidateId: extractCandidateId(json || {}), raw: json };
}

/**
 * Writes the form's non-standard answers onto the candidate's custom
 * fields. `fieldMap` maps our internal field names to the Manatal custom
 * field slugs configured in your account (Settings > Custom Fields) —
 * fill these in once you've created/confirmed the fields on your end;
 * see MIGRATION_GUIDE.md.
 */
async function patchCandidateCustomFields({ token, candidateId, customFields }) {
  const url = `${API_ROOT}/candidates/${candidateId}/`;
  const res = await requestWithRetry(url, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom_fields: customFields }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Manatal candidate PATCH failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json();
}

/**
 * Uploads a single non-resume file (gov ID, DISC result, device specs,
 * speed test) as a candidate attachment.
 *
 * IMPORTANT: per Manatal's docs (developers.manatal.com/reference/
 * candidates_attachments_create), the `file` param is documented as
 * "Url leading to the attachment file" — a URL STRING, not a binary
 * upload. This was previously sending a multipart Blob, which the API
 * likely rejected or silently mishandled. `fileUrl` must be a public URL
 * the file is already hosted at (see lib/file-hosting.js) — this
 * function does not upload bytes itself.
 */
async function uploadCandidateAttachment({ token, candidateId, fileUrl, label }) {
  const url = `${API_ROOT}/candidates/${candidateId}/attachments/`;
  const res = await requestWithRetry(url, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: label || 'Attachment', file: fileUrl }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Manatal attachment upload failed for "${label}" (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json();
}

module.exports = { applyToJob, patchCandidateCustomFields, uploadCandidateAttachment, extractCandidateId };
