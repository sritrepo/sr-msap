// netlify/functions/get-attachment.js
//
// Serves a file stored by lib/file-hosting.js publicly, so Manatal can
// download it after we PATCH the attachment URL to a candidate. No auth —
// this has to be reachable by Manatal's servers, not just the browser.
//
// Per Manatal's docs, the file must stay downloadable for at least an
// hour and must NOT redirect to an HTML page (their downloader isn't a
// browser). This returns the raw bytes directly with the correct
// Content-Type, no redirects, no login wall — satisfies both.
//
// Requires: npm install @netlify/blobs

const { getConfiguredStore } = require('./lib/blobs-config');
const { STORE_NAME } = require('./lib/file-hosting');

// Keys are always written by file-hosting.js in this exact shape:
// <timestamp>-<6 random base36 chars>-<original filename>
const KEY_PATTERN = /^\d+-[a-z0-9]{6}-.+$/;

exports.handler = async (event) => {
  const key = event.queryStringParameters && event.queryStringParameters.key;

  if (!key || !KEY_PATTERN.test(key)) {
    return { statusCode: 400, body: 'Invalid or missing file key' };
  }

  const store = getConfiguredStore(STORE_NAME);

  const [blob, metadata] = await Promise.all([
    store.get(key, { type: 'arrayBuffer' }),
    store.getMetadata(key),
  ]);

  if (!blob) {
    // Plain-text 404, not an HTML error page — Manatal's downloader
    // should get a clean failure, never something that looks fetchable.
    return { statusCode: 404, body: 'File not found' };
  }

  const contentType = (metadata && metadata.metadata && metadata.metadata.contentType) || 'application/octet-stream';
  const filename = (metadata && metadata.metadata && metadata.metadata.filename) || 'attachment';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'public, max-age=3600',
    },
    body: Buffer.from(blob).toString('base64'),
    isBase64Encoded: true,
  };
};
