---
name: verify
summary: Launch and smoke-test the local Cloudflare Worker
---

# Verify

1. Apply local D1 migrations: `./node_modules/.bin/wrangler d1 migrations apply outlook-email-db --local`.
2. Start the Worker with disposable local secrets: `./node_modules/.bin/wrangler dev --local --port 8790 --var ADMIN_PASSWORD:verify-pass --var COOKIE_SECRET:verify-cookie-secret-0123456789abcdef`.
3. Use `curl` to log in at `/api/auth/login`, retain its cookie, then exercise protected API routes. Stop the Worker and remove any local fixture accounts/cookies after the check.

There is no browser automation binary in this environment; browser-only interactions need manual verification or an available browser driver.
