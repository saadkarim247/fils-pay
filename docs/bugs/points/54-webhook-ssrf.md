# 54 · Webhooks can be pointed at FilsPay's own network (SSRF)

**Severity:** High (reach internal services and cloud metadata) · **Area:** `apps/api/src/webhooks/create.ts`, `transport.ts`

**What's wrong.** A merchant chooses the URL FilsPay's server POSTs webhooks
to. Nothing stopped that URL being `https://169.254.169.254/…` (cloud
metadata), `https://10.0.0.5/…`, `localhost`, or a public URL that redirects
to one of those. The server then makes the request from inside our network.

**Why it's wrong.**
- **No address check.** URL validation only required `https` in
  production. The comment "https-only in prod is our SSRF protection" is
  false: https says nothing about *where* the request goes.
- **False reassurance.** The transport's comment "create.ts blocks private
  IPs, SSRF is handled upstream" describes code that doesn't exist.
- **Redirects followed.** `fetch` follows 3xx by default (FH's comment says
  so), so even a checked public URL can bounce the request inward.

**Spread / what it breaks.** Any merchant account (or a stolen merchant
login) can make the API probe internal hosts and ports, and read delivery
status/response bodies back in the dashboard. On a cloud host that can mean
instance credentials.

**Fix.**
- New `webhooks/networkPolicy.ts`: one list of blocked ranges (loopback,
  RFC 1918, link-local, CGNAT, `0.0.0.0/8`, multicast/reserved, IPv6
  `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped forms).
- **Save time (production):** `validateWebhookUrl` refuses `localhost` and
  blocked IP literals (`invalid_url`).
- **Send time (production):** the transport resolves the hostname and
  refuses if any address is blocked, so a public name later re-pointed
  inward is still caught. Fails as `blocked_private_address`.
- **Always:** `redirect: "manual"`. A 3xx is a failed delivery, never
  followed.
- Development stays permissive so the local receiver on `127.0.0.1` works.

**Tests.** New file `apps/api/src/webhooks/ssrf.test.ts`:
- Production refuses metadata, 10/172.16/192.168, loopback, `localhost`,
  `[::1]`, `[fd00::1]`, 100.64 and 0.0.0.0; accepts a public https host.
- Development still accepts `http://127.0.0.1`.
- A 302 is not followed (the redirect target gets 0 requests).
- With blocking on, a send to 127.0.0.1 never connects; with it off, it
  does.

Before the fix 12 of 15 failed. After it, all pass, along with the existing
webhook tests. Full suite (fresh database): no new failures.
