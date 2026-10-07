// netlify/functions/cleanup-hosted-attachments.js
//
// Safety net for the candidate-attachments Blobs store (file-hosting.js /
// get-attachment.js). Every file hosted there is meant to be deleted
// immediately once Manatal confirms it fetched it (see
// deleteHostedAttachment in process-submission.js) — this job is only for
// whatever slips through that: a crashed invocation, a submission that
// failed before Manatal ever got to fetch the file, or the delete call
// itself failing.
//
// Deliberately a SHORT window (3h), not the 48h used for failed
// submissions — a retry re-hosts a fresh copy from the raw bytes already
// safely stored in the failed-submissions dead-letter record, so nothing
// here ever needs to survive that long. 3h is just a generous buffer past
// the ~1h Manatal needs, to comfortably ride out any brief downtime on
// Manatal's end (Kyle, Oct 6 2026).
//
// Every file in this store is applicant PII (resumes, government IDs,
// DISC results) sitting on a public, unauthenticated URL — the whole
// point of this job is making sure that window stays small.

const { schedule } = require('@netlify/functions');
const { getConfiguredStore } = require('./lib/blobs-config');
const { STORE_NAME } = require('./lib/file-hosting');

const MAX_AGE_HOURS = 3;

function parseTimestampFromKey(key) {
  const [prefix] = key.split('-');
  const ts = Number(prefix);
  return Number.isFinite(ts) ? ts : null;
}

const handler = async () => {
  const store = getConfiguredStore(STORE_NAME);
  const { blobs } = await store.list();

  const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
  let deleted = 0;
  let skippedUnparseable = 0;

  for (const { key } of blobs) {
    const ts = parseTimestampFromKey(key);

    if (ts === null) {
      // Shouldn't happen given hostAttachment()'s key format, but if the
      // format ever changes, fail safe by leaving it rather than
      // guessing — log it so it's visible, not silently ignored.
      skippedUnparseable++;
      continue;
    }

    if (ts < cutoff) {
      await store.delete(key);
      deleted++;
    }
  }

  console.log(
    `cleanup-hosted-attachments: deleted ${deleted} file(s) older than ${MAX_AGE_HOURS}h` +
    (skippedUnparseable > 0 ? `, skipped ${skippedUnparseable} with unparseable key(s) — needs a look` : '')
  );

  return { statusCode: 200 };
};

// Runs hourly — no need to match the 15-min retry cadence, this is just
// trimming a safety margin, not racing anything.
exports.handler = schedule('0 * * * *', handler);
