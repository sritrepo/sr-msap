// netlify/functions/submit.js
//
// Secure proxy — receives multipart/form-data (text fields + file uploads)
// from the application form and posts it DIRECTLY to Manatal. Zapier is
// no longer in the loop.
//
// Flow per submission:
//   1. Validate origin + content-type, decode body, enforce size cap.
//   2. Parse the multipart body into fields + files.
//   3. Map the selected position to a Manatal job_id.
//   4. POST to Manatal's career-page /apply/ endpoint (creates/finds the
//      candidate by email, attaches them to the job, uploads the resume).
//   5. PATCH the candidate's custom fields with the rest of the form's
//      answers, then upload the remaining files (gov ID, DISC, device
//      specs, speed test) as candidate attachments.
//   6. If ANY of steps 3-5 throw, the original raw submission is saved
//      untouched to Netlify Blobs (see lib/dead-letter-store.js) so
//      retry-failed-submissions.js can replay it later. The applicant
//      still gets a success response — we don't want a Manatal hiccup to
//      show up as a broken form on the client side.
//
// Required environment variables (Netlify dashboard):
//   MANATAL_API_TOKEN    — Manatal Open API bearer token (admin-only, from Manatal support)
//   MANATAL_CLIENT_SLUG  — defaults to "sphererocketva" if unset
//   ALLOWED_ORIGINS      — comma-separated allowed origins (optional)
//
// Dependencies to add to package.json: busboy, @netlify/blobs

const { parseMultipart } = require('./lib/multipart');
const { processSubmission } = require('./lib/process-submission');
const { saveFailedSubmission } = require('./lib/dead-letter-store');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Origin guard — leave ALLOWED_ORIGINS empty to allow all (fine during testing)
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((o) => o.trim()).filter(Boolean);

  const origin = (event.headers['origin'] || '').trim();
  const referer = (event.headers['referer'] || '').trim();

  if (allowedOrigins.length > 0) {
    const isAllowed = allowedOrigins.some((o) => origin.startsWith(o) || referer.startsWith(o));
    if (!isAllowed) {
      console.warn(`Blocked — origin: "${origin}"`);
      return { statusCode: 403, body: 'Forbidden: origin not allowed.' };
    }
  }

  const responseOrigin = allowedOrigins.find((o) => origin.startsWith(o)) || allowedOrigins[0] || '*';
  const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': responseOrigin };

  const contentType = event.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return { statusCode: 400, body: 'Expected multipart/form-data.' };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body || '', 'utf8');

  const MAX_BYTES = 5.5 * 1024 * 1024; // 5.5 MB hard ceiling
  if (rawBody.length > MAX_BYTES) {
    console.warn(`Payload too large: ${rawBody.length} bytes`);
    return {
      statusCode: 413,
      body: 'Payload too large. Please ensure all files are within the size limits.',
    };
  }

  let parsed;
  try {
    parsed = await parseMultipart(rawBody, contentType);
  } catch (err) {
    // A malformed body is a client-side problem, not something retrying
    // against Manatal would fix — fail fast instead of dead-lettering it.
    console.error('Multipart parse failed:', err.message);
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Malformed submission.' }) };
  }

  try {
    const { candidateId, jobId } = await processSubmission(parsed);
    console.log(`Manatal candidate ${candidateId} applied to job ${jobId}`);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('Manatal submission failed, dead-lettering:', err.message);
    try {
      await saveFailedSubmission({
        rawBody,
        contentType,
        errorMessage: err.message,
        candidateEmail: parsed.fields.email,
      });
    } catch (dlqErr) {
      // Worst case: Manatal AND Blobs both failed. Log loudly — this is
      // the one scenario that can actually lose an application.
      console.error('DEAD-LETTER WRITE FAILED — submission may be lost:', dlqErr.message, 'original error:', err.message);
    }

    // Still return success to the applicant: their submission is safely
    // queued for retry, and a visible error here just confuses candidates
    // with no ability to fix the underlying problem.
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
  }
};
