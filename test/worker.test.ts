import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const env: Env = {
  ALLOWED_ORIGINS: "https://example.com",
  TURNSTILE_HOSTNAMES: "example.com",
  TURNSTILE_ACTION: "contact",
  TURNSTILE_SECRET_KEY: "test-secret",
  GMAIL_CLIENT_ID: "client-id",
  GMAIL_CLIENT_SECRET: "client-secret",
  GMAIL_REFRESH_TOKEN: "refresh-token",
  GMAIL_SENDER_EMAIL: "forms@example.com",
  RECIPIENT_EMAIL: "owner@example.com"
};

function request(body: Record<string, string>, origin = "https://example.com") {
  return new Request("https://worker.example/v1/contact", {
    method: "POST",
    headers: { Origin: origin, "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify(body)
  });
}

describe("contact worker", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rejects an origin outside the allow-list before reading secrets", async () => {
    const response = await worker.fetch(request({ name: "A", message: "Hi" }, "https://attacker.example"), env, {} as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
  });

  it("sends only after Turnstile succeeds", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, hostname: "example.com", action: "contact" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "gmail-message-id" })));

    const response = await worker.fetch(request({ name: "Ada", email: "ada@example.net", message: "Hello", "cf-turnstile-response": "token" }), env, {} as never);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("gmail.googleapis.com");
  });

  it("does not call Gmail when Turnstile fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false })));
    const response = await worker.fetch(request({ name: "Ada", message: "Hello", "cf-turnstile-response": "bad" }), env, {} as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "verification_failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
