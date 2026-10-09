# HTML Form to Email

A self-hosted Cloudflare Worker backend for static HTML contact forms. It verifies Cloudflare Turnstile server-side, accepts submissions only from your allowed origin, and sends a fixed-recipient email through the Gmail API.

Use it when a plain HTML, Astro, Hugo, Jekyll, or other static site needs one contact form without a hosted form SaaS or browser-side email credentials.

> This is a single-site contact-form endpoint, not a multi-tenant form platform. It does not store submissions, accept uploads, provide a dashboard, or send user-controlled recipient emails.

## What it protects

- Server-side Turnstile verification, including expected hostname and action.
- Exact CORS origin allow-list; `*` is never used.
- A fixed server-side recipient, so the endpoint cannot become an open email relay.
- Honeypot, request-size limits, field-count limits, HTML escaping, and optional Cloudflare edge rate limiting.
- Gmail OAuth client secret and refresh token remain Worker secrets; neither belongs in HTML or Git.

## Quick start

1. Install dependencies and log in to the intended Cloudflare account.

   ```sh
   npm install
   npx wrangler login
   ```

2. Copy `.dev.vars.example` to `.dev.vars`. Fill it only with local development values. Update `ALLOWED_ORIGINS` and `TURNSTILE_HOSTNAMES` in `wrangler.toml` for your own site.

3. Configure production secrets. The Gmail sender must be a Gmail address or alias authorized by the Google account represented by the refresh token.

   ```sh
   npx wrangler secret put TURNSTILE_SECRET_KEY
   npx wrangler secret put GMAIL_CLIENT_ID
   npx wrangler secret put GMAIL_CLIENT_SECRET
   npx wrangler secret put GMAIL_REFRESH_TOKEN
   npx wrangler secret put GMAIL_SENDER_EMAIL
   npx wrangler secret put RECIPIENT_EMAIL
   ```

4. Run locally, then deploy only after you have reviewed the Cloudflare account, hostname settings, and rate-limit binding.

   ```sh
   npm run dev
   npx wrangler deploy
   ```

5. Copy [`examples/contact-form.html`](./examples/contact-form.html), replace the Worker URL and Turnstile site key, and host it from an origin in `ALLOWED_ORIGINS`.

## Gmail API setup

This Worker uses the least-permissive send scope, `https://www.googleapis.com/auth/gmail.send`. It refreshes a short-lived access token at runtime and sends through Gmail's [`users.messages.send`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send) endpoint. The OAuth setup happens once on your own computer; the form visitor never signs into Google.

### 1. Create Google Cloud credentials

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Open **APIs & Services → Library**, find **Gmail API**, and enable it.
3. Open **APIs & Services → OAuth consent screen**. Configure the application for the account that will send the form notifications. For a personal or internal deployment in testing, add that Gmail address as a test user.
4. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**. Choose **Web application**.
5. Add this exact authorized redirect URI: `http://127.0.0.1:53682/oauth2/callback`.
6. Save the Client ID and Client secret somewhere private. They must never enter this repository, the browser form, or a screenshot.

For a public multi-user application, review Google's current OAuth verification requirements before requesting Gmail access. This repository is designed around one sender account you control.

### 2. Authorize the sending account once

Run the local helper below from a private terminal. It starts a loopback-only callback server, prints a Google consent URL, exchanges the returned one-time code, and prints a refresh token only to your terminal.

```sh
GMAIL_CLIENT_ID='your-client-id' \
GMAIL_CLIENT_SECRET='your-client-secret' \
node scripts/authorize-gmail.mjs
```

Open the printed URL, choose the Gmail account that should send notifications, and approve the `gmail.send` permission. After the browser confirms success, copy the refresh token from that terminal directly into the next step. If Google does not return a refresh token, remove the app's prior Google account grant and repeat the flow; the helper requests offline access and forces a new consent prompt.

### 3. Store Worker secrets

Run each command from this project. Wrangler prompts for the value, so do not paste secrets into a command line or shell history.

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
npx wrangler secret put GMAIL_SENDER_EMAIL
npx wrangler secret put RECIPIENT_EMAIL
```

`GMAIL_SENDER_EMAIL` must be the authorized mailbox or a Gmail alias that account is allowed to send from. `RECIPIENT_EMAIL` is the fixed inbox that receives submissions. The Worker uses the authenticated Gmail identity (`users/me`) for delivery, preventing a browser request from choosing an account or recipient.

### 4. Verify before production

1. Start with `npm run dev` and a non-production Turnstile test configuration.
2. Submit one message from an allowed origin.
3. Confirm the fixed recipient, authorized sender, and visitor `Reply-To` header in the delivered email.
4. Deploy only after that path works, then repeat the test with the production Turnstile widget and Worker secrets.

Do not substitute an account password, SMTP password, or browser-side OAuth flow. If Google revokes the refresh token or the sender is not authorized, delivery fails closed with a generic response. Google documents the offline refresh-token flow in its [server-side authorization guide](https://developers.google.com/workspace/gmail/api/auth/web-server).

## Request contract

`POST /v1/contact` accepts JSON or URL-encoded form data. `name`, `message`, and `cf-turnstile-response` are required. `email` is optional and becomes `Reply-To` only after basic email validation.

```json
{
  "name": "Ada Lovelace",
  "email": "ada@example.net",
  "message": "Hello",
  "cf-turnstile-response": "Turnstile token"
}
```

`website` is a hidden honeypot field. A filled honeypot receives a successful-looking `202` response and is not delivered. Responses use `Cache-Control: no-store` and never include form data, provider details, or credentials.

## Production checklist

- Use a production Turnstile widget restricted to the exact site hostnames.
- Set one or more exact HTTPS origins in `ALLOWED_ORIGINS`; do not include localhost in production.
- Add the Cloudflare Rate Limiting binding in `wrangler.toml` with a unique namespace ID.
- Store every credential using `wrangler secret put`, not `wrangler.toml`, `.dev.vars`, GitHub Actions variables, or an HTML file.
- Make one controlled submission and confirm: fixed `To`, authorized `From`, expected `Reply-To`, and exactly one delivered email.
- Add error monitoring that records event names and status codes only. Never log form fields, Turnstile tokens, access tokens, refresh tokens, or full IP addresses.

## Tests

```sh
npm run check
```

The unit tests mock Turnstile and Gmail. They verify rejected origins, failed verification, and successful delivery flow. Local mocks cannot prove production Gmail deliverability, a real Turnstile challenge, OAuth consent configuration, or Cloudflare's distributed rate limiter.

## Live implementation

[GaryBeyond's contact page](https://www.garybeyond.com/en/contact/) is the production reference for this pattern: an HTML contact form, Turnstile verification, and Gmail API notification. Its production implementation also keeps encrypted contact records for that site, so it is deliberately **not** this repository's public endpoint or deployment target.

Deploy this Worker to your own Cloudflare account and point the example form at that Worker. The sample will never send a submission to GaryBeyond.

## License

[MIT](./LICENSE)
