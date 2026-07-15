// netlify/functions/submit.js
//
// Secure proxy — receives JSON text fields from the application form
// and forwards them to Zapier. File uploads are sent directly from the
// browser to Zapier (avoiding Netlify's 6MB function body size limit).
//
// Required environment variables (set in Netlify dashboard):
//   ZAPIER_WEBHOOK_URL   — your Zapier catch hook URL
//   CHILD_KEY            — secret key checked by Zapier Filter step
//   ALLOWED_ORIGINS      — comma-separated allowed origins (optional)

const https = require('https');
const http  = require('http');
const { URL } = require('url');

function postJSON(webhookUrl, payload, childKey) {
  return new Promise((resolve, reject) => {
    const body   = Buffer.from(JSON.stringify(payload), 'utf8');
    const parsed = new URL(webhookUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': body.length,
        'X-Child-Key':    childKey || '',
        'X-Source':       'sphere-rocket-va-form',
        'User-Agent':     'SphereRocketVA-Proxy/1.0',
      },
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

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  // Secrets — never exposed to browser
  const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
  const CHILD_KEY          = process.env.CHILD_KEY || '';

  if (!ZAPIER_WEBHOOK_URL) {
    console.error('ZAPIER_WEBHOOK_URL is not set.');
    return { statusCode: 500, body: 'Server configuration error: missing webhook URL.' };
  }

  // Origin guard (optional — leave ALLOWED_ORIGINS empty to allow all)
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

  // Parse JSON body
  let payload;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body || '');
    payload = JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse request body:', e.message);
    return { statusCode: 400, body: 'Invalid JSON body.' };
  }

  // Inject child key into payload as extra verification field
  payload._child_key = CHILD_KEY;
  payload._source    = 'sphere-rocket-va-form';

  // Forward to Zapier
  try {
    const result = await postJSON(ZAPIER_WEBHOOK_URL, payload, CHILD_KEY);

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
      console.error('Zapier error:', result.status, result.body);
      return { statusCode: 502, body: `Zapier error: ${result.status}` };
    }

  } catch (err) {
    console.error('Failed to reach Zapier:', err.message);
    return { statusCode: 500, body: 'Could not reach webhook.' };
  }
};
