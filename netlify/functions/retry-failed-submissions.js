// netlify/functions/retry-failed-submissions.js
//
// Runs on a schedule (default: every 15 minutes) and replays every
// submission sitting in the Netlify Blobs dead-letter store through the
// exact same pipeline submit.js uses. Successes are removed from the
// store; failures increment an attempt counter and stay queued.
//
// Records are retried every run for RETENTION_HOURS (48h, see
// lib/dead-letter-store.js), then purged. Each record remembers which
// Manatal steps already succeeded (apply / custom fields / each
// attachment) so a retry never repeats completed work.
//
// Dependencies to add to package.json: @netlify/functions, @netlify/blobs, busboy
//
// Netlify config needed in netlify.toml:
//   [functions."retry-failed-submissions"]
//     schedule = "*/15 * * * *"

const { schedule } = require('@netlify/functions');
const { parseMultipart } = require('./lib/multipart');
const { processSubmission } = require('./lib/process-submission');
const {
  listFailedSubmissions,
  getFailedSubmission,
  deleteFailedSubmission,
  incrementAttempts,
  isExpired,
  RETENTION_HOURS,
} = require('./lib/dead-letter-store');


async function retryOne(key) {
  const record = await getFailedSubmission(key);
  if (!record) return;

  // Retention: keep retrying every run until the record is older than
  // RETENTION_HOURS, then purge it. Nothing is retried forever and
  // nothing lingers (these records contain resumes / gov IDs).
  if (isExpired(record)) {
    console.error(
      `PURGING ${key} (${record.candidateEmail || 'unknown email'}) — older than ${RETENTION_HOURS}h and never delivered. ` +
      `Last error: ${record.errorMessage}`
    );
    await deleteFailedSubmission(key);
    return;
  }

  const progress = record.progress || {};
  try {
    const rawBody = Buffer.from(record.bodyBase64, 'base64');
    const parsed = await parseMultipart(rawBody, record.contentType);
    const { candidateId, jobId } = await processSubmission(parsed, progress);

    console.log(`Retry succeeded for ${key} — candidate ${candidateId} applied to job ${jobId}`);
    await deleteFailedSubmission(key);
  } catch (err) {
    const attempts = (record.attempts || 1) + 1;
    console.warn(`Retry ${attempts} failed for ${key} (${record.candidateEmail || 'unknown email'}): ${err.message}`);
    // Persist whatever steps DID succeed this time so the next run resumes after them.
    await incrementAttempts(key, { ...record, errorMessage: err.message }, err.progress || progress);
  }
}

const handler = async () => {
  const keys = await listFailedSubmissions();
  console.log(`retry-failed-submissions: ${keys.length} queued`);

  for (const key of keys) {
    // Sequential on purpose — avoids hammering Manatal's rate limit with
    // a burst of retries all at once.
    await retryOne(key);
  }

  return { statusCode: 200 };
};

exports.handler = schedule('*/15 * * * *', handler);
