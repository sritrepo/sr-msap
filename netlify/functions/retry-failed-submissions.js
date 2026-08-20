// netlify/functions/retry-failed-submissions.js
//
// Runs on a schedule (default: every 15 minutes) and replays every
// submission sitting in the Netlify Blobs dead-letter store through the
// exact same pipeline submit.js uses. Successes are removed from the
// store; failures increment an attempt counter and stay queued.
//
// After MAX_ATTEMPTS, a record is left in place (not deleted) but logged
// as needing a human — this is the stopgap the team should replace once
// a longer-term alerting approach (e.g. Slack/email on give-up) is
// decided.
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
} = require('./lib/dead-letter-store');

const MAX_ATTEMPTS = 6; // ~90 min of retries at a 15-min schedule

async function retryOne(key) {
  const record = await getFailedSubmission(key);
  if (!record) return;

  try {
    const rawBody = Buffer.from(record.bodyBase64, 'base64');
    const parsed = await parseMultipart(rawBody, record.contentType);
    const { candidateId, jobId } = await processSubmission(parsed);

    console.log(`Retry succeeded for ${key} — candidate ${candidateId} applied to job ${jobId}`);
    await deleteFailedSubmission(key);
  } catch (err) {
    const attempts = (record.attempts || 1) + 1;
    console.warn(`Retry ${attempts} failed for ${key} (${record.candidateEmail || 'unknown email'}): ${err.message}`);

    if (attempts >= MAX_ATTEMPTS) {
      console.error(
        `GIVING UP after ${attempts} attempts on ${key} (${record.candidateEmail || 'unknown email'}). ` +
        `Record retained in Blobs for manual recovery — this needs a human.`
      );
    }
    await incrementAttempts(key, record);
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
