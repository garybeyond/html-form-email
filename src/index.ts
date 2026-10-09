export interface Env {
  ALLOWED_ORIGINS: string;
  TURNSTILE_HOSTNAMES: string;
  TURNSTILE_ACTION?: string;
  TURNSTILE_SECRET_KEY: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_SENDER_EMAIL: string;
  RECIPIENT_EMAIL: string;
  CONTACT_RATE_LIMITER?: RateLimitBinding;
}

type FormFields = Record<string, string>;

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const MAX_BODY_BYTES = 16_384;
const MAX_FIELDS = 20;
const MAX_VALUE_LENGTH = 2_000;

function csv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function json(body: unknown, status = 200, origin?: string): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  if (origin) headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(JSON.stringify(body), { status, headers });
}

function isAllowedOrigin(origin: string | null, env: Env): origin is string {
  return origin !== null && csv(env.ALLOWED_ORIGINS).includes(origin);
}

function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char] ?? char);
}

function escapeHeader(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim();
}

async function readFields(request: Request): Promise<FormFields> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("application/x-www-form-urlencoded")) {
    throw new Error("unsupported-content-type");
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new Error("body-too-large");

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) throw new Error("body-too-large");

  let raw: unknown;
  if (contentType.includes("application/json")) {
    try {
      raw = JSON.parse(rawBody);
    } catch {
      throw new Error("invalid-body");
    }
  } else {
    const form = new URLSearchParams(rawBody);
    const entries: Record<string, string> = {};
    form.forEach((value, key) => { entries[key] = value; });
    raw = entries;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid-body");

  const fields: FormFields = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(fields).length >= MAX_FIELDS) throw new Error("too-many-fields");
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || typeof value !== "string") {
      throw new Error("invalid-field");
    }
    if (value.length > MAX_VALUE_LENGTH) throw new Error("field-too-large");
    fields[key] = value.trim();
  }
  return fields;
}

async function verifyTurnstile(token: string | undefined, request: Request, env: Env): Promise<boolean> {
  if (!token) return false;
  const data = new FormData();
  data.set("secret", env.TURNSTILE_SECRET_KEY);
  data.set("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) data.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: data });
  if (!response.ok) return false;
  const result = await response.json() as { success?: boolean; hostname?: string; action?: string };
  return result.success === true
    && csv(env.TURNSTILE_HOSTNAMES).includes(result.hostname ?? "")
    && (!env.TURNSTILE_ACTION || result.action === env.TURNSTILE_ACTION);
}

function emailSource(fields: FormFields, env: Env): string {
  const replyTo = fields.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email) ? fields.email : undefined;
  const rows = Object.entries(fields)
    .filter(([key]) => !["cf-turnstile-response", "website"].includes(key))
    .map(([key, value]) => `<tr><th align="left">${escapeHtml(key)}</th><td>${escapeHtml(value).replace(/\n/g, "<br>")}</td></tr>`)
    .join("");
  const plain = Object.entries(fields)
    .filter(([key]) => !["cf-turnstile-response", "website"].includes(key))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const lines = [
    `From: ${escapeHeader(env.GMAIL_SENDER_EMAIL)}`,
    `To: ${escapeHeader(env.RECIPIENT_EMAIL)}`,
    replyTo ? `Reply-To: ${escapeHeader(replyTo)}` : "",
    "Subject: New website contact form submission",
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=boundary123",
    "",
    "--boundary123",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    plain,
    "--boundary123",
    "Content-Type: text/html; charset=UTF-8",
    "",
    `<table>${rows}</table>`,
    "--boundary123--"
  ].filter(Boolean);
  return lines.join("\r\n");
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sendGmail(fields: FormFields, env: Env): Promise<void> {
  const tokens = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  if (!tokens.ok) throw new Error("gmail-token-failed");
  const { access_token } = await tokens.json() as { access_token?: string };
  if (!access_token) throw new Error("gmail-token-missing");

  const delivery = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: base64Url(emailSource(fields, env)) })
  });
  if (!delivery.ok) throw new Error("gmail-delivery-failed");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin, env)) return json({ error: "origin_not_allowed" }, 403);
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "vary": "Origin" } });
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/health") return json({ ok: true });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/contact") return json({ error: "not_found" }, 404, isAllowedOrigin(origin, env) ? origin : undefined);
    if (!isAllowedOrigin(origin, env)) return json({ error: "origin_not_allowed" }, 403);

    const limit = env.CONTACT_RATE_LIMITER && await env.CONTACT_RATE_LIMITER.limit({ key: clientKey(request) });
    if (limit && !limit.success) return json({ error: "rate_limited" }, 429, origin);

    try {
      const fields = await readFields(request);
      if (fields.website) return json({ ok: true }, 202, origin);
      if (!fields.name || !fields.message) return json({ error: "missing_required_fields" }, 400, origin);
      if (!(await verifyTurnstile(fields["cf-turnstile-response"], request, env))) return json({ error: "verification_failed" }, 400, origin);
      await sendGmail(fields, env);
      return json({ ok: true }, 202, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "request-failed";
      const clientErrors = new Set(["unsupported-content-type", "body-too-large", "invalid-body", "too-many-fields", "invalid-field", "field-too-large"]);
      return json({ error: clientErrors.has(message) ? "invalid_request" : "delivery_failed" }, clientErrors.has(message) ? 400 : 502, origin);
    }
  }
};
