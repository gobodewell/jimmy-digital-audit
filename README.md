# SEMrush Proxy Server (optional)

Only needed if you want SEMrush data (DA, keywords, traffic) to auto-fill.
Skip this if you're ok entering those 3 numbers manually.

## Deploy on Railway (free)

1. Push this proxy/ folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Set environment variable: SEMRUSH_KEY = your SEMrush API key
4. Copy the deployed URL (e.g. https://your-proxy.railway.app)
5. In the audit app Settings, add your proxy URL in the SEMrush field

## Deploy on Render (free)

1. Push proxy/ folder to GitHub
2. render.com → New Web Service → connect repo
3. Build: npm install  |  Start: node server.js
4. Add env var: SEMRUSH_KEY
5. Use the Render URL in the audit app Settings
