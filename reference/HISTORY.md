# Audit history

Every audit is filed centrally so a client can be found months later and their
report pulled again.

## Where it lives

Supabase project **GrowthLine Digital Audit** (`vlvkqlkskvibmrlmgtdw`),
separate from the BrandAmps platform so nothing here can affect compliance data.

- `public.audits` — one row per audit run
- Storage bucket `audit-reports` — the delivered PDFs, private, PDF only

## What is stored, and why both

| | Size | Answers |
|---|---|---|
| `state` (jsonb) | ~14 KB | *Let me reopen this and fix something.* AD, all 40 check answers, the unmeasured reasons, notes, handles, hand-entered figures. |
| PDF in storage | ~300 KB | *What did we actually send them in March?* A regenerated report is built by whatever the code does today, which is not necessarily what was delivered. |

## Clients are keyed by DOMAIN

`client_domain` is normalised server-side (lowercased, no scheme, no `www`, no
path). The name typed into the form is kept but never used for grouping —
"Totus wealth Managment" and "Totus Wealth Management" are one firm, and keying
on the typed name would scatter one client's history across several.

## Security

The browser never holds a Supabase key of any kind. The app calls the audit
proxy, which is already gated by `AUDIT_KEY`; the proxy holds the service key
and talks to Supabase. RLS is **enabled with no policies**, so a publishable or
anon key can read and write nothing — if one ever leaked into the front end it
would be useless. Stored PDFs identify clients, so the bucket is private and
downloads go out on links that expire after ten minutes.

## Proxy configuration

Two environment variables on Render:

    SUPABASE_URL          https://vlvkqlkskvibmrlmgtdw.supabase.co
    SUPABASE_SERVICE_KEY  (Supabase → Settings → API Keys → Secret keys → default)

This project uses Supabase's **new** key format, so the value starts
`sb_secret_...` — it is under **Secret keys**, not the "Legacy anon,
service_role API keys" tab. Either works; the proxy detects which it was given.

That detection matters. The new secret keys are **not JWTs**, and Supabase's
docs are explicit: *"You cannot send a publishable or secret key in the
`Authorization: Bearer ...` header. Send it on the `apikey` header instead."*
Sent on both, the platform tries to parse it as a JWT and rejects the request.
So the proxy always sets `apikey`, and adds `Authorization` only when the key
really is a JWT (a legacy `service_role` key, which starts `eyJ`).

Never use the **publishable** key here. It is the browser-safe one, and since
RLS is on with no policies it can read nothing anyway.

`/health` reports `history: true` once both are set. Until then the History tab
falls back to this browser's local copy and says so — it does not pretend
nothing was saved.

## Routes

| Route | Purpose |
|---|---|
| `POST /history/save` | File an audit: state, scores, and the PDF bytes |
| `GET /history/list?q=` | Search by domain or typed name; never selects `state` |
| `GET /history/get?id=` | One audit with its state, for reopening |
| `GET /history/pdf?path=` | A ten-minute signed link to the delivered report |

## Capacity

The free tier gives 500 MB of database and 1 GB of storage: roughly 3,000
audits before storage is the binding constraint.

**Free-tier projects pause after 7 days with no activity.** A paused project
means History is unavailable until someone opens the Supabase dashboard and
resumes it — the app will show the local fallback and name the error rather
than failing silently, but the central history is genuinely gone until it is
resumed. If audits become infrequent, this is the reason to move the
organization onto a paid plan.
