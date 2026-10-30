/**
 * Webhook URLs are chosen by merchants, and the server makes requests to
 * them, so they must not reach FilsPay's own network (SSRF).
 * validateWebhookUrl only required https in production ("our SSRF
 * protection"), so https://169.254.169.254 (cloud metadata) or
 * https://10.0.0.5 passed; the transport followed redirects, so even a
 * public URL could bounce the server to an internal one. YA's comment
 * "create.ts blocks private IPs" was not true.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { validateWebhookUrl } from "./create.js";
import { createFetchTransport } from "./transport.js";

const prod = { nodeEnv: "production" as const };
const dev = { nodeEnv: "development" as const };

for (const url of [
  "https://169.254.169.254/latest/meta-data/",
  "https://10.0.0.5/hook",
  "https://172.16.4.1/hook",
  "https://192.168.1.10/hook",
  "https://127.0.0.1/hook",
  "https://localhost/hook",
  "https://[::1]/hook",
  "https://[fd00::1]/hook",
  "https://100.64.0.1/hook",
  "https://0.0.0.0/hook",
]) {
  test(`in production ${url} is refused`, () => {
    assert.throws(() => validateWebhookUrl(url, prod), (e: unknown) => (e as { code?: string }).code === "invalid_url");
  });
}

test("in production a public https URL is accepted, plain http is not", () => {
  assert.equal(validateWebhookUrl("https://hooks.example.com/filspay", prod).hostname, "hooks.example.com");
  assert.throws(() => validateWebhookUrl("http://hooks.example.com/filspay", prod));
});

test("in development a local receiver is still allowed", () => {
  assert.equal(validateWebhookUrl("http://127.0.0.1:4000/hook", dev).hostname, "127.0.0.1");
});

// ---------------------------------------------------------------- transport

let target: Server;
let redirector: Server;
let targetHits = 0;
let targetUrl = "";
let redirectUrl = "";

before(async () => {
  target = createServer((_req, res) => {
    targetHits++;
    res.end("internal secret");
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;
  redirector = createServer((_req, res) => {
    res.writeHead(302, { location: targetUrl });
    res.end();
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  redirectUrl = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/`;
});

after(() => {
  target.close();
  redirector.close();
});

const send = (transport: ReturnType<typeof createFetchTransport>, url: string) =>
  transport({ url, headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 2_000 });

test("a redirect is never followed", async () => {
  targetHits = 0;
  const res = await send(createFetchTransport({ blockPrivateNetworks: false }), redirectUrl);
  assert.equal(targetHits, 0, "the transport followed the redirect into another host");
  assert.equal(res.statusCode, 302);
});

test("in production the transport refuses to connect to a private address", async () => {
  targetHits = 0;
  const res = await send(createFetchTransport({ blockPrivateNetworks: true }), targetUrl);
  assert.equal(res.statusCode, null);
  assert.equal(targetHits, 0);
});

test("outside production a local receiver still gets the delivery", async () => {
  targetHits = 0;
  const res = await send(createFetchTransport({ blockPrivateNetworks: false }), targetUrl);
  assert.equal(res.statusCode, 200);
  assert.equal(targetHits, 1);
});
