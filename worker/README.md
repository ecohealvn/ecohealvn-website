# ECOHEAL Cloudflare Worker

This directory replaces the production Quick Editor script with a version-controlled Worker.

## Production resources

- Worker: `ecoheal-cart-api`
- Current production backup: deployment `1c6ee150-de70-4a8f-a159-d6c6ab0bc8e0` (version 33)
- KV binding `CART`: `ecoheal-cart`
- KV binding `PROFILE`: `ecoheal-profile`

## Safety changes

- Product names and prices come from a server-side catalog.
- Orders are acknowledged only after the Google Apps Script endpoint returns a successful HTTP response.
- Repeated submissions reuse one order ID, so a retry does not create a second order.
- Passwords are stored as PBKDF2-SHA256 hashes; successful legacy logins migrate plaintext records.
- Existing profiles require a short-lived bearer session before updates.
- Login attempts are rate limited.
- The unauthenticated profile-lock endpoint is removed.
- CORS is restricted to the production site, Pages previews, and local development.

## Local validation

```powershell
node --check worker/src/index.js
npm.cmd test --prefix worker
npx.cmd --yes wrangler@latest deploy --dry-run --config worker/wrangler.jsonc
```

Do not deploy directly over production until the frontend integration and preview checks pass.
