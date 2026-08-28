// netlify/functions/lib/blobs-config.js
//
// CONFIRMED (Aug 2026): plain getStore('some-name') was throwing
// MissingBlobsEnvironmentError in production, on every function that
// touches Blobs (dead-letter-store.js, file-hosting.js, get-attachment.js)
// — despite Blobs supposedly auto-configuring inside any Netlify Function
// with zero setup. This is a known, documented gap: per Netlify's own
// docs and multiple real-world reports, auto-injection doesn't always
// reach the function's environment, and the supported workaround is to
// pass `siteID` and `token` explicitly.
//
// - siteID: auto-populated by Netlify as the NETLIFY_SITE_ID env var in
//   every function's environment — nothing to configure.
// - token: NOT auto-injected in this deploy for whatever reason. You
//   need a Netlify Personal Access Token:
//     Netlify dashboard → User settings → Applications → New access token
//   then add it as an environment variable named NETLIFY_BLOBS_TOKEN
//   (Site configuration → Environment variables).
//
// All three files that call getStore() should import getConfiguredStore
// from here instead of calling @netlify/blobs's getStore directly, so
// there's one place to fix if Netlify's auto-injection starts working
// again later (at which point this can go back to a plain getStore(name)).

const { getStore } = require('@netlify/blobs');

// CORRECTED (Aug 27): the auto-injected variable is `SITE_ID`, not
// `NETLIFY_SITE_ID` — confirmed directly against Netlify's own docs
// (docs.netlify.com/build/functions/environment-variables), which list
// only URL, SITE_NAME, and SITE_ID as available to functions at runtime.
// The original NETLIFY_SITE_ID reference was wrong and silently always
// fell through to the broken fallback branch below, even with
// NETLIFY_BLOBS_TOKEN correctly set — confirmed via a real production
// stack trace pointing at the fallback getStore(name) call.
function getConfiguredStore(name) {
  const siteID = process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;

  if (siteID && token) {
    return getStore({ name, siteID, token });
  }

  // Fall back to auto-detection in case it starts working (e.g. local
  // `netlify dev`, or Netlify fixes the underlying injection gap) —
  // if NETLIFY_BLOBS_TOKEN isn't set, this will throw the same
  // MissingBlobsEnvironmentError as before, with a clearer cause.
  if (!token) {
    console.warn(
      `getConfiguredStore("${name}"): NETLIFY_BLOBS_TOKEN is not set — falling back to auto-detection, which is what was failing before. Set NETLIFY_BLOBS_TOKEN in your Netlify environment variables.`
    );
  }
  return getStore(name);
}

module.exports = { getConfiguredStore };
