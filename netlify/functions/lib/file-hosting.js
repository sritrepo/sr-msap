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
 * @returns {Promise<string>} public URL Manatal can fetch the file from
 */
async function hostAttachment(file) {
  const store = getConfiguredStore(STORE_NAME);
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.filename}`;

  await store.set(key, file.buffer, {
    metadata: { contentType: file.contentType, filename: file.filename },
  });

  return `${SITE_URL}/.netlify/functions/get-attachment?key=${encodeURIComponent(key)}`;
}

module.exports = { hostAttachment, STORE_NAME };
