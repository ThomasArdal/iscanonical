# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Vite dev server for the frontend (localhost:5173)
npm run build          # Production build → dist/
npm run preview        # Preview the production build locally

npm run worker:dev     # Wrangler dev server for the Cloudflare Worker (localhost:8787)
npm run worker:deploy  # Deploy the worker to Cloudflare
```

There are no tests.

## Architecture

This is a two-part project: a static frontend and a Cloudflare Worker backend.

**Frontend** (`index.html`, `src/main.js`, `src/style.css`) — built with Vite, no framework. The frontend handles URL parsing, UI rendering, and result display entirely in vanilla JS. It calls the worker via `fetch` and renders check results as pass/fail/warn cards.

**Worker** (`worker/index.js`) — a Cloudflare Worker that does the actual network work the browser cannot (CORS, following redirects manually). It accepts `?canonical=<url>&inverted=<url>` query params, follows the redirect chain from the inverted URL, parses the canonical URL's HTML for `<link rel="canonical">` and `<meta http-equiv="refresh">`, then returns a JSON payload with all check results.

**The core flow:**
1. User enters a canonical URL (e.g. `https://example.com`)
2. `invertUrl()` in `main.js` flips the protocol (https→http) and www subdomain presence to produce the "non-canonical" variant
3. Frontend calls the worker with both URLs
4. Worker calls `followRedirects(invertedUrl)` — fetches with `redirect: 'manual'` to capture each hop in the chain
5. Worker parses the final HTML response with Cloudflare's `HTMLRewriter`
6. Frontend maps the JSON response to check cards

**Environment config:**
- `VITE_WORKER_URL` connects the frontend to the worker. Set via `.env.development` (local) or `.env.production` (deployed). Update `.env.production` with the actual worker URL after `npm run worker:deploy`.

**CORS:** The worker only accepts requests from `https://iscanonical.com`, `https://www.iscanonical.com`, and `localhost:*`. It also blocks SSRF via `isSafeUrl()` (rejects private/loopback IP ranges).
