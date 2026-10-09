import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
const redirectUri = "http://127.0.0.1:53682/oauth2/callback";

if (!clientId || !clientSecret) {
  throw new Error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET before running this script.");
}

const state = randomBytes(24).toString("hex");
const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorizationUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "https://www.googleapis.com/auth/gmail.send",
  access_type: "offline",
  prompt: "consent",
  state
}).toString();

const server = createServer(async (request, response) => {
  const callback = new URL(request.url ?? "/", redirectUri);
  if (callback.pathname !== "/oauth2/callback" || callback.searchParams.get("state") !== state) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid OAuth callback.");
    return;
  }
  const code = callback.searchParams.get("code");
  if (!code) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Google did not return an authorization code.");
    return;
  }
  try {
    const tokens = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri })
    });
    const result = await tokens.json();
    if (!tokens.ok || !result.refresh_token) throw new Error("Google did not return a refresh token. Revoke this app grant, then retry with prompt=consent.");
    console.log("\nCopy this value directly into `wrangler secret put GMAIL_REFRESH_TOKEN`:");
    console.log(result.refresh_token);
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Authorization complete. Return to your terminal, copy the refresh token into a Cloudflare Worker secret, then close this tab.");
    server.close();
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Authorization failed. Check the terminal for a safe diagnostic.");
    console.error(error instanceof Error ? error.message : "OAuth exchange failed");
  }
});

server.listen(53682, "127.0.0.1", () => {
  console.log("Open this URL in a browser and approve access for the sending Gmail account:");
  console.log(authorizationUrl.toString());
});
