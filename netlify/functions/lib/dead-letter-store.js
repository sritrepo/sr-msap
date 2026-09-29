// netlify/functions/lib/dead-letter-store.js
//
// Zero-data-loss net: if a submission can't be delivered to Manatal
// (rate limited, outage, unexpected schema change, etc.), the ORIGINAL
// raw multipart body is stashed here — untouched, still containing every
// file — so retry-failed-submissions.js can replay it later through the
// exact same pipeline as a live request. This is a stopgap while the
// team decides on the longer-term error-handling approach.
//
// Requires: npm install @netlify/blobs
// Netlify Blobs is enabled by default on sites deployed via Netlify's Git
// integration — no extra provisioning needed.

const { getConfiguredStore } = require('./blobs-config');

const STORE_NAME = 'failed-submissions';

// Netlify Blobs has no built-in expiry, so retention is enforced by the
// scheduled retry job (it purges anything older than this). 48h = long
// enough to ride out a day-long Manatal outage plus a day to notice,
// short enough that gov IDs / resumes aren't sitting around for long.
// Override with FAILED_SUBMISSION_RETENTION_HOURS if ever needed.
const RETENTION_HOURS = Number(process.env.FAILED_SUBMISSION_RETENTION_HOURS) || 48;

function store() {
  return getConfiguredStore(STORE_NAME);
}

/**
 * @param {Object} params
 * @param {Buffer} params.rawBody       - original undecoded multipart body
 * @param {string} params.contentType   - original content-type header (has the boundary)
 * @param {string} params.errorMessage  - what went wrong, for triage
 * @param {string} [params.candidateEmail] - best-effort, for a human scanning the list
 * @returns {Promise<string>} the key the record was stored under
 */
async function saveFailedSubmission({ rawBody, contentType, errorMessage, candidateEmail, progress }) {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await store().setJSON(key, {
    contentType,
    bodyBase64: rawBody.toString('base64'),
    errorMessage,
    candidateEmail: candidateEmail || null,
    failedAt: new Date().toISOString(),
    attempts: 1,
    progress: progress || {},
  });

  return key;
}

async function listFailedSubmissions() {
  const { blobs } = await store().list();
  return blobs.map((b) => b.key);
}

async function getFailedSubmission(key) {
  return store().get(key, { type: 'json' });
}

async function deleteFailedSubmission(key) {
  return store().delete(key);
}

async function incrementAttempts(key, record, progress) {
  await store().setJSON(key, {
    ...record,
    attempts: (record.attempts || 1) + 1,
    progress: progress || record.progress || {},
  });
}

function isExpired(record) {
  const failedAt = Date.parse(record.failedAt);
  if (Number.isNaN(failedAt)) return false;
  return Date.now() - failedAt > RETENTION_HOURS * 60 * 60 * 1000;
}

module.exports = {
  saveFailedSubmission,
  listFailedSubmissions,
  getFailedSubmission,
  deleteFailedSubmission,
  incrementAttempts,
  isExpired,
  RETENTION_HOURS,
};
