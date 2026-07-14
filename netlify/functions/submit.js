// netlify/functions/submit.js
//
// Secure proxy — receives multipart/form-data (text fields + file uploads)
// from the application form, then forwards everything directly to Zapier
// as a multipart POST. No third-party file hosting needed.
//
// Required environment variables (set in Netlify dashboard):
//   ZAPIER_WEBHOOK_URL   — your Zapier catch hook URL
//   CHILD_KEY            — secret key checked by Zapier Filter step
//   ALLOWED_ORIGINS      — comma-separated allowed origins (optional)
//                          e.g. https://jovial-trifle-9a780d.netlify.app

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── Forward raw multipart body straight to Zapier ────────────────────────────
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

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {

  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── Secrets from Netlify env vars (never exposed to browser) ───────────────
  const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
  const CHILD_KEY          = process.env.CHILD_KEY || '';

  if (!ZAPIER_WEBHOOK_URL) {
    console.error('ZAPIER_WEBHOOK_URL is not set in environment variables.');
    return { statusCode: 500, body: 'Server configuration error: missing webhook URL.' };
  }

  // ── CORS / origin guard ────────────────────────────────────────────────────
  // When embedded in Webflow via iframe, the origin is the Netlify URL
  // (not the Webflow URL), so only whitelist your Netlify/custom domain here.
  // Leave ALLOWED_ORIGINS empty during testing to allow all origins.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  const origin  = (event.headers['origin']  || '').trim();
  const referer = (event.headers['referer'] || '').trim();

  if (allowedOrigins.length > 0) {
    const isAllowed = allowedOrigins.some(
      o => origin.startsWith(o) || referer.startsWith(o)
    );
    if (!isAllowed) {
      console.warn(`Blocked — origin: "${origin}" referer: "${referer}"`);
      return { statusCode: 403, body: 'Forbidden: origin not allowed.' };
    }
  }

  const responseOrigin =
    allowedOrigins.find(o => origin.startsWith(o)) ||
    allowedOrigins[0] ||
    '*';

  // ── Decode body ────────────────────────────────────────────────────────────
  // Netlify base64-encodes binary bodies (multipart with file uploads).
  // Decode it back to raw bytes so Zapier can parse the files correctly.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body || '', 'utf8');

  // ── Validate content-type ──────────────────────────────────────────────────
  const contentType = event.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return { statusCode: 400, body: 'Expected multipart/form-data.' };
  }

  // ── Forward to Zapier ──────────────────────────────────────────────────────
  // We forward the exact multipart body Netlify received, preserving
  // the boundary and all file data. Zapier's Catch Hook natively parses
  // multipart payloads and exposes each field (including files) in the Zap.
  const forwardHeaders = {
    'Content-Type':   contentType,          // must keep boundary intact
    'Content-Length': rawBody.length,
    'X-Child-Key':    CHILD_KEY,            // Zapier Filter step checks this
    'X-Source':       'sphere-rocket-va-form',
    'User-Agent':     'SphereRocketVA-Proxy/1.0',
  };

  try {
    const result = await forwardToZapier(ZAPIER_WEBHOOK_URL, forwardHeaders, rawBody);

    if (result.status >= 200 && result.status < 300) {
      console.log('Zapier accepted submission:', result.status);
      return {
        statusCode: 200,
        headers: {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': responseOrigin,
        },
        body: JSON.stringify({ success: true }),
      };
    } else {
      console.error('Zapier returned error:', result.status, result.body);
      return {
        statusCode: 502,
        body: `Upstream error from Zapier: ${result.status}`,
      };
    }

  } catch (err) {
    console.error('Failed to reach Zapier:', err.message);
    return { statusCode: 500, body: 'Internal server error: could not reach webhook.' };
  }
};
