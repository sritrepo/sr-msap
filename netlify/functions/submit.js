// netlify/functions/submit.js
//
// Secure proxy between the application form and the Zapier webhook.
// The ZAPIER_WEBHOOK_URL and CHILD_KEY are stored as Netlify Environment
// Variables — they are NEVER visible in the browser or page source.
//
// Flow:
//   Browser (multipart FormData)
//     → /.netlify/functions/submit  (this file, runs server-side)
//       → Zapier Catch Hook (with files + all fields)
//         → Manatal "Create Candidate" action

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ─── Helper: forward a multipart/form-data request to Zapier ──────────────
// Netlify Functions receive the raw body as a Buffer (base64 when binary).
// We re-stream it directly to Zapier preserving the original Content-Type
// header (which contains the multipart boundary Zapier needs to parse files).

function forwardRequest(targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  // ── 1. Only accept POST requests ────────────────────────────────────────
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── 2. Pull secrets from environment variables (never from client) ───────
  const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
  const CHILD_KEY          = process.env.CHILD_KEY;

  if (!ZAPIER_WEBHOOK_URL) {
    console.error('ZAPIER_WEBHOOK_URL environment variable is not set.');
    return { statusCode: 500, body: 'Server configuration error.' };
  }

  // ── 3. Basic origin / referrer guard (optional but recommended) ──────────
  // Rejects submissions not coming from your own domain.
  // Update ALLOWED_ORIGIN to match your Netlify site URL or custom domain.
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // e.g. https://apply.sphererocketva.com
  const origin  = event.headers['origin']  || '';
  const referer = event.headers['referer'] || '';

  if (ALLOWED_ORIGIN && !origin.startsWith(ALLOWED_ORIGIN) && !referer.startsWith(ALLOWED_ORIGIN)) {
    return { statusCode: 403, body: 'Forbidden: Origin not allowed.' };
  }

  // ── 4. Rate-limit hint (Netlify handles this via netlify.toml, see below) ─
  // For extra server-side rate limiting you can integrate a KV store or
  // upstash/redis — but for a low-traffic recruitment form, netlify.toml
  // rate limiting is sufficient.

  // ── 5. Forward the multipart body to Zapier ──────────────────────────────
  // event.body is the raw body string; event.isBase64Encoded tells us
  // whether Netlify base64-encoded it (it will for binary/multipart).
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body || '', 'utf8');

  // Build forwarding headers — keep Content-Type (with boundary) intact
  // and inject the child_key as a custom header for Zapier filter
  const forwardHeaders = {
    'Content-Type':   event.headers['content-type'] || 'multipart/form-data',
    'Content-Length': rawBody.length,
    'X-Child-Key':    CHILD_KEY || '',           // Zapier filter can check this header
    'X-Source':       'sphere-rocket-va-form',
    'User-Agent':     'SphereRocketVA-Form/1.0',
  };

  try {
    const result = await forwardRequest(ZAPIER_WEBHOOK_URL, 'POST', forwardHeaders, rawBody);

    // Zapier Catch Hooks return 200 on success
    if (result.status >= 200 && result.status < 300) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN || '*',
        },
        body: JSON.stringify({ success: true }),
      };
    } else {
      console.error('Zapier responded with status:', result.status, result.body);
      return { statusCode: 502, body: 'Upstream error from Zapier.' };
    }

  } catch (err) {
    console.error('Error forwarding to Zapier:', err);
    return { statusCode: 500, body: 'Internal server error.' };
  }
};
