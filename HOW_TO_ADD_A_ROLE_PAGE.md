# How to Add a New Direct-Role Application Page

This project is now driven by **one file** (`index.html`). Role-specific pages
like `/web-developer` are not separate files — they're the same `index.html`,
told which role to pre-select via a URL rewrite. Two working examples are
already set up: `/web-developer` and `/social-media-manager`.

To add another role (e.g. `/content-writer`), do these **two steps**:

---

## Step 1 — netlify.toml

Open `netlify.toml`. Find the block of `[[redirects]]` under
`ROLE-SPECIFIC APPLICATION PAGES`. Copy one of the existing role blocks and
change the slug in both places:

```toml
# /content-writer — direct-role landing, Content Writer pre-selected
[[redirects]]
  from   = "/content-writer"
  to     = "/index.html?role=content-writer"
  status = 200
```

- `from` = the clean URL you want people to visit.
- `to` = always `/index.html?role=` + the same slug.
- `status = 200` must stay `200` — this makes it a rewrite (URL bar keeps
  showing the clean slug), not a 301/302 redirect that would expose the
  `?role=` query string to the visitor.

## Step 2 — index.html

Open `index.html`, search for `SLUG_ROLE_MAP` (it's near the bottom, right
above the `INIT` section). Add one line:

```js
const SLUG_ROLE_MAP = {
  'web-developer':        'Web Developer',
  'social-media-manager': 'Social Media Manager',
  'content-writer':       'Content Writer',   // ← new
};
```

**The value must match a `name` in the `POSITIONS` array exactly** — same
capitalization, spacing, everything. Safest way: open the `POSITIONS` array
(search for `const POSITIONS`), find the role, and copy its `name:'...'`
value directly rather than retyping it. If it doesn't match exactly, that
slug will silently fall back to the general application flow (a console
warning will fire in the browser dev tools so you can catch typos).

### Optional — Step 3: custom tab title

If you want the browser tab / share title to say something specific for
that role, add a matching entry to `SLUG_META` right below `SLUG_ROLE_MAP`:

```js
const SLUG_META = {
  'web-developer':        { title: 'Apply — Web Developer | Sphere Rocket VA',        description: '...' },
  'social-media-manager': { title: 'Apply — Social Media Manager | Sphere Rocket VA', description: '...' },
  'content-writer':       { title: 'Apply — Content Writer | Sphere Rocket VA',       description: 'Apply now for the Content Writer role at Sphere Rocket VA.' }, // ← new
};
```

If you skip this, the page still works fine — it just keeps the default
"General Application — Sphere Rocket VA" tab title.

---

## What happens on a direct-role page

Visiting `/content-writer`:
1. Netlify rewrites it internally to `index.html?role=content-writer` (URL bar still shows `/content-writer`).
2. `index.html` reads `?role=`, looks up `content-writer` in `SLUG_ROLE_MAP`, finds `"Content Writer"`.
3. The **IC/BPO contract-type step (Screen 1) is skipped entirely.**
4. `contract_type` is sent to Zapier as `"Both (IC & BPO)"` — fixed default for all direct-role landings, per your instruction.
5. The visitor lands directly on the position screen with **Content Writer already selected** and its **full job description expanded** below.
6. The "Back" button on that screen is hidden (there's no Screen 1 to go back to). They can still use "Change Role" if they want to pick something else from the full list.
7. Everything downstream — the 4-step form, file uploads, Terms modal, Zapier submission — is completely unchanged.

## What did NOT change

- The general application flow at `/` and `/general-application` is untouched — IC/BPO step still shows, no pre-selection.
- Zapier webhook, field names, ATS mapping — all identical, same endpoint.
- The Webflow iframe embed script, resize logic, and Terms & Conditions modal — untouched.

## Testing a new slug before going live

Locally or on a Netlify deploy preview, visit:
```
https://your-site.netlify.app/index.html?role=content-writer
```
This simulates the rewrite directly (bypasses `netlify.toml`) so you can
check the pre-selection works before you even touch the redirects file. Once
confirmed, add the redirect and test the clean URL.
