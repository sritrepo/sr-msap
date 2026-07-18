// netlify/functions/submit.js
//
// Secure proxy — receives multipart/form-data (text fields + file uploads)
// from the application form and forwards everything directly to Zapier.
//
// File size caps enforced on the client keep the total payload under
// Netlify's 6MB function body limit:
//   resume_file       2 MB
//   gov_id_file       1 MB
//   disc_file         500 KB
//   device_specs_file 500 KB
//   speed_test_file   500 KB
//   ─────────────────────────
//   Worst case total  ~4.5 MB  (well under the 6 MB limit)
//
// Required environment variables (Netlify dashboard):
//   ZAPIER_WEBHOOK_URL   — Zapier catch hook URL (never in client code)
//   CHILD_KEY            — secret checked by Zapier Filter step
//   ALLOWED_ORIGINS      — comma-separated allowed origins (optional)

const https = require('https');
const http  = require('http');
const { URL } = require('url');

function forwardToZapier(webhookUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(webhookUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers,
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {

  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Secrets — never exposed to browser
  const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
  const CHILD_KEY          = process.env.CHILD_KEY || '';

  if (!ZAPIER_WEBHOOK_URL) {
    console.error('ZAPIER_WEBHOOK_URL is not set.');
    return { statusCode: 500, body: 'Server configuration error: missing webhook URL.' };
  }

  // Origin guard — leave ALLOWED_ORIGINS empty to allow all (fine during testing)
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(o => o.trim()).filter(Boolean);

  const origin  = (event.headers['origin']  || '').trim();
  const referer = (event.headers['referer'] || '').trim();

  if (allowedOrigins.length > 0) {
    const isAllowed = allowedOrigins.some(
      o => origin.startsWith(o) || referer.startsWith(o)
    );
    if (!isAllowed) {
      console.warn(`Blocked — origin: "${origin}"`);
      return { statusCode: 403, body: 'Forbidden: origin not allowed.' };
    }
  }

  const responseOrigin =
    allowedOrigins.find(o => origin.startsWith(o)) || allowedOrigins[0] || '*';

  // Validate content-type
  const contentType = event.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return { statusCode: 400, body: 'Expected multipart/form-data.' };
  }

  // Decode body — Netlify base64-encodes binary (multipart with files)
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body || '', 'utf8');

  // Server-side size guard (backup — client already validates)
  const MAX_BYTES = 5.5 * 1024 * 1024; // 5.5 MB hard ceiling
  if (rawBody.length > MAX_BYTES) {
    console.warn(`Payload too large: ${rawBody.length} bytes`);
    return {
      statusCode: 413,
      body: 'Payload too large. Please ensure all files are within the size limits.',
    };
  }

  // Forward to Zapier — preserve Content-Type with boundary so Zapier parses files
  const forwardHeaders = {
    'Content-Type':   contentType,
    'Content-Length': rawBody.length,
    'X-Child-Key':    CHILD_KEY,
    'X-Source':       'sphere-rocket-va-form',
    'User-Agent':     'SphereRocketVA-Proxy/1.0',
  };

  try {
    const result = await forwardToZapier(ZAPIER_WEBHOOK_URL, forwardHeaders, rawBody);

    if (result.status >= 200 && result.status < 300) {
      console.log('Zapier accepted submission — status:', result.status);
      return {
        statusCode: 200,
        headers: {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': responseOrigin,
        },
        body: JSON.stringify({ success: true }),
      };
    } else {
      console.error('Zapier error:', result.status, result.body);
      return { statusCode: 502, body: `Zapier error: ${result.status}` };
    }

  } catch (err) {
    console.error('Failed to reach Zapier:', err.message);
    return { statusCode: 500, body: 'Internal server error: could not reach webhook.' };
  }
};
