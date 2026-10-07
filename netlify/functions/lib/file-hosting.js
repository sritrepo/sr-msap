// netlify/functions/lib/file-hosting.js
//
// Manatal's attachment upload needs a public URL, not raw bytes (see
// file-validator.js header for the doc citation). This stores the
// validated/converted file in its OWN Blobs store — separate from
// dead-letter-store.js's `failed-submissions` store, which exists for a
// different purpose (replaying whole raw submissions) — and returns the
// URL that get-attachment.js serves.
//
// Requires: npm install @netlify/blobs

const { getConfiguredStore } = require('./blobs-config');

const STORE_NAME = 'candidate-attachments';

// Netlify sets URL/DEPLOY_PRIME_URL automatically at runtime. The fallback
// is your confirmed live embed domain (from testing.html) in case this
// ever runs somewhere those env vars aren't set.
const SITE_URL =
  process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://jovial-trifle-9a780d.netlify.app';

/**
 * @param {{filename: string, contentType: string, buffer: Buffer}} file
 * @returns {Promise<{url: string, key: string}>} public URL Manatal can
 *   fetch the file from, plus the storage key so the caller can delete it
 *   immediately once Manatal confirms it has successfully fetched the
 *   file (see deleteHostedAttachment below) — no reason to keep a copy
 *   around once Manatal has its own. cleanup-hosted-attachments.js is
 *   the safety net for anything that doesn't get explicitly cleaned up.
 */
async function hostAttachment(file) {
  const store = getConfiguredStore(STORE_NAME);
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.filename}`;

  await store.set(key, file.buffer, {
    metadata: { contentType: file.contentType, filename: file.filename },
  });

  return {
    url: `${SITE_URL}/.netlify/functions/get-attachment?key=${encodeURIComponent(key)}`,
    key,
  };
}

/**
 * Deletes a hosted file immediately after Manatal has confirmed it
 * successfully fetched it (Oct 6 2026 — candidate-attachments previously
 * had no cleanup at all, meaning every resume/gov ID/etc. that ever
 * passed through stayed publicly hosted forever). Best-effort: a failed
 * delete here isn't worth failing the whole submission over, since the
 * 3-hour scheduled purge (cleanup-hosted-attachments.js) will catch it
 * anyway.
 */
async function deleteHostedAttachment(key) {
  try {
    const store = getConfiguredStore(STORE_NAME);
    await store.delete(key);
  } catch (err) {
    console.warn(`deleteHostedAttachment: failed to delete "${key}" — will be caught by the 3h scheduled purge instead. ${err.message}`);
  }
}

module.exports = { hostAttachment, deleteHostedAttachment, STORE_NAME };
