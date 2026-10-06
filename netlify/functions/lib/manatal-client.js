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

/**
 * CONFIRMED (Aug 2026, via direct curl test): /apply/'s success response
 * is just {"status": "Candidate added to job"} — it NEVER returns a
 * candidate id, under any response shape. The previous extractCandidateId()
 * guessed at candidate.id/candidate_id/id and correctly failed loud when
 * none matched — that failure is what told us the real shape.
 *
 * Fix: look the candidate up by email right after creating them.
 * /candidates/ (the authenticated Open API, not career-page) supports
 * `email` as an exact-match query param per Manatal's docs.
 */
async function findCandidateByEmail({ token, email }) {
  const url = `${API_ROOT}/candidates/?email=${encodeURIComponent(email)}`;
  const res = await requestWithRetry(url, {
    method: 'GET',
    headers: authHeaders(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Manatal candidate lookup failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const json = await res.json();
  const candidate = json?.results?.[0];

  if (!candidate?.id) {
    throw new Error(`No candidate found for email "${email}" after /apply/ — got ${json?.count ?? 0} results.`);
  }

  return candidate.id;
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

  // NOTE (Aug 2026): deliberately NOT sending an Authorization header here.
  // /career-page/.../apply/ is a public, unauthenticated candidate
  // self-apply endpoint — Manatal's own docs list only 400/404/500 as
  // possible responses, never 401/403, and the sibling /jobs/ and
  // /application-form/ endpoints under the same career-page path already
  // work with zero auth. Sending our admin-scoped MANATAL_API_TOKEN here
  // caused a 403 "You do not have permission to perform this action" —
  // consistent with a valid token being rejected for an action it was
  // never meant to authorize, not a credentials problem.
  const url = `${API_ROOT}/career-page/${clientSlug}/jobs/${jobId}/apply/`;
  const res = await requestWithRetry(url, {
    method: 'POST',
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

  // No candidate id in this response by design — caller must look it up
  // via findCandidateByEmail() using the same email.
  return { raw: json };
}

/**
 * Finds the match (candidate-to-job pairing) created by the /apply/ call,
 * so attachments can be filed under the SPECIFIC job rather than the
 * candidate's general record (Kyle, Oct 1 2026 — tailored per-role resumes
 * were landing as general candidate attachments instead of under the job
 * they were submitted for, defeating the point of tailoring them).
 *
 * /apply/'s response doesn't include a match id (same gap as the
 * candidate id — see findCandidateByEmail above), so this looks it up via
 * /candidates/{id}/matches/ and picks the one with the latest
 * submitted_at. ASSUMPTION TO VERIFY: this assumes the match we just
 * created is the most recently submitted one for this candidate, which
 * holds unless the same candidate has two applications landing within
 * the same request cycle (unlikely, but worth confirming with one real
 * multi-application test if a candidate ever applies twice in quick
 * succession — e.g. immediately re-submitting with a tailored resume).
 * Retries a few times with a short delay in case the match record lags
 * slightly behind the /apply/ response (not documented either way by
 * Manatal, so treating it as a possibility rather than assuming
 * perfectly synchronous consistency).
 */
async function findMostRecentMatch({ token, candidateId }) {
  const url = `${API_ROOT}/candidates/${candidateId}/matches/?page_size=50`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await requestWithRetry(url, { method: 'GET', headers: authHeaders(token) });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Manatal match lookup failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const json = await res.json();
    const matches = json?.results || [];

    if (matches.length > 0) {
      const mostRecent = matches.reduce((latest, m) => {
        const mTime = Date.parse(m.submitted_at || m.created_at || 0);
        const latestTime = Date.parse(latest.submitted_at || latest.created_at || 0);
        return mTime > latestTime ? m : latest;
      });
      return mostRecent.id;
    }

    if (attempt < 3) await sleep(400 * attempt);
  }

  throw new Error(`No match found for candidate ${candidateId} after /apply/ — expected at least one.`);
}

/**
 * CRITICAL (confirmed via Manatal's own docs, developers.manatal.com/
 * reference/custom-fields): custom_fields is stored as ONE JSON blob, and
 * PATCHing it performs a FULL OVERWRITE — not a merge. Sending only our
 * form's fields would silently destroy anything already on the record
 * (recruiter notes, data from a prior application, anything set manually
 * in the Manatal UI). This matters concretely for us: "Reapplication
 * Opportunity" is one of our actual job posts, so returning candidates
 * with existing custom_fields data are an expected case, not an edge case.
 */
async function getCandidate({ token, candidateId }) {
  const url = `${API_ROOT}/candidates/${candidateId}/`;
  const res = await requestWithRetry(url, {
    method: 'GET',
    headers: authHeaders(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Manatal candidate lookup by id failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json();
}

/**
 * Writes the form's non-standard answers onto the candidate's custom
 * fields. `fieldMap` maps our internal field names to the Manatal custom
 * field slugs configured in your account (Settings > Custom Fields) —
 * fill these in once you've created/confirmed the fields on your end;
 * see MIGRATION_GUIDE.md.
 *
 * SAFE BY DESIGN: fetches the candidate's current custom_fields first and
 * merges our new values into it, rather than overwriting the whole
 * object — see getCandidate() above for why this is mandatory, not
 * optional, per Manatal's own documented overwrite behavior.
 */
async function patchCandidateCustomFields({ token, candidateId, customFields }) {
  const candidate = await getCandidate({ token, candidateId });
  const existingCustomFields = candidate?.custom_fields || {};

  const mergedCustomFields = { ...existingCustomFields, ...customFields };

  const url = `${API_ROOT}/candidates/${candidateId}/`;
  const res = await requestWithRetry(url, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom_fields: mergedCustomFields }),
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
// Manatal fetches `file` from OUR hosting URL (get-attachment.js) when an
// attachment is created — it's not a bytes upload, just a URL we hand
// over. Confirmed in production (Oct 5 2026) that this fetch can time out
// on Manatal's side, specifically: {"file":{"detail":"Could not fetch the
// file from the provided URL (timeout)."}}. This is a 400 (so
// requestWithRetry's generic 429/5xx retry never catches it), and it's
// almost certainly our own hosting endpoint being slow to answer (Blobs
// propagation lag / cold start) rather than a real bad request — so it's
// retried a few times here specifically, instead of broadening
// requestWithRetry to retry all 400s (a genuinely malformed request, e.g.
// a bad file type, SHOULD fail immediately, not waste three attempts).
const FETCH_TIMEOUT_PATTERN = /could not fetch the file from the provided url/i;

async function postAttachment(url, token, name, fileUrl, context) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await requestWithRetry(url, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || 'Attachment', file: fileUrl }),
    });

    if (res.ok) return res.json();

    const text = await res.text();
    const isFetchTimeout = res.status === 400 && FETCH_TIMEOUT_PATTERN.test(text);

    if (isFetchTimeout && attempt < 3) {
      await sleep(600 * attempt);
      continue;
    }

    throw new Error(`${context} (${res.status}): ${text.slice(0, 500)}`);
  }
}

async function uploadCandidateAttachment({ token, candidateId, fileUrl, label }) {
  const url = `${API_ROOT}/candidates/${candidateId}/attachments/`;
  return postAttachment(url, token, label, fileUrl, `Manatal attachment upload failed for "${label}"`);
}

/**
 * Uploads a file as an attachment on a specific MATCH (candidate-to-job
 * pairing) rather than the candidate's general record — see
 * findMostRecentMatch above for why this matters. Same request shape as
 * uploadCandidateAttachment (JSON body, `file` is a hosted URL, not raw
 * bytes), just a different path:
 * developers.manatal.com/reference/matches_attachments_create
 */
async function uploadMatchAttachment({ token, matchId, fileUrl, label }) {
  const url = `${API_ROOT}/matches/${matchId}/attachments/`;
  return postAttachment(url, token, label, fileUrl, `Manatal match attachment upload failed for "${label}"`);
}

module.exports = {
  applyToJob,
  findCandidateByEmail,
  findMostRecentMatch,
  getCandidate,
  patchCandidateCustomFields,
  uploadCandidateAttachment,
  uploadMatchAttachment,
};
