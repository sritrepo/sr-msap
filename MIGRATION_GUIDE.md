# SR-MSAP → Manatal Direct Integration — Setup Guide

Replaces the Zapier middleware with a direct call from `submit.js` to the
Manatal API. Drop these files into your existing `sritrepo/sr-msap` repo:

```
netlify/functions/submit.js                    (replaces the current one)
netlify/functions/retry-failed-submissions.js   (new)
netlify/functions/lib/job-mapping.js            (new)
netlify/functions/lib/manatal-client.js         (new)
netlify/functions/lib/multipart.js              (new)
netlify/functions/lib/dead-letter-store.js      (new)
netlify/functions/lib/process-submission.js     (new)
```

## 1. Install dependencies

```bash
npm install busboy @netlify/blobs @netlify/functions
```

## 2. Environment variables (Netlify dashboard → Site settings → Environment)

| Variable | Required | Notes |
|---|---|---|
| `MANATAL_API_TOKEN` | Yes | Admin-only token from Manatal (Settings, or ask support@manatal.com). Used as `Authorization: Token <value>`. |
| `MANATAL_CLIENT_SLUG` | No | Defaults to `sphererocketva` if unset. |
| `ALLOWED_ORIGINS` | No | Same as before — comma-separated allowlist. |

You can drop `ZAPIER_WEBHOOK_URL` and `CHILD_KEY` once this is live.

## 3. netlify.toml — add the scheduled retry function

```toml
[functions."retry-failed-submissions"]
  schedule = "*/15 * * * *"
```

## 4. Netlify Blobs

No setup needed — it's on by default for sites deployed through Netlify's
Git integration. `dead-letter-store.js` uses the `failed-submissions`
store automatically.

## 5. Custom fields — you need to do this before rich data shows up in Manatal

The Manatal `/apply/` endpoint only accepts `full_name`, `email`,
`phone_number`, `resume`, `linkedin`, `message`. Everything else the form
collects (VA experience, training, computer type, weekly hours, etc.) is
sent as a follow-up `PATCH` to `custom_fields` — but Manatal custom
fields have to exist in your account first, and each has its own slug.

1. In Manatal: **Settings → Custom Fields** — create (or confirm you
   already have) a field for each answer you want tracked.
2. In `netlify/functions/lib/process-submission.js`, uncomment and fill
   in the `CUSTOM_FIELD_MAP` rows, matching our form field name (left)
   to your Manatal field slug (right). Anything left commented is simply
   skipped — safe to roll out incrementally.

## 6. Verify the Manatal response shape before going live

Manatal's public docs don't show the exact JSON body the `/apply/`
endpoint returns, so `manatal-client.js` guesses at `candidate.id` /
`candidate_id` / `id` and throws a clear, loud error if none of those are
present (rather than silently failing later). **Before cutting over**,
run one real request through Postman (Manatal's own recommended
workflow — see "Testing with Postman" in their docs) or a manual `curl`
against `/career-page/sphererocketva/jobs/<a-real-job-id>/apply/` and
confirm the shape. Takes 5 minutes and avoids a surprise in production.

## 7. Job mapping — current state

Per your call: only **Social Media Manager** maps 1:1 to a Manatal job
right now (`214804f9-...`). Every other selection — the other 40 named
roles plus "Other" — routes to **"50 Plus Other positions"**
(`a5476f66-...`). That's implemented in `lib/job-mapping.js` as
`DEFAULT_JOB_ID`. If/when you want more exact matches (e.g. your
"Transaction Coordinator" and "Listing Coordinator" roles both mapping
to Manatal's "Transaction & Listing Coordinator"), just add rows to
`EXPLICIT_MAP` in that file — one line each.

Also worth knowing: the LatAm and Reapplication catch-all job_ids from
the original spec (`LATAM_NETWORK`, `REAPPLICATION` in `job-mapping.js`)
aren't reachable from the current form at all — there's no region
selector or "returning applicant" toggle in `index.html` today. They're
defined as constants so wiring them up later is a one-line change once
that UI exists, but for now everything falls to the default.

## 8. Error handling / zero data loss — current state, and what's next

- Every submission that fails partway through the Manatal calls (rate
  limit, outage, a field the API rejects, etc.) gets its **original,
  untouched multipart body** saved to Netlify Blobs.
- A scheduled function retries everything in that store every 15
  minutes, using the identical processing pipeline, and removes each
  record once it succeeds.
- After 6 failed attempts (~90 minutes), a record stops being silently
  retried and gets logged as "needs a human" — but stays in Blobs rather
  than being deleted, so nothing is lost even in the worst case.
- This is intentionally a stopgap. It has no alerting (you'd have to
  check function logs or list the Blobs store manually) and no admin UI.
  Worth a follow-up conversation with the team on whether you want, e.g.,
  a Slack alert on give-up, or a small dashboard over the dead-letter
  store — happy to help design either once you've talked it through.

## 9. What did NOT change

- The multipart size caps on the client (2MB resume, 1MB gov ID, 500KB
  each for DISC/device-specs/speed-test) and the 5.5MB server-side guard
  are unchanged.
- Origin allowlisting behaves identically to before.
