# GrowthLine Digital Audit

AI-powered digital audit tool for financial advisory firms.

- `index.html` — the audit app (static page). All backend calls go through the
  proxy below; no API keys live in the browser anymore.
- `server.js` + `package.json` — the proxy (Node/Express). It owns every secret
  and handles DataForSEO (domain metrics, Lighthouse, GBP), a sitemap check,
  SocialFetch, the Anthropic AI reviews, and the Airtable push.
- `render.yaml` — one-click Render Blueprint for the proxy.

## Architecture

The browser only stores the **proxy URL** and a **proxy access key**. Every
sensitive key (Anthropic, Airtable, DataForSEO, SocialFetch, Google) lives on
the proxy as a Render environment variable. The proxy is gated by a shared
secret (`AUDIT_KEY`): if it's set, requests must send a matching `X-Audit-Key`
header — which the app does automatically once you enter the key in Settings.

## Deploy the proxy (Render)

1. Render → **New → Blueprint** → connect this repo (it reads `render.yaml`).
2. Set the environment variables in the dashboard:

   | Variable | What it's for | Required? |
   |---|---|---|
   | `AUDIT_KEY` | Shared secret that locks the proxy. Pick any random string. | Recommended |
   | `ANTHROPIC_KEY` | AI reviews (`sk-ant-...`) | Yes |
   | `AIRTABLE_TOKEN` | Airtable push (`pat...`) | For Airtable push |
   | `DATAFORSEO_LOGIN` | DataForSEO account email | Yes |
   | `DATAFORSEO_PASSWORD` | DataForSEO API password | Yes |
   | `SOCIALFETCH_KEY` | Follower counts | Optional |
   | `GOOGLE_API_KEY` | PageSpeed (higher rate limit) | Optional |

3. Deploy. The service is named `jimmy-digital-audit`, so its URL is
   `https://jimmy-digital-audit.onrender.com` — the app's default.
4. Check `…onrender.com/health` → `{"ok":true,"ai":true,"at":true,"locked":true,...}`.

## Serve the app (front-end)

Host `index.html` anywhere static (Netlify drag-and-drop, a Render static site,
or open locally). Then in the app's **Settings** enter only:

- **Proxy server URL** (defaults to the Render URL above)
- **Proxy access key** — must equal the `AUDIT_KEY` you set on Render
- **Airtable Base ID + table name** (not secret)

That's it — no API keys in the browser.

## Notes

- Settings are stored in your browser's localStorage.
- DataForSEO and Anthropic bill per request; the `AUDIT_KEY` gate keeps the
  proxy private. Leave `AUDIT_KEY` unset only for quick local testing.
