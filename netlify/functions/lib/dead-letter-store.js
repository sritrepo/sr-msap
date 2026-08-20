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

const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'failed-submissions';

function store() {
  return getStore(STORE_NAME);
}

/**
 * @param {Object} params
 * @param {Buffer} params.rawBody       - original undecoded multipart body
 * @param {string} params.contentType   - original content-type header (has the boundary)
 * @param {string} params.errorMessage  - what went wrong, for triage
 * @param {string} [params.candidateEmail] - best-effort, for a human scanning the list
 * @returns {Promise<string>} the key the record was stored under
 */
async function saveFailedSubmission({ rawBody, contentType, errorMessage, candidateEmail }) {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await store().setJSON(key, {
    contentType,
    bodyBase64: rawBody.toString('base64'),
    errorMessage,
    candidateEmail: candidateEmail || null,
    failedAt: new Date().toISOString(),
    attempts: 1,
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

async function incrementAttempts(key, record) {
  await store().setJSON(key, { ...record, attempts: (record.attempts || 1) + 1 });
}

module.exports = {
  saveFailedSubmission,
  listFailedSubmissions,
  getFailedSubmission,
  deleteFailedSubmission,
  incrementAttempts,
};
